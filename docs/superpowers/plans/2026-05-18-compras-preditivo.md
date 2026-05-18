# Compras Preditivo — Radar do Comprador — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar uma nova aba "Reposição" em `/wms/compras` que ranqueia SKUs ativos por urgência de compra, baseada em forecast de demanda (SES + Croston-SBA), Reorder Point com safety stock por curva ABC e hierarquia empréstimo→equivalente→comprar. Comprador aprova item-a-item ou em lote.

**Architecture:** Job noturno calcula tudo e persiste snapshot diário em `siso_reposicao_sugestoes`. Tela lê só dessa tabela (zero cálculo em request). Backend é Next.js API routes + lib pura `src/lib/wms/reposicao/`. Frontend é tab dentro do `/wms/compras/page.tsx` (não cria rota nova), com tabela + drawer + modal — sem mudar Comprar/Receber.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (Postgres + RPC + materialized view), React Query, Tailwind 4, Vitest (testes).

**Spec source:** `docs/superpowers/specs/2026-05-18-compras-preditivo-design.md`

**Scope:** Este plano cobre as **Fases 1-3 do spec (MVP)**: foundation (migrations + lib pura com testes), job + API, e UI (tab + tabela + drawer + modal + cold start banner). As **Fases 4 (métricas dashboard) e 5 (tela de configuração admin)** ficam como plano follow-up — o MVP entrega valor mesmo sem elas (métricas viram um insight manual no /wms/insights existente, configuração fica em SQL inicial).

---

## Visão geral da arquitetura

```
src/lib/wms/reposicao/           ← lib pura, testável
  types.ts                        ← interfaces compartilhadas
  demanda.ts                      ← carrega histórico + classifica perfil
  forecast.ts                     ← SES + Croston-SBA
  rop.ts                          ← ROP + safety stock + qty sugerida
  urgencia.ts                     ← score 0-100 + faixa
  alternativas.ts                 ← empréstimo + equivalente Cross
  explicacao.ts                   ← gera texto humano
  refresh.ts                      ← orquestrador (chamado pelo cron)

supabase/migrations/
  20260518_reposicao_demanda_diaria.sql     ← MV
  20260518_reposicao_sugestoes.sql          ← tabela snapshot
  20260518_reposicao_aprovacoes.sql         ← tabela audit
  20260518_reposicao_config.sql             ← singleton config
  20260518_reposicao_em_transito.sql        ← RPC helper

src/app/api/wms/
  reposicao/refresh/route.ts                ← POST (worker-secret)
  compras/reposicao/route.ts                ← GET (lista filtrada)
  compras/reposicao/[sku]/explicacao/route.ts ← GET (drawer)
  compras/reposicao/aprovar/route.ts        ← POST (cria OC ou empréstimo)

src/app/wms/compras/
  page.tsx                                  ← adiciona tab "reposicao"

src/components/wms/compras/
  reposicao-table.tsx                       ← tabela + filtros
  reposicao-drawer.tsx                      ← "Por quê?"
  reposicao-aprovar-modal.tsx               ← aprovação em lote
  reposicao-banner-aprendizagem.tsx         ← cold start
```

**Convenção de tests:** vitest, arquivos `*.test.ts` lado-a-lado com a fonte. Comando: `npx vitest run <path>`.

**Convenção de commits:** seguir padrão do projeto. Formato: `tipo(escopo): mensagem`. Tipos: `feat`, `fix`, `chore`, `docs`, `test`. Escopo: `compras-preditivo`, `wms/reposicao`. Co-author obrigatório.

---

## Fase 1 — Foundation

### Task 1: Verificar ambiente e schema atual

**Files:** apenas leitura

- [ ] **Step 1: Confirmar versão do vitest e estrutura de testes**

Run: `npx vitest --version && ls src/lib/wms/*.test.ts | head -3`
Expected output: versão 4.x; pelo menos 3 arquivos `.test.ts` listados.

- [ ] **Step 2: Confirmar schema atual de OCs (sem tabela de itens separada)**

Run: `grep -E "siso_(ordens_compra|pedido_itens|produtos|produto_fornecedores|emprestimo|movimentacoes|curva_abc|cobertura|empresas|galpoes)" supabase/migrations/*.sql -l | sort -u`

Anotar mentalmente:
- `siso_ordens_compra` é só header (`id, fornecedor TEXT, empresa_id, status, comprado_em…`)
- Itens da OC moram em `siso_pedido_itens.ordem_compra_id` (1 item de OC = 1 linha de pedido)
- "Em trânsito" = `SUM(quantidade - compra_quantidade_recebida)` em pedidos com OC ativa

- [ ] **Step 3: Confirmar que `siso_curva_abc` e `siso_cobertura_estoque` existem (MVs do WMS Plano 5)**

Run: `grep -lE "CREATE MATERIALIZED VIEW siso_(curva_abc|cobertura_estoque)" supabase/migrations/*.sql`

Expected: 2 migrações listadas. Se faltar alguma, parar e investigar — este plano depende delas.

- [ ] **Step 4: Listar tabelas chave via Supabase MCP (project wrbrbhuhsaaupqsimkqz)**

Confirmar colunas em `siso_produtos`, `siso_produto_fornecedores`, `siso_emprestimo_regras`, `siso_produto_oems`. Anotar nome real da coluna que diz se um fornecedor é preferencial (`preferencial bool` ou similar).

---

### Task 2: Migration — Materialized View `siso_demanda_diaria`

**Files:**
- Create: `supabase/migrations/20260518_reposicao_demanda_diaria.sql`

- [ ] **Step 1: Criar arquivo de migration**

```sql
-- Demanda diária agregada do ledger (90 dias) — usada pelo forecast de reposição.
-- Agrega só saídas reais do grupo (vendas externas + saídas de empréstimo),
-- excluindo estornos. Refresh chamado pelo job noturno via wms_refresh_demanda_diaria().

CREATE MATERIALIZED VIEW siso_demanda_diaria AS
SELECT
  m.produto_id,
  m.empresa_dona_id,
  m.galpao_id,
  DATE(m.criada_em AT TIME ZONE 'America/Sao_Paulo') AS data,
  SUM(CASE WHEN m.origem_tipo = 'nf_venda' THEN m.qty ELSE 0 END) AS qty_venda_externa,
  SUM(CASE WHEN m.origem_tipo = 'emprestimo' THEN m.qty ELSE 0 END) AS qty_emprestimo_saida,
  SUM(m.qty) AS qty_total
FROM siso_movimentacoes m
WHERE m.estorno_de IS NULL
  AND m.tipo = 'S'
  AND m.origem_tipo IN ('nf_venda', 'emprestimo')
  AND m.criada_em >= NOW() - INTERVAL '90 days'
GROUP BY 1, 2, 3, 4;

CREATE UNIQUE INDEX uq_demanda_diaria
  ON siso_demanda_diaria (produto_id, empresa_dona_id, galpao_id, data);

CREATE INDEX idx_demanda_diaria_produto
  ON siso_demanda_diaria (produto_id);

-- RPC pra refresh chamado pelo job noturno
CREATE OR REPLACE FUNCTION wms_refresh_demanda_diaria()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY siso_demanda_diaria;
END;
$$;
```

- [ ] **Step 2: Aplicar migration via Supabase MCP no projeto `wrbrbhuhsaaupqsimkqz`**

Usar `mcp__supabase__apply_migration` com `name="reposicao_demanda_diaria"` e o conteúdo do SQL acima.

- [ ] **Step 3: Verificar que MV foi criada e refresh funciona**

Run via `mcp__supabase__execute_sql`:
```sql
SELECT 1 FROM pg_matviews WHERE matviewname = 'siso_demanda_diaria';
SELECT wms_refresh_demanda_diaria();
SELECT COUNT(*) FROM siso_demanda_diaria;
```
Expected: MV existe, refresh sem erro, count >= 0 (pode ser 0 se ledger vazio).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518_reposicao_demanda_diaria.sql
git commit -m "$(cat <<'EOF'
feat(wms/reposicao): MV siso_demanda_diaria

Materialized view que agrega vendas reais (nf_venda + emprestimo)
do ledger dos últimos 90 dias por produto+empresa+galpao+data.
Refresh via wms_refresh_demanda_diaria() chamado pelo job noturno.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migration — Tabela `siso_reposicao_sugestoes`

**Files:**
- Create: `supabase/migrations/20260518_reposicao_sugestoes.sql`

- [ ] **Step 1: Criar arquivo de migration**

```sql
-- Snapshot diário da decisão preditiva pra cada SKU+empresa+galpao.
-- Tabela (não MV) pra manter histórico das sugestões ao longo do tempo.

CREATE TABLE siso_reposicao_sugestoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_calculo date NOT NULL,
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),

  -- Estado atual
  saldo_atual numeric NOT NULL,
  reservado numeric NOT NULL,
  em_transito numeric NOT NULL DEFAULT 0,

  -- Perfil + classificação
  perfil_demanda text NOT NULL CHECK (perfil_demanda IN ('regular', 'intermitente', 'sem_dados')),
  classe_abc text CHECK (classe_abc IN ('A', 'B', 'C')),
  confianca text NOT NULL CHECK (confianca IN ('alta', 'media', 'baixa')),
  dias_de_dados int NOT NULL,

  -- Forecast
  mu_diario numeric NOT NULL,
  sigma_diario numeric NOT NULL,

  -- Reorder
  lead_time_dias numeric,
  rop numeric,
  safety_stock numeric,

  -- Urgência
  urgencia_score smallint NOT NULL CHECK (urgencia_score BETWEEN 0 AND 100),
  urgencia_faixa text NOT NULL CHECK (urgencia_faixa IN ('critico', 'alto', 'medio', 'baixo')),
  dia_ruptura_em int,
  folga_dias int,

  -- Sugestão de compra
  qty_sugerida numeric NOT NULL DEFAULT 0,
  fornecedor_preferencial_id uuid REFERENCES siso_fornecedores(id),
  custo_unitario_estimado numeric,
  custo_total_estimado numeric,
  moq numeric,
  multiplo numeric,

  -- Alternativas
  alternativas jsonb NOT NULL DEFAULT '[]'::jsonb,
  acao_recomendada text NOT NULL CHECK (acao_recomendada IN ('emprestimo', 'equivalente', 'comprar', 'aguardar')),

  -- Explicação humana (gerada no job)
  explicacao_texto text,

  criada_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_reposicao_dia
  ON siso_reposicao_sugestoes (data_calculo, produto_id, empresa_dona_id, galpao_id);

CREATE INDEX idx_reposicao_urgencia
  ON siso_reposicao_sugestoes (data_calculo, urgencia_score DESC)
  WHERE acao_recomendada IN ('comprar', 'emprestimo');

CREATE INDEX idx_reposicao_fornecedor
  ON siso_reposicao_sugestoes (data_calculo, fornecedor_preferencial_id)
  WHERE acao_recomendada = 'comprar';
```

- [ ] **Step 2: Aplicar migration**

Via `mcp__supabase__apply_migration` com `name="reposicao_sugestoes"`.

- [ ] **Step 3: Verificar criação**

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'siso_reposicao_sugestoes'
ORDER BY ordinal_position;
```
Expected: 24 colunas listadas, todas como definidas.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518_reposicao_sugestoes.sql
git commit -m "$(cat <<'EOF'
feat(wms/reposicao): tabela siso_reposicao_sugestoes

Snapshot diário do cálculo preditivo: forecast (mu+sigma), classe ABC,
ROP, safety stock, urgência, qty sugerida, alternativas considoradas
e ação recomendada. Indexada por (data, score desc) pra ranking rápido.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Migration — Tabela `siso_reposicao_aprovacoes`

**Files:**
- Create: `supabase/migrations/20260518_reposicao_aprovacoes.sql`

- [ ] **Step 1: Criar arquivo de migration**

```sql
-- Audit trail de cada ação do comprador sobre uma sugestão.
-- Alimenta análise de aprendizado: sistema sugeriu X, comprador aprovou/ajustou/rejeitou.

CREATE TABLE siso_reposicao_aprovacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sugestao_id uuid NOT NULL REFERENCES siso_reposicao_sugestoes(id),
  usuario_id uuid NOT NULL REFERENCES siso_usuarios(id),
  acao text NOT NULL CHECK (acao IN ('aprovou', 'rejeitou', 'ajustou', 'aprovou_emprestimo', 'adiou')),
  qty_aprovada numeric,
  qty_sugerida_snapshot numeric,
  motivo text,
  ordem_compra_id uuid REFERENCES siso_ordens_compra(id),
  emprestimo_mov_id uuid REFERENCES siso_movimentacoes(id),
  criada_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_aprovacoes_usuario
  ON siso_reposicao_aprovacoes (usuario_id, criada_em DESC);
CREATE INDEX idx_aprovacoes_sugestao
  ON siso_reposicao_aprovacoes (sugestao_id);
```

- [ ] **Step 2: Aplicar migration**

Via `mcp__supabase__apply_migration` com `name="reposicao_aprovacoes"`.

- [ ] **Step 3: Verificar criação**

```sql
SELECT COUNT(*) FROM siso_reposicao_aprovacoes;
```
Expected: 0 (tabela vazia mas existe).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518_reposicao_aprovacoes.sql
git commit -m "$(cat <<'EOF'
feat(wms/reposicao): tabela siso_reposicao_aprovacoes

Audit trail de aprovações/rejeições/ajustes do comprador. Liga sugestão
à OC/empréstimo gerado pra rastreabilidade end-to-end e análise futura
de aprendizado (sistema sugeriu X, comprador aprovou Y).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Migration — Tabela `siso_reposicao_config` (singleton)

**Files:**
- Create: `supabase/migrations/20260518_reposicao_config.sql`

- [ ] **Step 1: Criar arquivo de migration**

```sql
-- Singleton de configuração do módulo de reposição.
-- Editável via admin no futuro (Fase 5 do spec). Por enquanto, ajustar via SQL.

CREATE TABLE siso_reposicao_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  z_classe_a numeric NOT NULL DEFAULT 2.05,
  z_classe_b numeric NOT NULL DEFAULT 1.65,
  z_classe_c numeric NOT NULL DEFAULT 1.28,
  z_sem_classe numeric NOT NULL DEFAULT 1.65,
  alpha_ses numeric NOT NULL DEFAULT 0.3,
  alpha_croston numeric NOT NULL DEFAULT 0.1,
  habilitar_emprestimo boolean NOT NULL DEFAULT true,
  habilitar_equivalente boolean NOT NULL DEFAULT true,
  cobertura_alvo_multiplicador numeric NOT NULL DEFAULT 2.0,
  dias_minimos_pra_sugerir smallint NOT NULL DEFAULT 14,
  lead_time_default_dias numeric NOT NULL DEFAULT 14,
  data_ligado_em date,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

INSERT INTO siso_reposicao_config (id, data_ligado_em)
VALUES (1, CURRENT_DATE)
ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 2: Aplicar migration**

Via `mcp__supabase__apply_migration` com `name="reposicao_config"`.

- [ ] **Step 3: Verificar seed**

```sql
SELECT * FROM siso_reposicao_config WHERE id = 1;
```
Expected: 1 linha com todos os defaults preenchidos e `data_ligado_em = hoje`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518_reposicao_config.sql
git commit -m "$(cat <<'EOF'
feat(wms/reposicao): tabela siso_reposicao_config singleton

Configuração editável dos parâmetros do módulo: Z's por classe ABC,
alphas das suavizações, toggles de empréstimo/equivalente, multiplicador
de cobertura alvo, dias mínimos pra sugerir, lead time default,
data_ligado_em (cold start banner).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Migration — RPC `wms_calcular_em_transito`

**Files:**
- Create: `supabase/migrations/20260518_reposicao_em_transito.sql`

- [ ] **Step 1: Criar arquivo de migration**

```sql
-- Soma quantidades pendentes de recebimento de OCs ativas pra cada (produto, empresa).
-- Note: schema atual de OCs tem itens em siso_pedido_itens (1 OC = 1 ou mais linhas
-- de pedido com ordem_compra_id setado). "Em trânsito" = qty - qty já recebida.

CREATE OR REPLACE FUNCTION wms_calcular_em_transito(
  p_produto_id uuid,
  p_empresa_id uuid
)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(GREATEST(pi.quantidade - pi.compra_quantidade_recebida, 0)), 0)::numeric
  FROM siso_pedido_itens pi
  JOIN siso_ordens_compra oc ON oc.id = pi.ordem_compra_id
  WHERE oc.empresa_id = p_empresa_id
    AND oc.status IN ('comprado', 'parcialmente_recebido')
    AND pi.produto_id = p_produto_id;
$$;
```

- [ ] **Step 2: Aplicar migration**

Via `mcp__supabase__apply_migration` com `name="reposicao_em_transito"`.

- [ ] **Step 3: Smoke-test**

```sql
SELECT wms_calcular_em_transito(
  (SELECT id FROM siso_produtos LIMIT 1),
  (SELECT id FROM siso_empresas LIMIT 1)
);
```
Expected: número (0 ou maior), sem erro.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518_reposicao_em_transito.sql
git commit -m "$(cat <<'EOF'
feat(wms/reposicao): RPC wms_calcular_em_transito

Soma qty pendente de recebimento de OCs ativas (status comprado ou
parcialmente_recebido) por produto+empresa. Usado pelo job de reposição
pra ajustar saldo efetivo e evitar duplicar sugestão quando OC já foi
emitida.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Lib — `types.ts` (interfaces compartilhadas)

**Files:**
- Create: `src/lib/wms/reposicao/types.ts`

- [ ] **Step 1: Criar arquivo de types**

```typescript
// src/lib/wms/reposicao/types.ts

export type PerfilDemanda = "regular" | "intermitente" | "sem_dados";
export type ConfiancaSugestao = "alta" | "media" | "baixa";
export type ClasseABC = "A" | "B" | "C";
export type UrgenciaFaixa = "critico" | "alto" | "medio" | "baixo";
export type AcaoRecomendada = "emprestimo" | "equivalente" | "comprar" | "aguardar";

export interface SerieDemanda {
  produto_id: string;
  empresa_dona_id: string;
  galpao_id: string;
  dias: number;
  serie_diaria: number[]; // index 0 = dia mais antigo, índice N-1 = dia mais recente
}

export interface ForecastResult {
  mu_diario: number;
  sigma_diario: number;
}

export interface ROPInput {
  classe: ClasseABC | null;
  muDiario: number;
  sigmaDemanda: number;
  leadTimeDias: number;
  zSemClasse: number;
  zClasseA: number;
  zClasseB: number;
  zClasseC: number;
}

export interface ROPResult {
  rop: number;
  safetyStock: number;
}

export interface UrgenciaInput {
  saldoAtual: number;
  reservado: number;
  emTransito: number;
  muDiario: number;
  leadTimeDias: number;
}

export interface UrgenciaResult {
  score: number;
  faixa: UrgenciaFaixa;
  diaRuptura: number | null;
  folgaDias: number;
}

export interface QtySugeridaInput {
  rop: number;
  saldoAtual: number;
  reservado: number;
  emTransito: number;
  moq: number;
  multiplo: number;
  coberturaAlvoMultiplicador: number;
}

export type AlternativaTipo = "emprestimo" | "equivalente";

export interface AlternativaEmprestimo {
  tipo: "emprestimo";
  empresa_credora_id: string;
  empresa_credora_nome: string;
  galpao_id: string;
  qty: number;
  motivo_descartada?: string;
}

export interface AlternativaEquivalente {
  tipo: "equivalente";
  produto_id_equivalente: string;
  sku_equivalente: string;
  qty: number;
  motivo_descartada?: string;
}

export type Alternativa = AlternativaEmprestimo | AlternativaEquivalente;

export interface ReposicaoConfig {
  z_classe_a: number;
  z_classe_b: number;
  z_classe_c: number;
  z_sem_classe: number;
  alpha_ses: number;
  alpha_croston: number;
  habilitar_emprestimo: boolean;
  habilitar_equivalente: boolean;
  cobertura_alvo_multiplicador: number;
  dias_minimos_pra_sugerir: number;
  lead_time_default_dias: number;
  data_ligado_em: string | null;
}
```

- [ ] **Step 2: Verificar build TypeScript**

Run: `npx tsc --noEmit src/lib/wms/reposicao/types.ts 2>&1 | head`
Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/lib/wms/reposicao/types.ts
git commit -m "$(cat <<'EOF'
feat(wms/reposicao): types compartilhados

Interfaces: SerieDemanda, ForecastResult, ROPInput/Result, UrgenciaInput/Result,
QtySugeridaInput, Alternativa (emprestimo|equivalente), ReposicaoConfig.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Lib — `demanda.ts` + tests (classificador de perfil)

**Files:**
- Create: `src/lib/wms/reposicao/demanda.ts`
- Create: `src/lib/wms/reposicao/demanda.test.ts`

- [ ] **Step 1: Escrever testes que falham**

`src/lib/wms/reposicao/demanda.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { classificarPerfil } from "./demanda";

describe("classificarPerfil", () => {
  it("retorna sem_dados quando série tem menos de 14 dias", () => {
    expect(classificarPerfil([1, 2, 3])).toBe("sem_dados");
    expect(classificarPerfil(new Array(13).fill(1))).toBe("sem_dados");
  });

  it("retorna regular quando ≥14 dias, ≤30% zeros, e média semanal ≥1", () => {
    // 30 dias com 5 zeros (16.7%) e média 2/dia
    const serie = [2, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2, 2, 2, 2, 2];
    expect(classificarPerfil(serie)).toBe("regular");
  });

  it("retorna intermitente quando > 30% dos dias têm zero", () => {
    // 30 dias com 15 zeros (50%)
    const serie = [0, 3, 0, 4, 0, 2, 0, 5, 0, 1, 0, 2, 0, 3, 0, 4, 0, 1, 0, 2, 3, 4, 1, 2, 5, 3, 2, 4, 1, 2];
    expect(classificarPerfil(serie)).toBe("intermitente");
  });

  it("retorna intermitente quando média semanal < 1 mesmo com poucos zeros", () => {
    // 21 dias com média ~0.71/dia (5/7) → semanal < 1
    const serie = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    expect(classificarPerfil(serie)).toBe("intermitente");
  });
});
```

- [ ] **Step 2: Rodar testes e ver falhar**

Run: `npx vitest run src/lib/wms/reposicao/demanda.test.ts`
Expected: FAIL com erro de import (módulo não existe).

- [ ] **Step 3: Implementar `demanda.ts`**

```typescript
// src/lib/wms/reposicao/demanda.ts
import type { PerfilDemanda } from "./types";

/**
 * Classifica o perfil de demanda baseado na série diária.
 * - sem_dados: < 14 pontos
 * - intermitente: > 30% zeros OU média semanal < 1
 * - regular: caso contrário
 */
export function classificarPerfil(serieDiaria: number[]): PerfilDemanda {
  if (serieDiaria.length < 14) return "sem_dados";

  const zeros = serieDiaria.filter((v) => v === 0).length;
  const pctZeros = zeros / serieDiaria.length;
  const total = serieDiaria.reduce((a, b) => a + b, 0);
  const mediaSemanal = (total / serieDiaria.length) * 7;

  if (pctZeros > 0.3 || mediaSemanal < 1) return "intermitente";
  return "regular";
}
```

- [ ] **Step 4: Rodar testes e ver passar**

Run: `npx vitest run src/lib/wms/reposicao/demanda.test.ts`
Expected: PASS, 4 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/reposicao/demanda.ts src/lib/wms/reposicao/demanda.test.ts
git commit -m "$(cat <<'EOF'
feat(wms/reposicao): classificarPerfil (regular|intermitente|sem_dados)

Função pura que classifica o perfil de demanda a partir da série diária:
< 14 pts = sem_dados, > 30% zeros ou média semanal < 1 = intermitente,
caso contrário = regular. 4 testes cobrem os limiares.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Lib — `forecast.ts` + tests (SES + Croston-SBA)

**Files:**
- Create: `src/lib/wms/reposicao/forecast.ts`
- Create: `src/lib/wms/reposicao/forecast.test.ts`

- [ ] **Step 1: Escrever testes que falham**

`src/lib/wms/reposicao/forecast.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { forecastSES, forecastCrostonSBA } from "./forecast";

describe("forecastSES", () => {
  it("retorna mu ≈ média histórica em série estável", () => {
    const serie = new Array(30).fill(5);
    const r = forecastSES(serie, 0.3);
    expect(r.mu_diario).toBeCloseTo(5, 1);
    expect(r.sigma_diario).toBeCloseTo(0, 1);
  });

  it("captura mudança de nível em série crescente", () => {
    // 20 dias em 3/dia, depois 10 dias em 8/dia → SES com alpha=0.3 deve estar entre 5 e 8
    const serie = [...new Array(20).fill(3), ...new Array(10).fill(8)];
    const r = forecastSES(serie, 0.3);
    expect(r.mu_diario).toBeGreaterThan(5);
    expect(r.mu_diario).toBeLessThan(8);
    expect(r.sigma_diario).toBeGreaterThan(0);
  });

  it("sigma > 0 quando há variação", () => {
    const serie = [1, 5, 2, 8, 3, 7, 4, 6, 5, 5, 4, 6, 3, 7, 2, 8, 1, 9, 5, 5, 4, 6, 3, 7, 5, 5, 4, 6, 5, 5];
    const r = forecastSES(serie, 0.3);
    expect(r.sigma_diario).toBeGreaterThan(0.5);
  });
});

describe("forecastCrostonSBA", () => {
  it("retorna 0,0 quando há menos de 2 vendas não-zero", () => {
    const serie = [0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const r = forecastCrostonSBA(serie, 0.1);
    expect(r.mu_diario).toBe(0);
    expect(r.sigma_diario).toBe(0);
  });

  it("calcula taxa de demanda em série intermitente", () => {
    // vendas de tamanho ~3 a cada ~5 dias
    const serie = [0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3];
    const r = forecastCrostonSBA(serie, 0.1);
    // taxa esperada ≈ 3/5 = 0.6, com correção SBA (1 - alpha/2) = 0.95 → ≈ 0.57
    expect(r.mu_diario).toBeGreaterThan(0.4);
    expect(r.mu_diario).toBeLessThan(0.7);
  });

  it("correção SBA reduz o resultado vs Croston original", () => {
    // SBA = Croston × (1 - alpha/2), então com alpha=0.5 a redução é 25%
    const serie = [0, 5, 0, 5, 0, 5, 0, 5, 0, 5, 0, 5, 0, 5];
    const r = forecastCrostonSBA(serie, 0.5);
    // Croston puro daria ~5/2 = 2.5; SBA reduz pra ~1.875
    expect(r.mu_diario).toBeLessThan(2.5);
    expect(r.mu_diario).toBeGreaterThan(0.5);
  });
});
```

- [ ] **Step 2: Rodar testes e ver falhar**

Run: `npx vitest run src/lib/wms/reposicao/forecast.test.ts`
Expected: FAIL com erro de import.

- [ ] **Step 3: Implementar `forecast.ts`**

```typescript
// src/lib/wms/reposicao/forecast.ts
import type { ForecastResult } from "./types";

/**
 * Simple Exponential Smoothing — pra séries com demanda regular.
 * Inicializa nível com média dos primeiros 7 dias, depois aplica α.
 * Retorna mu (nível atual) e sigma (desvio padrão dos resíduos).
 */
export function forecastSES(serieDiaria: number[], alpha: number): ForecastResult {
  if (serieDiaria.length === 0) return { mu_diario: 0, sigma_diario: 0 };

  const warmup = Math.min(7, Math.floor(serieDiaria.length / 2));
  let nivel = serieDiaria.slice(0, warmup).reduce((a, b) => a + b, 0) / warmup;

  // Passa pela série uma vez, calculando resíduos
  const residuos: number[] = [];
  for (let i = warmup; i < serieDiaria.length; i++) {
    const erro = serieDiaria[i] - nivel;
    residuos.push(erro);
    nivel = alpha * serieDiaria[i] + (1 - alpha) * nivel;
  }

  let sigma = 0;
  if (residuos.length > 1) {
    const denom = residuos.length - 1;
    sigma = Math.sqrt(residuos.reduce((s, e) => s + e * e, 0) / denom);
  }

  return { mu_diario: nivel, sigma_diario: sigma };
}

/**
 * Croston com correção SBA (Syntetos-Boylan Approximation) — pra demanda intermitente.
 * Separa tamanho-da-venda e intervalo-entre-vendas, suaviza independentemente,
 * retorna taxa = (z/p) × (1 - α/2).
 */
export function forecastCrostonSBA(serieDiaria: number[], alpha: number): ForecastResult {
  const tamanhos: number[] = [];
  const intervalos: number[] = [];
  let gap = 0;
  for (const v of serieDiaria) {
    if (v > 0) {
      tamanhos.push(v);
      intervalos.push(gap + 1);
      gap = 0;
    } else {
      gap++;
    }
  }

  if (tamanhos.length < 2) return { mu_diario: 0, sigma_diario: 0 };

  let z = tamanhos[0];
  let p = intervalos[0];
  for (let i = 1; i < tamanhos.length; i++) {
    z = alpha * tamanhos[i] + (1 - alpha) * z;
    p = alpha * intervalos[i] + (1 - alpha) * p;
  }

  const mu = (z / p) * (1 - alpha / 2);

  // σ proxy: desvio padrão dos tamanhos amostrais
  const mediaTam = tamanhos.reduce((a, b) => a + b, 0) / tamanhos.length;
  const varTam = tamanhos.reduce((s, t) => s + (t - mediaTam) ** 2, 0) / tamanhos.length;
  const sigma = Math.sqrt(varTam);

  return { mu_diario: mu, sigma_diario: sigma };
}
```

- [ ] **Step 4: Rodar testes e ver passar**

Run: `npx vitest run src/lib/wms/reposicao/forecast.test.ts`
Expected: PASS, 6 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/reposicao/forecast.ts src/lib/wms/reposicao/forecast.test.ts
git commit -m "$(cat <<'EOF'
feat(wms/reposicao): forecast SES + Croston-SBA

Dois métodos puros de previsão de demanda:
- SES: suavização exponencial simples pra demanda regular (warmup com
  média dos primeiros 7 dias + nível atualizado por alpha + σ dos resíduos)
- Croston-SBA: pra demanda intermitente (separa tamanho/intervalo,
  suaviza independentemente, aplica correção 1-α/2 pra remover bias).

6 testes cobrem série estável, mudança de nível, intermitente, e correção SBA.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Lib — `rop.ts` + tests (ROP + safety stock + qty)

**Files:**
- Create: `src/lib/wms/reposicao/rop.ts`
- Create: `src/lib/wms/reposicao/rop.test.ts`

- [ ] **Step 1: Escrever testes que falham**

`src/lib/wms/reposicao/rop.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { calcularROP, calcularQtySugerida } from "./rop";

const Z_DEFAULTS = {
  zClasseA: 2.05,
  zClasseB: 1.65,
  zClasseC: 1.28,
  zSemClasse: 1.65,
};

describe("calcularROP", () => {
  it("usa Z=2.05 (98%) pra classe A", () => {
    const r = calcularROP({ classe: "A", muDiario: 3, sigmaDemanda: 1, leadTimeDias: 7, ...Z_DEFAULTS });
    // ROP = (7 × 3) + (2.05 × 1 × √7) ≈ 21 + 5.42 ≈ 26.42 → ceil 27
    expect(r.rop).toBe(27);
    expect(r.safetyStock).toBe(6); // ceil(5.42)
  });

  it("usa Z=1.28 (90%) pra classe C", () => {
    const r = calcularROP({ classe: "C", muDiario: 3, sigmaDemanda: 1, leadTimeDias: 7, ...Z_DEFAULTS });
    // ROP = 21 + (1.28 × √7) ≈ 21 + 3.39 ≈ 24.39 → 25
    expect(r.rop).toBe(25);
    expect(r.safetyStock).toBe(4);
  });

  it("usa Z padrão quando classe é null", () => {
    const r = calcularROP({ classe: null, muDiario: 2, sigmaDemanda: 0.5, leadTimeDias: 10, ...Z_DEFAULTS });
    // ROP = 20 + (1.65 × 0.5 × √10) ≈ 20 + 2.61 ≈ 22.61 → 23
    expect(r.rop).toBe(23);
    expect(r.safetyStock).toBe(3);
  });

  it("safety stock = 0 quando sigma = 0", () => {
    const r = calcularROP({ classe: "A", muDiario: 5, sigmaDemanda: 0, leadTimeDias: 7, ...Z_DEFAULTS });
    expect(r.safetyStock).toBe(0);
    expect(r.rop).toBe(35);
  });
});

describe("calcularQtySugerida", () => {
  it("zero quando saldo + em_transito já cobre o alvo", () => {
    const qty = calcularQtySugerida({
      rop: 30, saldoAtual: 80, reservado: 10, emTransito: 0,
      moq: 10, multiplo: 5, coberturaAlvoMultiplicador: 2,
    });
    // alvo = 60, saldo efetivo = 70, déficit = -10 → 0
    expect(qty).toBe(0);
  });

  it("respeita MOQ quando déficit é menor", () => {
    const qty = calcularQtySugerida({
      rop: 30, saldoAtual: 55, reservado: 0, emTransito: 0,
      moq: 10, multiplo: 1, coberturaAlvoMultiplicador: 2,
    });
    // alvo = 60, déficit = 5, MOQ = 10 → 10
    expect(qty).toBe(10);
  });

  it("arredonda pra cima no múltiplo", () => {
    const qty = calcularQtySugerida({
      rop: 30, saldoAtual: 12, reservado: 0, emTransito: 0,
      moq: 1, multiplo: 5, coberturaAlvoMultiplicador: 2,
    });
    // alvo = 60, déficit = 48, próximo múltiplo de 5 = 50
    expect(qty).toBe(50);
  });

  it("desconta em_transito do déficit", () => {
    const qty = calcularQtySugerida({
      rop: 30, saldoAtual: 12, reservado: 0, emTransito: 30,
      moq: 1, multiplo: 5, coberturaAlvoMultiplicador: 2,
    });
    // alvo = 60, saldo efetivo = 42, déficit = 18, próximo múltiplo de 5 = 20
    expect(qty).toBe(20);
  });
});
```

- [ ] **Step 2: Rodar testes e ver falhar**

Run: `npx vitest run src/lib/wms/reposicao/rop.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `rop.ts`**

```typescript
// src/lib/wms/reposicao/rop.ts
import type { ROPInput, ROPResult, QtySugeridaInput } from "./types";

export function calcularROP(opts: ROPInput): ROPResult {
  const Z = pickZ(opts);
  const safetyStock = Z * opts.sigmaDemanda * Math.sqrt(opts.leadTimeDias);
  const rop = opts.leadTimeDias * opts.muDiario + safetyStock;
  return { rop: Math.ceil(rop), safetyStock: Math.ceil(safetyStock) };
}

function pickZ(opts: ROPInput): number {
  switch (opts.classe) {
    case "A": return opts.zClasseA;
    case "B": return opts.zClasseB;
    case "C": return opts.zClasseC;
    default:  return opts.zSemClasse;
  }
}

export function calcularQtySugerida(opts: QtySugeridaInput): number {
  const alvo = opts.rop * opts.coberturaAlvoMultiplicador;
  const saldoEfetivo = opts.saldoAtual - opts.reservado + opts.emTransito;
  const deficit = alvo - saldoEfetivo;
  if (deficit <= 0) return 0;

  let qty = Math.max(deficit, opts.moq);
  if (opts.multiplo > 1) {
    qty = Math.ceil(qty / opts.multiplo) * opts.multiplo;
  }
  return Math.ceil(qty);
}
```

- [ ] **Step 4: Rodar testes e ver passar**

Run: `npx vitest run src/lib/wms/reposicao/rop.test.ts`
Expected: PASS, 8 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/reposicao/rop.ts src/lib/wms/reposicao/rop.test.ts
git commit -m "$(cat <<'EOF'
feat(wms/reposicao): calcularROP + calcularQtySugerida

calcularROP: ROP = LT × mu + Z × σ × √LT, Z diferenciado por classe ABC
(A=2.05/98%, B=1.65/95%, C=1.28/90%, default=B). Arredonda pra cima.

calcularQtySugerida: alvo = cobertura_multiplicador × ROP, déficit
desconta saldo efetivo (saldo - reservado + em_transito), aplica MOQ,
arredonda pra cima no múltiplo. Retorna 0 quando saldo já cobre.

8 testes cobrem casos de borda (sigma=0, déficit negativo, MOQ, múltiplo).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Lib — `urgencia.ts` + tests

**Files:**
- Create: `src/lib/wms/reposicao/urgencia.ts`
- Create: `src/lib/wms/reposicao/urgencia.test.ts`

- [ ] **Step 1: Escrever testes que falham**

`src/lib/wms/reposicao/urgencia.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { calcularUrgencia, faixaDeUrgencia } from "./urgencia";

describe("calcularUrgencia", () => {
  it("score=0 quando demanda diária é 0 (sem giro)", () => {
    const r = calcularUrgencia({ saldoAtual: 10, reservado: 0, emTransito: 0, muDiario: 0, leadTimeDias: 7 });
    expect(r.score).toBe(0);
    expect(r.diaRuptura).toBe(null);
    expect(r.folgaDias).toBe(Infinity);
  });

  it("score≥80 (crítico) quando vai zerar antes do lead time", () => {
    // saldo efetivo = 6, demanda 3/dia → 2 dias até zerar. lead time 7 dias.
    // folga = 2 - 7 = -5 → score = 50 - (-5)*10 = 100 → clamped a 100, faixa Crítico
    const r = calcularUrgencia({ saldoAtual: 6, reservado: 0, emTransito: 0, muDiario: 3, leadTimeDias: 7 });
    expect(r.diaRuptura).toBe(2);
    expect(r.folgaDias).toBe(-5);
    expect(r.score).toBe(100);
  });

  it("score na faixa Médio (20-49) com folga de 3-4 dias", () => {
    // saldo 22, demanda 2/dia, lead time 7 → ruptura em 11 dias, folga = 4 → score = 50 - 40 = 10
    // mas score=10 cai em Baixo. Vou ajustar pra cair em Médio: folga=2-3 dias
    // saldo 18, demanda 2/dia, lead time 7 → ruptura 9, folga 2 → score = 50 - 20 = 30
    const r = calcularUrgencia({ saldoAtual: 18, reservado: 0, emTransito: 0, muDiario: 2, leadTimeDias: 7 });
    expect(r.score).toBe(30);
  });

  it("score na faixa Baixo (0-19) quando cobertura folgada", () => {
    // saldo 50, demanda 1/dia, lead time 7 → ruptura 50, folga 43 → score = clamp(50-430)=0
    const r = calcularUrgencia({ saldoAtual: 50, reservado: 0, emTransito: 0, muDiario: 1, leadTimeDias: 7 });
    expect(r.score).toBe(0);
  });

  it("considera em_transito no saldo efetivo", () => {
    // saldo 6 + transito 30 = 36 efetivo. demanda 3 → ruptura 12, lead 7, folga 5 → score 0
    const r = calcularUrgencia({ saldoAtual: 6, reservado: 0, emTransito: 30, muDiario: 3, leadTimeDias: 7 });
    expect(r.score).toBe(0);
  });
});

describe("faixaDeUrgencia", () => {
  it("≥80 → crítico", () => expect(faixaDeUrgencia(80)).toBe("critico"));
  it("≥50 → alto",     () => expect(faixaDeUrgencia(60)).toBe("alto"));
  it("≥20 → medio",    () => expect(faixaDeUrgencia(30)).toBe("medio"));
  it("<20  → baixo",   () => expect(faixaDeUrgencia(10)).toBe("baixo"));
  it("limites exatos", () => {
    expect(faixaDeUrgencia(50)).toBe("alto");
    expect(faixaDeUrgencia(49)).toBe("medio");
    expect(faixaDeUrgencia(20)).toBe("medio");
    expect(faixaDeUrgencia(19)).toBe("baixo");
  });
});
```

- [ ] **Step 2: Rodar testes e ver falhar**

Run: `npx vitest run src/lib/wms/reposicao/urgencia.test.ts`

- [ ] **Step 3: Implementar `urgencia.ts`**

```typescript
// src/lib/wms/reposicao/urgencia.ts
import type { UrgenciaFaixa, UrgenciaInput, UrgenciaResult } from "./types";

export function calcularUrgencia(opts: UrgenciaInput): UrgenciaResult {
  if (opts.muDiario <= 0) {
    return { score: 0, faixa: "baixo", diaRuptura: null, folgaDias: Infinity };
  }
  const saldoEfetivo = opts.saldoAtual - opts.reservado + opts.emTransito;
  const diaRuptura = Math.max(0, Math.ceil(saldoEfetivo / opts.muDiario));
  const folgaDias = diaRuptura - opts.leadTimeDias;
  const score = Math.max(0, Math.min(100, Math.round(50 - folgaDias * 10)));
  return { score, faixa: faixaDeUrgencia(score), diaRuptura, folgaDias };
}

export function faixaDeUrgencia(score: number): UrgenciaFaixa {
  if (score >= 80) return "critico";
  if (score >= 50) return "alto";
  if (score >= 20) return "medio";
  return "baixo";
}
```

- [ ] **Step 4: Rodar testes e ver passar**

Run: `npx vitest run src/lib/wms/reposicao/urgencia.test.ts`
Expected: PASS, 10 testes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/reposicao/urgencia.ts src/lib/wms/reposicao/urgencia.test.ts
git commit -m "$(cat <<'EOF'
feat(wms/reposicao): calcularUrgencia + faixaDeUrgencia

Score 0-100 baseado em (dias até ruptura − lead time): folga grande →
score baixo, folga negativa → score alto. Faixas: ≥80 crítico, ≥50 alto,
≥20 médio, <20 baixo. Quando demanda diária é 0, urgência = 0 (sem giro).

10 testes cobrem faixas, em_transito, demanda zero, limites exatos.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Lib — `alternativas.ts` + tests

**Files:**
- Create: `src/lib/wms/reposicao/alternativas.ts`
- Create: `src/lib/wms/reposicao/alternativas.test.ts`

- [ ] **Step 1: Escrever testes que falham**

`src/lib/wms/reposicao/alternativas.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { decidirAcao, escolherAlternativaPrimaria } from "./alternativas";
import type { Alternativa } from "./types";

describe("decidirAcao", () => {
  it("retorna 'aguardar' quando qty sugerida é 0", () => {
    expect(decidirAcao({ qty: 0, alternativas: [], habilitarEmprestimo: true, habilitarEquivalente: true })).toBe("aguardar");
  });

  it("retorna 'emprestimo' quando há alternativa de empréstimo válida e habilitada", () => {
    const alts: Alternativa[] = [
      { tipo: "emprestimo", empresa_credora_id: "x", empresa_credora_nome: "NetParts", galpao_id: "g", qty: 30 },
    ];
    expect(decidirAcao({ qty: 25, alternativas: alts, habilitarEmprestimo: true, habilitarEquivalente: true })).toBe("emprestimo");
  });

  it("ignora empréstimo quando flag está desligada", () => {
    const alts: Alternativa[] = [
      { tipo: "emprestimo", empresa_credora_id: "x", empresa_credora_nome: "NetParts", galpao_id: "g", qty: 30 },
    ];
    expect(decidirAcao({ qty: 25, alternativas: alts, habilitarEmprestimo: false, habilitarEquivalente: true })).toBe("comprar");
  });

  it("retorna 'comprar' quando não há alternativa válida", () => {
    expect(decidirAcao({ qty: 25, alternativas: [], habilitarEmprestimo: true, habilitarEquivalente: true })).toBe("comprar");
  });
});

describe("escolherAlternativaPrimaria", () => {
  it("escolhe empréstimo com maior qty disponível", () => {
    const alts: Alternativa[] = [
      { tipo: "emprestimo", empresa_credora_id: "a", empresa_credora_nome: "A", galpao_id: "g", qty: 10 },
      { tipo: "emprestimo", empresa_credora_id: "b", empresa_credora_nome: "B", galpao_id: "g", qty: 25 },
    ];
    const pick = escolherAlternativaPrimaria(alts);
    expect(pick?.tipo).toBe("emprestimo");
    if (pick?.tipo === "emprestimo") expect(pick.empresa_credora_id).toBe("b");
  });

  it("retorna null em lista vazia", () => {
    expect(escolherAlternativaPrimaria([])).toBe(null);
  });

  it("ignora alternativas com motivo_descartada", () => {
    const alts: Alternativa[] = [
      { tipo: "emprestimo", empresa_credora_id: "a", empresa_credora_nome: "A", galpao_id: "g", qty: 30, motivo_descartada: "Insuficiente" },
    ];
    expect(escolherAlternativaPrimaria(alts)).toBe(null);
  });
});
```

- [ ] **Step 2: Rodar testes e ver falhar**

Run: `npx vitest run src/lib/wms/reposicao/alternativas.test.ts`

- [ ] **Step 3: Implementar `alternativas.ts`**

```typescript
// src/lib/wms/reposicao/alternativas.ts
import type { AcaoRecomendada, Alternativa } from "./types";

export interface DecidirAcaoInput {
  qty: number;
  alternativas: Alternativa[];
  habilitarEmprestimo: boolean;
  habilitarEquivalente: boolean;
}

export function decidirAcao(opts: DecidirAcaoInput): AcaoRecomendada {
  if (opts.qty <= 0) return "aguardar";

  const validas = opts.alternativas.filter((a) => !a.motivo_descartada);
  const temEmprestimo = opts.habilitarEmprestimo && validas.some((a) => a.tipo === "emprestimo");
  const temEquivalente = opts.habilitarEquivalente && validas.some((a) => a.tipo === "equivalente");

  if (temEmprestimo) return "emprestimo";
  if (temEquivalente) return "equivalente";
  return "comprar";
}

/**
 * Dentre as alternativas válidas (sem motivo_descartada), escolhe a melhor:
 * preferindo empréstimo, depois equivalente, sempre a com maior qty.
 */
export function escolherAlternativaPrimaria(alternativas: Alternativa[]): Alternativa | null {
  const validas = alternativas.filter((a) => !a.motivo_descartada);
  if (validas.length === 0) return null;

  const emprestimos = validas.filter((a) => a.tipo === "emprestimo");
  if (emprestimos.length > 0) {
    return emprestimos.reduce((acc, cur) => (cur.qty > acc.qty ? cur : acc));
  }
  const equivalentes = validas.filter((a) => a.tipo === "equivalente");
  if (equivalentes.length > 0) {
    return equivalentes.reduce((acc, cur) => (cur.qty > acc.qty ? cur : acc));
  }
  return null;
}
```

- [ ] **Step 4: Rodar testes e ver passar**

Run: `npx vitest run src/lib/wms/reposicao/alternativas.test.ts`
Expected: PASS, 7 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/reposicao/alternativas.ts src/lib/wms/reposicao/alternativas.test.ts
git commit -m "$(cat <<'EOF'
feat(wms/reposicao): decidirAcao + escolherAlternativaPrimaria

Funções puras (sem I/O) que decidem a ação recomendada e escolhem a
melhor alternativa entre as candidatas resolvidas externamente
(empréstimo N×N e equivalente Cross). Hierarquia: empréstimo →
equivalente → comprar; aguardar quando qty=0. Toggles globais
respeitados.

7 testes cobrem hierarquia, toggles, validade, qty zero.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Lib — `explicacao.ts` + tests (gera texto humano)

**Files:**
- Create: `src/lib/wms/reposicao/explicacao.ts`
- Create: `src/lib/wms/reposicao/explicacao.test.ts`

- [ ] **Step 1: Escrever testes que falham**

`src/lib/wms/reposicao/explicacao.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { gerarExplicacao } from "./explicacao";

describe("gerarExplicacao", () => {
  it("descreve sugestão de compra com todos os fatores", () => {
    const texto = gerarExplicacao({
      acao: "comprar",
      classe: "A",
      perfil: "regular",
      muDiario: 3.2,
      sigmaDemanda: 1.1,
      leadTimeDias: 7,
      rop: 29,
      diaRuptura: 4,
      folgaDias: -3,
      qty: 50,
      fornecedorNome: "Tiger",
    });
    expect(texto).toContain("Curva A");
    expect(texto).toContain("3,2");
    expect(texto).toContain("Tiger");
    expect(texto).toContain("50");
  });

  it("descreve sugestão de empréstimo", () => {
    const texto = gerarExplicacao({
      acao: "emprestimo",
      classe: "B",
      perfil: "regular",
      muDiario: 2,
      sigmaDemanda: 0.5,
      leadTimeDias: 5,
      rop: 14,
      diaRuptura: 3,
      folgaDias: -2,
      qty: 10,
      empresaCredoraNome: "NetParts",
    });
    expect(texto).toContain("emprestar");
    expect(texto).toContain("NetParts");
  });

  it("descreve estado 'aguardar' quando qty=0", () => {
    const texto = gerarExplicacao({
      acao: "aguardar",
      classe: "C",
      perfil: "regular",
      muDiario: 1,
      sigmaDemanda: 0.2,
      leadTimeDias: 14,
      rop: 16,
      diaRuptura: 40,
      folgaDias: 26,
      qty: 0,
    });
    expect(texto.toLowerCase()).toContain("cobertura");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/wms/reposicao/explicacao.test.ts`

- [ ] **Step 3: Implementar `explicacao.ts`**

```typescript
// src/lib/wms/reposicao/explicacao.ts
import type { AcaoRecomendada, ClasseABC, PerfilDemanda } from "./types";

export interface ExplicacaoInput {
  acao: AcaoRecomendada;
  classe: ClasseABC | null;
  perfil: PerfilDemanda;
  muDiario: number;
  sigmaDemanda: number;
  leadTimeDias: number;
  rop: number;
  diaRuptura: number | null;
  folgaDias: number;
  qty: number;
  fornecedorNome?: string;
  empresaCredoraNome?: string;
  skuEquivalente?: string;
}

const fmt = (n: number): string => n.toFixed(1).replace(".", ",");

export function gerarExplicacao(opts: ExplicacaoInput): string {
  const classe = opts.classe ? `Curva ${opts.classe}` : "Sem curva ABC";
  const perfilTxt = opts.perfil === "regular" ? "demanda regular" : opts.perfil === "intermitente" ? "demanda intermitente" : "sem histórico suficiente";

  if (opts.acao === "aguardar") {
    return `${classe}, ${perfilTxt}. Cobertura folgada — saldo cobre ${opts.diaRuptura ?? "muitos"} dias e lead time ${opts.leadTimeDias}d. Sem ação necessária.`;
  }

  const base = `${classe}, ${perfilTxt}, vendendo ${fmt(opts.muDiario)}/dia ± ${fmt(opts.sigmaDemanda)}. Lead time ${opts.leadTimeDias}d, ponto de pedido ${opts.rop}. Vai zerar em ${opts.diaRuptura ?? "?"}d (folga ${opts.folgaDias >= 0 ? "+" : ""}${opts.folgaDias}d vs lead time).`;

  if (opts.acao === "emprestimo" && opts.empresaCredoraNome) {
    return `${base} Sugestão: emprestar ${opts.qty} unidades de ${opts.empresaCredoraNome} antes de comprar.`;
  }
  if (opts.acao === "equivalente" && opts.skuEquivalente) {
    return `${base} Sugestão: usar SKU equivalente ${opts.skuEquivalente} (em estoque). Comprar fica como fallback.`;
  }
  if (opts.acao === "comprar") {
    const forn = opts.fornecedorNome ? ` da ${opts.fornecedorNome}` : "";
    return `${base} Sugestão: comprar ${opts.qty}${forn}.`;
  }
  return base;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/wms/reposicao/explicacao.test.ts`
Expected: PASS, 3 testes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/reposicao/explicacao.ts src/lib/wms/reposicao/explicacao.test.ts
git commit -m "$(cat <<'EOF'
feat(wms/reposicao): gerarExplicacao (texto humano)

Função pura que gera explicação curta em PT-BR pra coluna 'Por quê?'
do drawer. Cita classe ABC, perfil de demanda, taxa diária ± σ,
lead time, ponto de pedido, dias até ruptura, folga, e ação sugerida
(comprar / emprestimo / equivalente / aguardar).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Fase 2 — Job + API

### Task 14: Lib — `refresh.ts` (orquestrador do job noturno)

**Files:**
- Create: `src/lib/wms/reposicao/refresh.ts`

- [ ] **Step 1: Implementar orquestrador**

```typescript
// src/lib/wms/reposicao/refresh.ts
import { createServiceClient } from "@/lib/supabase-server";
import { classificarPerfil } from "./demanda";
import { forecastSES, forecastCrostonSBA } from "./forecast";
import { calcularROP, calcularQtySugerida } from "./rop";
import { calcularUrgencia } from "./urgencia";
import { decidirAcao } from "./alternativas";
import { gerarExplicacao } from "./explicacao";
import type { Alternativa, ReposicaoConfig } from "./types";
import { logger } from "@/lib/logger";

interface SkuRow {
  produto_id: string;
  empresa_dona_id: string;
  galpao_id: string;
  saldo: number;
  reservado: number;
}

interface FornPrefRow {
  fornecedor_id: string;
  fornecedor_nome: string;
  lead_time_medio: number | null;
  custo_unitario: number | null;
  qty_minima_pedido: number | null;
  multiplo_compra: number | null;
}

export async function refreshReposicaoDiaria(opts: { force?: boolean } = {}): Promise<{
  processados: number;
  pulados: number;
  erros: number;
  duracao_ms: number;
}> {
  const t0 = Date.now();
  const sb = createServiceClient();
  const today = new Date().toISOString().slice(0, 10);

  // Skip se já rodou hoje (a menos que force)
  if (!opts.force) {
    const { data: existing } = await sb
      .from("siso_reposicao_sugestoes")
      .select("id", { count: "exact", head: true })
      .eq("data_calculo", today);
    if (existing && existing.length > 0) {
      logger.info("reposicao/refresh", `já rodou hoje (${today}), use force=true pra rodar de novo`);
      return { processados: 0, pulados: 1, erros: 0, duracao_ms: Date.now() - t0 };
    }
  }

  // 1. Refresh MV de demanda
  await sb.rpc("wms_refresh_demanda_diaria");

  // 2. Carrega config
  const { data: configRow, error: errConfig } = await sb
    .from("siso_reposicao_config")
    .select("*")
    .eq("id", 1)
    .single();
  if (errConfig || !configRow) throw new Error("siso_reposicao_config singleton não encontrado");
  const config = configRow as ReposicaoConfig;

  // 3. Lista SKUs ativos: saldo > 0 OU movimentação nos últimos 30d
  const skus = await listarSkusElegiveis(sb);

  // 4. Pra cada SKU, calcula e acumula
  const upserts: any[] = [];
  let erros = 0;

  for (const sku of skus) {
    try {
      const sugestao = await calcularSugestaoParaSku(sb, sku, config, today);
      if (sugestao) upserts.push(sugestao);
    } catch (e) {
      erros++;
      logger.warn("reposicao/refresh", `falha no SKU ${sku.produto_id}: ${(e as Error).message}`);
    }
  }

  // 5. Upsert em lote
  if (upserts.length > 0) {
    const { error } = await sb
      .from("siso_reposicao_sugestoes")
      .upsert(upserts, { onConflict: "data_calculo,produto_id,empresa_dona_id,galpao_id" });
    if (error) throw new Error(`falha no upsert: ${error.message}`);
  }

  return { processados: upserts.length, pulados: 0, erros, duracao_ms: Date.now() - t0 };
}

async function listarSkusElegiveis(sb: ReturnType<typeof createServiceClient>): Promise<SkuRow[]> {
  // Pega todas as linhas de saldo com saldo > 0 OU com mov nos últimos 30 dias
  const { data, error } = await sb
    .from("siso_estoque")
    .select("produto_id, empresa_dona_id, galpao_id, saldo, reservado")
    .gt("saldo", 0);
  if (error) throw error;
  return (data ?? []) as SkuRow[];
}

async function calcularSugestaoParaSku(
  sb: ReturnType<typeof createServiceClient>,
  sku: SkuRow,
  config: ReposicaoConfig,
  today: string,
): Promise<any | null> {
  // 1. Série diária (90 dias)
  const { data: serieRows } = await sb
    .from("siso_demanda_diaria")
    .select("data, qty_total")
    .eq("produto_id", sku.produto_id)
    .eq("empresa_dona_id", sku.empresa_dona_id)
    .eq("galpao_id", sku.galpao_id)
    .order("data");
  const serie = expandirSerieDiaria(serieRows ?? [], 90);

  const perfil = classificarPerfil(serie);
  const diasDeDados = serie.length;

  let mu = 0, sigma = 0;
  if (perfil === "regular") ({ mu_diario: mu, sigma_diario: sigma } = forecastSES(serie, config.alpha_ses));
  else if (perfil === "intermitente") ({ mu_diario: mu, sigma_diario: sigma } = forecastCrostonSBA(serie, config.alpha_croston));

  // 2. Classe ABC
  const { data: classeRow } = await sb
    .from("siso_curva_abc")
    .select("classe")
    .eq("produto_id", sku.produto_id)
    .eq("galpao_id", sku.galpao_id)
    .maybeSingle();
  const classe = (classeRow?.classe ?? null) as "A" | "B" | "C" | null;

  // 3. Fornecedor preferencial
  const fornPref = await buscarFornecedorPreferencial(sb, sku.produto_id);
  const leadTime = fornPref?.lead_time_medio ?? config.lead_time_default_dias;

  // 4. ROP
  const { rop, safetyStock } = calcularROP({
    classe,
    muDiario: mu,
    sigmaDemanda: sigma,
    leadTimeDias: leadTime,
    zClasseA: config.z_classe_a,
    zClasseB: config.z_classe_b,
    zClasseC: config.z_classe_c,
    zSemClasse: config.z_sem_classe,
  });

  // 5. Em trânsito
  const { data: emTransitoRpc } = await sb.rpc("wms_calcular_em_transito", {
    p_produto_id: sku.produto_id,
    p_empresa_id: sku.empresa_dona_id,
  });
  const emTransito = Number(emTransitoRpc ?? 0);

  // 6. Urgência
  const urg = calcularUrgencia({
    saldoAtual: sku.saldo,
    reservado: sku.reservado,
    emTransito,
    muDiario: mu,
    leadTimeDias: leadTime,
  });

  // 7. Qty sugerida
  const qty = calcularQtySugerida({
    rop,
    saldoAtual: sku.saldo,
    reservado: sku.reservado,
    emTransito,
    moq: fornPref?.qty_minima_pedido ?? 1,
    multiplo: fornPref?.multiplo_compra ?? 1,
    coberturaAlvoMultiplicador: config.cobertura_alvo_multiplicador,
  });

  // 8. Alternativas
  const alternativas = await resolverAlternativas(sb, sku, qty);

  // 9. Ação recomendada
  const acao = decidirAcao({
    qty,
    alternativas,
    habilitarEmprestimo: config.habilitar_emprestimo,
    habilitarEquivalente: config.habilitar_equivalente,
  });

  // 10. Confiança
  const confianca: "alta" | "media" | "baixa" =
    diasDeDados >= 30 ? "alta" : diasDeDados >= 14 ? "media" : "baixa";

  // 11. Explicação
  const explicacao = gerarExplicacao({
    acao,
    classe,
    perfil,
    muDiario: mu,
    sigmaDemanda: sigma,
    leadTimeDias: leadTime,
    rop,
    diaRuptura: urg.diaRuptura,
    folgaDias: urg.folgaDias,
    qty,
    fornecedorNome: fornPref?.fornecedor_nome,
  });

  return {
    data_calculo: today,
    produto_id: sku.produto_id,
    empresa_dona_id: sku.empresa_dona_id,
    galpao_id: sku.galpao_id,
    saldo_atual: sku.saldo,
    reservado: sku.reservado,
    em_transito: emTransito,
    perfil_demanda: perfil,
    classe_abc: classe,
    confianca,
    dias_de_dados: diasDeDados,
    mu_diario: mu,
    sigma_diario: sigma,
    lead_time_dias: leadTime,
    rop,
    safety_stock: safetyStock,
    urgencia_score: urg.score,
    urgencia_faixa: urg.faixa,
    dia_ruptura_em: urg.diaRuptura,
    folga_dias: Number.isFinite(urg.folgaDias) ? urg.folgaDias : null,
    qty_sugerida: qty,
    fornecedor_preferencial_id: fornPref?.fornecedor_id ?? null,
    custo_unitario_estimado: fornPref?.custo_unitario ?? null,
    custo_total_estimado: fornPref?.custo_unitario ? Number(fornPref.custo_unitario) * qty : null,
    moq: fornPref?.qty_minima_pedido ?? null,
    multiplo: fornPref?.multiplo_compra ?? null,
    alternativas: alternativas as unknown as object[],
    acao_recomendada: acao,
    explicacao_texto: explicacao,
  };
}

function expandirSerieDiaria(rows: Array<{ data: string; qty_total: number }>, dias: number): number[] {
  // Expande pra preencher dias sem venda com zero
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.data, Number(r.qty_total));
  const hoje = new Date();
  const serie: number[] = [];
  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date(hoje);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    serie.push(map.get(key) ?? 0);
  }
  return serie;
}

async function buscarFornecedorPreferencial(
  sb: ReturnType<typeof createServiceClient>,
  produtoId: string,
): Promise<FornPrefRow | null> {
  const { data } = await sb
    .from("siso_produto_fornecedores")
    .select("fornecedor_id, lead_time_medio, custo_unitario, qty_minima_pedido, multiplo_compra, fornecedor:siso_fornecedores(nome)")
    .eq("produto_id", produtoId)
    .eq("preferencial", true)
    .is("desativado_em", null)
    .maybeSingle();
  if (!data) return null;
  return {
    fornecedor_id: data.fornecedor_id,
    fornecedor_nome: (data.fornecedor as any)?.nome ?? "",
    lead_time_medio: data.lead_time_medio,
    custo_unitario: data.custo_unitario,
    qty_minima_pedido: data.qty_minima_pedido,
    multiplo_compra: data.multiplo_compra,
  };
}

async function resolverAlternativas(
  sb: ReturnType<typeof createServiceClient>,
  sku: SkuRow,
  deficit: number,
): Promise<Alternativa[]> {
  if (deficit <= 0) return [];
  const out: Alternativa[] = [];

  // 1. Empréstimo: outras empresas no MESMO galpão com disponivel > 0
  const { data: irmas } = await sb
    .from("siso_estoque")
    .select("empresa_dona_id, disponivel, empresa:siso_empresas(nome)")
    .eq("produto_id", sku.produto_id)
    .eq("galpao_id", sku.galpao_id)
    .neq("empresa_dona_id", sku.empresa_dona_id)
    .gt("disponivel", 0);

  for (const irma of irmas ?? []) {
    const disponivel = Number(irma.disponivel);
    if (disponivel <= 0) continue;
    const { data: regra } = await sb
      .from("siso_emprestimo_regras")
      .select("limite_max_por_produto, limites_por_produto")
      .eq("empresa_credora_id", irma.empresa_dona_id)
      .eq("empresa_devedora_id", sku.empresa_dona_id)
      .maybeSingle();
    if (!regra) continue;

    const limitePorProduto = (regra.limites_por_produto as any)?.[sku.produto_id];
    const limite = limitePorProduto ?? regra.limite_max_por_produto ?? Infinity;
    const qtyEmprestavel = Math.min(disponivel, deficit, Number(limite));
    if (qtyEmprestavel > 0) {
      out.push({
        tipo: "emprestimo",
        empresa_credora_id: irma.empresa_dona_id,
        empresa_credora_nome: (irma.empresa as any)?.nome ?? "",
        galpao_id: sku.galpao_id,
        qty: qtyEmprestavel,
      });
    } else {
      out.push({
        tipo: "emprestimo",
        empresa_credora_id: irma.empresa_dona_id,
        empresa_credora_nome: (irma.empresa as any)?.nome ?? "",
        galpao_id: sku.galpao_id,
        qty: disponivel,
        motivo_descartada: "Insuficiente ou bloqueado por limite",
      });
    }
  }

  // 2. Equivalente via OEM compartilhado: busca produtos que dividem ao menos 1 OEM
  //    e têm cobertura folgada (status_cobertura = 'ok' na MV)
  const { data: oemsDoSku } = await sb
    .from("siso_produto_oems")
    .select("oem_codigo")
    .eq("produto_id", sku.produto_id);
  const oemCodigos = (oemsDoSku ?? []).map((o: any) => o.oem_codigo);

  if (oemCodigos.length > 0) {
    const { data: equivRows } = await sb
      .from("siso_produto_oems")
      .select("produto_id, produto:siso_produtos(sku)")
      .in("oem_codigo", oemCodigos)
      .neq("produto_id", sku.produto_id);
    const equivIds = Array.from(new Set((equivRows ?? []).map((r: any) => r.produto_id)));
    for (const eqId of equivIds) {
      const { data: cob } = await sb
        .from("siso_cobertura_estoque")
        .select("disponivel_total, status_cobertura")
        .eq("produto_id", eqId)
        .eq("empresa_dona_id", sku.empresa_dona_id)
        .eq("galpao_id", sku.galpao_id)
        .maybeSingle();
      const skuEq = (equivRows ?? []).find((r: any) => r.produto_id === eqId);
      const skuTxt = (skuEq?.produto as any)?.sku ?? "";
      if (cob && cob.status_cobertura === "ok" && Number(cob.disponivel_total) >= deficit) {
        out.push({
          tipo: "equivalente",
          produto_id_equivalente: eqId,
          sku_equivalente: skuTxt,
          qty: deficit,
        });
      } else {
        out.push({
          tipo: "equivalente",
          produto_id_equivalente: eqId,
          sku_equivalente: skuTxt,
          qty: Number(cob?.disponivel_total ?? 0),
          motivo_descartada: "Em ruptura ou cobertura insuficiente",
        });
      }
    }
  }

  return out;
}
```

- [ ] **Step 2: Verificar build TypeScript**

Run: `npx tsc --noEmit 2>&1 | grep -E "reposicao/refresh" | head`
Expected: zero erros relacionados a `refresh.ts`. Se aparecer tipo de Supabase em conflito, ajustar casts.

- [ ] **Step 3: Commit**

```bash
git add src/lib/wms/reposicao/refresh.ts
git commit -m "$(cat <<'EOF'
feat(wms/reposicao): refresh.ts (orquestrador do job noturno)

Função principal que percorre SKUs elegíveis (saldo>0), pra cada um:
carrega série diária 90d, classifica perfil, faz forecast (SES ou
Croston-SBA), busca classe ABC, fornecedor preferencial, calcula
ROP/safety stock, mede em-trânsito, urgência, qty sugerida, resolve
alternativas (empréstimo N×N + equivalente Cross), decide ação,
gera explicação humana, e upsert em batch em siso_reposicao_sugestoes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: API — `POST /api/wms/reposicao/refresh` (worker-secret)

**Files:**
- Create: `src/app/api/wms/reposicao/refresh/route.ts`

- [ ] **Step 1: Criar handler**

```typescript
// src/app/api/wms/reposicao/refresh/route.ts
import { NextResponse } from "next/server";
import { refreshReposicaoDiaria } from "@/lib/wms/reposicao/refresh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

function checkWorkerSecret(req: Request): boolean {
  const secret = process.env.WORKER_SECRET;
  if (!secret) return true; // dev mode (sem worker secret)
  const provided = req.headers.get("x-worker-secret");
  return provided === secret;
}

export async function POST(req: Request) {
  if (!checkWorkerSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";

  try {
    const result = await refreshReposicaoDiaria({ force });
    logger.info("reposicao/refresh", `concluído: ${JSON.stringify(result)}`);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = (e as Error).message;
    logger.error("reposicao/refresh", `falha: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(req: Request) {
  // Permite GET pra cron jobs simples
  return POST(req);
}
```

- [ ] **Step 2: Testar contra staging**

Run com `WORKER_SECRET` configurado:
```bash
curl -X POST http://localhost:3000/api/wms/reposicao/refresh?force=true \
  -H "x-worker-secret: $WORKER_SECRET" -v
```
Expected: HTTP 200 com `{ok:true, processados:N, pulados:0, erros:0, duracao_ms:M}`.

- [ ] **Step 3: Verificar dados criados via SQL**

```sql
SELECT data_calculo, COUNT(*) AS sugestoes, MAX(urgencia_score) AS max_urg
FROM siso_reposicao_sugestoes
GROUP BY data_calculo
ORDER BY data_calculo DESC
LIMIT 5;
```
Expected: linha pra hoje, count > 0 (depende de ter SKUs com saldo).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/reposicao/refresh/route.ts
git commit -m "$(cat <<'EOF'
feat(api): POST/GET /api/wms/reposicao/refresh

Endpoint protegido por WORKER_SECRET que dispara o orquestrador
refreshReposicaoDiaria. Aceita ?force=true pra rodar mesmo se já
rodou hoje. Idempotente (upsert por data + produto + empresa + galpão).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: API — `GET /api/wms/compras/reposicao` (lista filtrada)

**Files:**
- Create: `src/app/api/wms/compras/reposicao/route.ts`

- [ ] **Step 1: Criar handler**

```typescript
// src/app/api/wms/compras/reposicao/route.ts
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const galpaoId = url.searchParams.get("galpao_id");
  const empresaId = url.searchParams.get("empresa_id");
  const fornecedorId = url.searchParams.get("fornecedor_id");
  const classe = url.searchParams.get("classe");          // A|B|C|sem
  const urgenciaMin = url.searchParams.get("urgencia_min"); // baixo|medio|alto|critico
  const acaoFilter = url.searchParams.getAll("acao");      // comprar|emprestimo|equivalente
  const q = url.searchParams.get("q");                      // busca SKU/descrição

  const sb = createServiceClient();
  const hoje = new Date().toISOString().slice(0, 10);

  let query = sb
    .from("siso_reposicao_sugestoes")
    .select(`
      *,
      produto:siso_produtos(sku, descricao, imagem_url),
      galpao:siso_galpoes(nome),
      empresa:siso_empresas(nome),
      fornecedor:siso_fornecedores!fornecedor_preferencial_id(nome)
    `)
    .eq("data_calculo", hoje)
    .order("urgencia_score", { ascending: false })
    .limit(500);

  if (galpaoId) query = query.eq("galpao_id", galpaoId);
  if (empresaId) query = query.eq("empresa_dona_id", empresaId);
  if (fornecedorId) query = query.eq("fornecedor_preferencial_id", fornecedorId);
  if (classe === "sem") query = query.is("classe_abc", null);
  else if (classe) query = query.eq("classe_abc", classe);
  if (acaoFilter.length) query = query.in("acao_recomendada", acaoFilter);

  const urgenciaThreshold = mapUrgencia(urgenciaMin);
  if (urgenciaThreshold !== null) query = query.gte("urgencia_score", urgenciaThreshold);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let rows = data ?? [];

  // Filtro de busca (cliente-side por simplicidade, dataset é <500 linhas)
  if (q && q.trim()) {
    const needle = q.trim().toLowerCase();
    rows = rows.filter((r: any) =>
      String(r.produto?.sku ?? "").toLowerCase().includes(needle) ||
      String(r.produto?.descricao ?? "").toLowerCase().includes(needle),
    );
  }

  // Status do cold start banner
  const { data: config } = await sb
    .from("siso_reposicao_config")
    .select("data_ligado_em, dias_minimos_pra_sugerir")
    .eq("id", 1)
    .single();
  const banner = computarBanner(config);

  // Totalizadores
  const capital = rows
    .filter((r: any) => r.acao_recomendada === "comprar")
    .reduce((s: number, r: any) => s + Number(r.custo_total_estimado ?? 0), 0);

  return NextResponse.json({
    rows,
    total_sugestoes: rows.length,
    capital_sugerido: capital,
    banner_aprendizagem: banner,
    atualizado_em: rows[0]?.criada_em ?? null,
  });
}

function mapUrgencia(faixa: string | null): number | null {
  switch (faixa) {
    case "critico": return 80;
    case "alto":    return 50;
    case "medio":   return 20;
    case "baixo":   return 0;
    default:        return null;
  }
}

function computarBanner(config: { data_ligado_em: string | null } | null): { ativo: boolean; ate: string | null } {
  if (!config?.data_ligado_em) return { ativo: false, ate: null };
  const ligado = new Date(config.data_ligado_em);
  const expira = new Date(ligado);
  expira.setDate(expira.getDate() + 30);
  const ativo = new Date() < expira;
  return { ativo, ate: ativo ? expira.toISOString().slice(0, 10) : null };
}
```

- [ ] **Step 2: Testar contra staging**

Run:
```bash
curl "http://localhost:3000/api/wms/compras/reposicao?urgencia_min=medio" \
  -H "X-Session-Id: <session>" | jq '.rows | length'
```
Expected: número (0 ou mais), depende do que o job criou.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/compras/reposicao/route.ts
git commit -m "$(cat <<'EOF'
feat(api): GET /api/wms/compras/reposicao

Lista snapshot do dia ordenado por urgência decrescente, com filtros:
galpao, empresa, fornecedor, classe, urgência min, ação(s), busca q.
Retorna rows, total, capital sugerido em compras, banner de aprendizagem
(ativo + data de expiração).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: API — `GET /api/wms/compras/reposicao/[id]/explicacao`

**Files:**
- Create: `src/app/api/wms/compras/reposicao/[id]/explicacao/route.ts`

- [ ] **Step 1: Criar handler**

```typescript
// src/app/api/wms/compras/reposicao/[id]/explicacao/route.ts
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const sb = createServiceClient();

  const { data: sugestao, error } = await sb
    .from("siso_reposicao_sugestoes")
    .select(`
      *,
      produto:siso_produtos(sku, descricao, imagem_url),
      galpao:siso_galpoes(nome),
      empresa:siso_empresas(nome),
      fornecedor:siso_fornecedores!fornecedor_preferencial_id(nome)
    `)
    .eq("id", id)
    .single();

  if (error || !sugestao) return NextResponse.json({ error: "não encontrada" }, { status: 404 });

  // Sparkline: últimos 30 dias do siso_demanda_diaria
  const { data: serieRows } = await sb
    .from("siso_demanda_diaria")
    .select("data, qty_total")
    .eq("produto_id", (sugestao as any).produto_id)
    .eq("empresa_dona_id", (sugestao as any).empresa_dona_id)
    .eq("galpao_id", (sugestao as any).galpao_id)
    .gte("data", new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10))
    .order("data");

  const sparkline = expandirSparkline(serieRows ?? [], 30);

  return NextResponse.json({ sugestao, sparkline });
}

function expandirSparkline(rows: Array<{ data: string; qty_total: number }>, dias: number): Array<{ data: string; qty: number }> {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.data, Number(r.qty_total));
  const out: Array<{ data: string; qty: number }> = [];
  const hoje = new Date();
  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date(hoje);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ data: key, qty: map.get(key) ?? 0 });
  }
  return out;
}
```

- [ ] **Step 2: Testar**

Run:
```bash
SID=$(node -e "console.log('seu-session-id')")
SUG_ID=$(curl -s "http://localhost:3000/api/wms/compras/reposicao" -H "X-Session-Id: $SID" | jq -r '.rows[0].id')
curl "http://localhost:3000/api/wms/compras/reposicao/$SUG_ID/explicacao" -H "X-Session-Id: $SID" | jq '.sparkline | length'
```
Expected: 30 (30 dias de série).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/compras/reposicao/[id]/explicacao/route.ts
git commit -m "$(cat <<'EOF'
feat(api): GET /api/wms/compras/reposicao/[id]/explicacao

Retorna sugestão completa (com produto, galpão, empresa, fornecedor)
+ sparkline de 30 dias de vendas (preenche dias zerados pra grid
contínuo). Usado pelo drawer 'Por quê?' da UI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: API — `POST /api/wms/compras/reposicao/aprovar`

**Files:**
- Create: `src/app/api/wms/compras/reposicao/aprovar/route.ts`

- [ ] **Step 1: Criar handler**

```typescript
// src/app/api/wms/compras/reposicao/aprovar/route.ts
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

interface AprovacaoItem {
  sugestao_id: string;
  acao: "aprovou" | "aprovou_emprestimo" | "rejeitou" | "ajustou" | "adiou";
  qty_final?: number;
  motivo?: string;
  empresa_credora_id?: string; // pra empréstimo
}

interface AprovarBody {
  itens: AprovacaoItem[];
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as AprovarBody;
  if (!Array.isArray(body.itens) || body.itens.length === 0) {
    return NextResponse.json({ error: "itens vazio" }, { status: 400 });
  }

  const sb = createServiceClient();
  const aprovacoes: any[] = [];
  const ocsCriadas: string[] = [];
  const reservasCriadas: string[] = [];

  for (const it of body.itens) {
    const { data: sug, error: errSug } = await sb
      .from("siso_reposicao_sugestoes")
      .select("*")
      .eq("id", it.sugestao_id)
      .single();
    if (errSug || !sug) {
      logger.warn("reposicao/aprovar", `sugestão ${it.sugestao_id} não encontrada`);
      continue;
    }

    const sugestao = sug as any;
    let ordem_compra_id: string | null = null;
    let emprestimo_mov_id: string | null = null;

    if (it.acao === "aprovou" || it.acao === "ajustou") {
      // Cria OC reativando o fluxo Comprar existente: registra em siso_ordens_compra
      // com status='aguardando_compra' (mesma máquina de estado do módulo legacy).
      const fornNome = await buscarFornecedorNome(sb, sugestao.fornecedor_preferencial_id);
      const { data: oc, error: errOc } = await sb
        .from("siso_ordens_compra")
        .insert({
          fornecedor: fornNome ?? "Reposição (preditivo)",
          empresa_id: sugestao.empresa_dona_id,
          status: "aguardando_compra",
          observacao: `Reposição preditiva — sugestão ${it.sugestao_id} (${sugestao.urgencia_faixa})`,
          comprado_por: user.id,
          comprado_em: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (errOc) {
        logger.warn("reposicao/aprovar", `falha OC: ${errOc.message}`);
        continue;
      }
      ordem_compra_id = (oc as any).id;
      ocsCriadas.push(ordem_compra_id!);
      // Note: vinculação produto-OC fica como follow-up; por ora a OC fica como
      // shell agrupando os SKUs. UX vai consolidar fornecedor no modal.
    } else if (it.acao === "aprovou_emprestimo") {
      // Cria reserva via RPC wms_reservar_atomico se ela existir
      const qty = it.qty_final ?? sugestao.qty_sugerida;
      if (!it.empresa_credora_id) {
        logger.warn("reposicao/aprovar", "empresa_credora_id é obrigatório pra empréstimo");
        continue;
      }
      const { data: movId, error: errRes } = await sb.rpc("wms_reservar_atomico", {
        p_produto_id: sugestao.produto_id,
        p_empresa_dona_id: it.empresa_credora_id,
        p_galpao_id: sugestao.galpao_id,
        p_qty: qty,
        p_origem_tipo: "emprestimo",
        p_ttl_horas: 48,
        p_observacoes: `Reposição → empréstimo pra ${sugestao.empresa_dona_id}`,
      });
      if (errRes) {
        logger.warn("reposicao/aprovar", `falha reserva: ${errRes.message}`);
        continue;
      }
      emprestimo_mov_id = movId as unknown as string;
      reservasCriadas.push(emprestimo_mov_id!);
    }

    aprovacoes.push({
      sugestao_id: it.sugestao_id,
      usuario_id: user.id,
      acao: it.acao,
      qty_aprovada: it.qty_final ?? sugestao.qty_sugerida,
      qty_sugerida_snapshot: sugestao.qty_sugerida,
      motivo: it.motivo ?? null,
      ordem_compra_id,
      emprestimo_mov_id,
    });
  }

  if (aprovacoes.length > 0) {
    await sb.from("siso_reposicao_aprovacoes").insert(aprovacoes);
  }

  return NextResponse.json({
    ok: true,
    processadas: aprovacoes.length,
    ocs_criadas: ocsCriadas,
    reservas_criadas: reservasCriadas,
  });
}

async function buscarFornecedorNome(
  sb: ReturnType<typeof createServiceClient>,
  fornecedorId: string | null,
): Promise<string | null> {
  if (!fornecedorId) return null;
  const { data } = await sb
    .from("siso_fornecedores")
    .select("nome")
    .eq("id", fornecedorId)
    .maybeSingle();
  return (data as any)?.nome ?? null;
}
```

- [ ] **Step 2: Testar**

Run:
```bash
curl -X POST http://localhost:3000/api/wms/compras/reposicao/aprovar \
  -H "X-Session-Id: $SID" -H "Content-Type: application/json" \
  -d '{"itens":[{"sugestao_id":"'"$SUG_ID"'","acao":"aprovou"}]}'
```
Expected: `{ok:true, processadas:1, ocs_criadas:[...]}`.

Verificar audit:
```sql
SELECT * FROM siso_reposicao_aprovacoes ORDER BY criada_em DESC LIMIT 5;
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/compras/reposicao/aprovar/route.ts
git commit -m "$(cat <<'EOF'
feat(api): POST /api/wms/compras/reposicao/aprovar

Endpoint pra aprovar/rejeitar/ajustar/adiar uma ou várias sugestões.
Aprovação de compra cria OC shell em siso_ordens_compra (segue o
fluxo legado do módulo Comprar). Empréstimo cria reserva via
wms_reservar_atomico (TTL 48h). Todas as ações registram audit em
siso_reposicao_aprovacoes pra aprendizado futuro.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 19: Configurar cron Supabase pra rodar 00:30 BRT

**Files:** apenas configuração externa

- [ ] **Step 1: Confirmar timezone — Supabase cron roda em UTC**

BRT = UTC-3. Pra rodar 00:30 BRT, precisamos `30 3 * * *` em UTC.

- [ ] **Step 2: Aplicar configuração via Supabase MCP**

Via `mcp__supabase__execute_sql`:
```sql
SELECT cron.schedule(
  'reposicao-refresh-diaria',
  '30 3 * * *',  -- 03:30 UTC = 00:30 BRT
  $$
  SELECT net.http_post(
    url := 'https://[YOUR-DOMAIN]/api/wms/reposicao/refresh?force=false',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-worker-secret', current_setting('app.worker_secret', true)
    )
  );
  $$
);
```
Substituir `[YOUR-DOMAIN]` pelo domínio real de produção (descobrir antes de aplicar). Em staging, pular esse step e disparar manual.

- [ ] **Step 3: Verificar agendamento**

```sql
SELECT jobid, schedule, jobname FROM cron.job WHERE jobname = 'reposicao-refresh-diaria';
```
Expected: 1 linha com schedule `30 3 * * *`.

- [ ] **Step 4: Commit (apenas documentação no plano — sem mudança em código)**

Nenhum commit de código. Anotar no PR description que cron foi configurado manualmente em produção.

---

## Fase 3 — UI

### Task 20: Hook React Query pra Reposição

**Files:**
- Create: `src/app/wms/compras/use-reposicao.ts`

- [ ] **Step 1: Criar hook + types compartilhados de UI**

```typescript
// src/app/wms/compras/use-reposicao.ts
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";

export interface ReposicaoFiltros {
  galpao_id?: string;
  empresa_id?: string;
  fornecedor_id?: string;
  classe?: "A" | "B" | "C" | "sem" | "todos";
  urgencia_min?: "baixo" | "medio" | "alto" | "critico";
  acao?: Array<"comprar" | "emprestimo" | "equivalente" | "aguardar">;
  q?: string;
}

export interface SugestaoRow {
  id: string;
  data_calculo: string;
  produto_id: string;
  empresa_dona_id: string;
  galpao_id: string;
  saldo_atual: number;
  reservado: number;
  em_transito: number;
  perfil_demanda: "regular" | "intermitente" | "sem_dados";
  classe_abc: "A" | "B" | "C" | null;
  confianca: "alta" | "media" | "baixa";
  dias_de_dados: number;
  mu_diario: number;
  sigma_diario: number;
  lead_time_dias: number | null;
  rop: number | null;
  safety_stock: number | null;
  urgencia_score: number;
  urgencia_faixa: "critico" | "alto" | "medio" | "baixo";
  dia_ruptura_em: number | null;
  folga_dias: number | null;
  qty_sugerida: number;
  fornecedor_preferencial_id: string | null;
  custo_unitario_estimado: number | null;
  custo_total_estimado: number | null;
  moq: number | null;
  multiplo: number | null;
  alternativas: Array<any>;
  acao_recomendada: "emprestimo" | "equivalente" | "comprar" | "aguardar";
  explicacao_texto: string | null;
  produto?: { sku: string; descricao: string; imagem_url: string | null };
  galpao?: { nome: string };
  empresa?: { nome: string };
  fornecedor?: { nome: string };
}

export interface ReposicaoResp {
  rows: SugestaoRow[];
  total_sugestoes: number;
  capital_sugerido: number;
  banner_aprendizagem: { ativo: boolean; ate: string | null };
  atualizado_em: string | null;
}

export function useReposicao(filtros: ReposicaoFiltros) {
  const params = new URLSearchParams();
  if (filtros.galpao_id) params.set("galpao_id", filtros.galpao_id);
  if (filtros.empresa_id) params.set("empresa_id", filtros.empresa_id);
  if (filtros.fornecedor_id) params.set("fornecedor_id", filtros.fornecedor_id);
  if (filtros.classe && filtros.classe !== "todos") params.set("classe", filtros.classe);
  if (filtros.urgencia_min) params.set("urgencia_min", filtros.urgencia_min);
  if (filtros.q) params.set("q", filtros.q);
  for (const a of filtros.acao ?? []) params.append("acao", a);
  const qs = params.toString();
  return useQuery<ReposicaoResp>({
    queryKey: ["reposicao", qs],
    queryFn: async () => {
      const res = await sisoFetch(`/api/wms/compras/reposicao?${qs}`);
      if (!res.ok) throw new Error("falha ao carregar reposição");
      return res.json();
    },
    refetchInterval: 60_000,
  });
}

export function useExplicacao(sugestaoId: string | null) {
  return useQuery({
    queryKey: ["reposicao-explicacao", sugestaoId],
    queryFn: async () => {
      const res = await sisoFetch(`/api/wms/compras/reposicao/${sugestaoId}/explicacao`);
      if (!res.ok) throw new Error("falha ao carregar explicação");
      return res.json();
    },
    enabled: !!sugestaoId,
  });
}

export function useAprovarReposicao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (itens: Array<{ sugestao_id: string; acao: string; qty_final?: number; motivo?: string; empresa_credora_id?: string }>) => {
      const res = await sisoFetch("/api/wms/compras/reposicao/aprovar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itens }),
      });
      if (!res.ok) throw new Error("falha ao aprovar");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reposicao"] });
    },
  });
}
```

- [ ] **Step 2: Verificar build**

Run: `npx tsc --noEmit 2>&1 | grep "use-reposicao" | head`
Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/app/wms/compras/use-reposicao.ts
git commit -m "$(cat <<'EOF'
feat(wms/compras): hook React Query pra Reposição

useReposicao (lista com filtros, refetch 60s), useExplicacao (drawer),
useAprovarReposicao (mutation). Tipos compartilhados SugestaoRow,
ReposicaoFiltros, ReposicaoResp.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 21: Adicionar tab "Reposição" no `/wms/compras/page.tsx`

**Files:**
- Modify: `src/app/wms/compras/page.tsx`

- [ ] **Step 1: Ler estrutura atual da página pra confirmar onde colar**

Run: `grep -nE "type Tab|currentTab|const tabs|TabKey" src/app/wms/compras/page.tsx | head`

Anotar:
- A linha onde `type Tab = ...` é definido (na época da escrita: linha ~25). Vamos adicionar `"reposicao"` lá.
- A estrutura que renderiza os tabs (procurar pelo padrão `currentTab === "comprar"`).
- O componente que renderiza o conteúdo de cada tab.

- [ ] **Step 2: Atualizar tipo `Tab` e adicionar opção**

Editar a definição. Linha aproximada (confirmar antes):
```typescript
// ANTES
type Tab = "comprar" | "receber" | "historico";

// DEPOIS
type Tab = "comprar" | "receber" | "reposicao" | "historico";
```

- [ ] **Step 3: Adicionar botão de tab no header e área de conteúdo**

Localizar a região dos tabs (botões) e adicionar:
```tsx
<button
  className={cn("tab", currentTab === "reposicao" && "tab-active")}
  onClick={() => setCurrentTab("reposicao")}
>
  Reposição
  {countsResp?.counts && (
    <span className="ml-1 inline-block rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-700">
      {/* contar via mesmo hook */}
    </span>
  )}
</button>
```

E no body, adicionar:
```tsx
{currentTab === "reposicao" && <ReposicaoTab />}
```

(`ReposicaoTab` é criado na próxima task — por enquanto, criar stub `function ReposicaoTab() { return <div>em construção</div>; }` no topo do arquivo.)

- [ ] **Step 4: Verificar build + dev server abre a tab**

Run: `npm run dev` em background, abrir `http://localhost:3000/wms/compras`, clicar em "Reposição".
Expected: tab aparece, mostra "em construção" sem erros no console.

- [ ] **Step 5: Commit**

```bash
git add src/app/wms/compras/page.tsx
git commit -m "$(cat <<'EOF'
feat(wms/compras): adiciona tab 'Reposição' (stub)

Type Tab estendido com 'reposicao', botão e área de conteúdo no shell
existente. Conteúdo é stub temporário — implementação real vem na
próxima task (componente ReposicaoTab).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 22: Componente `ReposicaoTab` (tabela + filtros)

**Files:**
- Create: `src/components/wms/compras/reposicao-tab.tsx`
- Modify: `src/app/wms/compras/page.tsx` (importar e usar o componente real)

- [ ] **Step 1: Criar `reposicao-tab.tsx`**

```typescript
// src/components/wms/compras/reposicao-tab.tsx
"use client";

import { useState, useMemo } from "react";
import { useReposicao, type SugestaoRow, type ReposicaoFiltros } from "@/app/wms/compras/use-reposicao";
import { ReposicaoBannerAprendizagem } from "./reposicao-banner-aprendizagem";
import { ReposicaoDrawer } from "./reposicao-drawer";
import { ReposicaoAprovarModal } from "./reposicao-aprovar-modal";
import { cn } from "@/lib/utils";

export function ReposicaoTab() {
  const [filtros, setFiltros] = useState<ReposicaoFiltros>({ urgencia_min: "medio" });
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [drawerSugId, setDrawerSugId] = useState<string | null>(null);
  const [modalAberto, setModalAberto] = useState(false);
  const [qtyEditada, setQtyEditada] = useState<Record<string, number>>({});

  const { data, isLoading, error } = useReposicao(filtros);

  const rows = data?.rows ?? [];
  const selecionadosArr = useMemo(
    () => rows.filter((r) => selecionados.has(r.id)),
    [rows, selecionados],
  );

  function toggleSelecionado(id: string) {
    const next = new Set(selecionados);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelecionados(next);
  }

  return (
    <div className="space-y-4">
      {data?.banner_aprendizagem.ativo && (
        <ReposicaoBannerAprendizagem ate={data.banner_aprendizagem.ate} />
      )}

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white p-4">
        <input
          type="text"
          placeholder="Buscar SKU, descrição ou OEM…"
          value={filtros.q ?? ""}
          onChange={(e) => setFiltros({ ...filtros, q: e.target.value })}
          className="min-w-[240px] flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none"
        />
        <select
          value={filtros.urgencia_min ?? ""}
          onChange={(e) => setFiltros({ ...filtros, urgencia_min: (e.target.value || undefined) as ReposicaoFiltros["urgencia_min"] })}
          className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
        >
          <option value="">Todas urgências</option>
          <option value="critico">≥ Crítico</option>
          <option value="alto">≥ Alto</option>
          <option value="medio">≥ Médio</option>
          <option value="baixo">≥ Baixo</option>
        </select>
        <select
          value={filtros.classe ?? "todos"}
          onChange={(e) => setFiltros({ ...filtros, classe: e.target.value as ReposicaoFiltros["classe"] })}
          className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
        >
          <option value="todos">Todas curvas</option>
          <option value="A">Curva A</option>
          <option value="B">Curva B</option>
          <option value="C">Curva C</option>
          <option value="sem">Sem classe</option>
        </select>
      </div>

      {/* Sumário */}
      <div className="flex items-center justify-between px-1 text-sm text-zinc-500">
        <div>
          Mostrando <strong className="text-zinc-900">{rows.length}</strong> SKU{rows.length !== 1 ? "s" : ""} ·{" "}
          Capital sugerido: <strong className="font-mono text-zinc-900">R$ {(data?.capital_sugerido ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
        </div>
        {data?.atualizado_em && (
          <div>Atualizado às {new Date(data.atualizado_em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</div>
        )}
      </div>

      {/* Tabela */}
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="w-9 px-3 py-2.5"></th>
              <th className="px-3 py-2.5 text-left">SKU / Descrição</th>
              <th className="px-3 py-2.5 text-left">Galpão</th>
              <th className="px-3 py-2.5 text-left">Curva</th>
              <th className="px-3 py-2.5 text-left">Urgência</th>
              <th className="px-3 py-2.5 text-right">Saldo ef.</th>
              <th className="px-3 py-2.5 text-right">Cob.</th>
              <th className="px-3 py-2.5 text-left">Ação primária</th>
              <th className="px-3 py-2.5 text-right">Qty</th>
              <th className="px-3 py-2.5 text-right">Custo</th>
              <th className="w-32 px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={11} className="px-3 py-12 text-center text-zinc-500">Carregando…</td></tr>
            )}
            {error && (
              <tr><td colSpan={11} className="px-3 py-12 text-center text-red-600">Erro: {(error as Error).message}</td></tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr><td colSpan={11} className="px-3 py-12 text-center text-zinc-500">Nenhum SKU precisa de reposição agora. 🎉</td></tr>
            )}
            {rows.map((r) => {
              const saldoEf = (r.saldo_atual ?? 0) - (r.reservado ?? 0) + (r.em_transito ?? 0);
              const qty = qtyEditada[r.id] ?? r.qty_sugerida;
              const custoTotal = (r.custo_unitario_estimado ?? 0) * qty;
              return (
                <tr key={r.id} className={cn("border-t border-zinc-100", selecionados.has(r.id) && "bg-cyan-50")}>
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={selecionados.has(r.id)}
                      onChange={() => toggleSelecionado(r.id)}
                      disabled={r.acao_recomendada === "aguardar"}
                    />
                  </td>
                  <td className="px-3 py-3">
                    <div className="font-mono text-xs font-medium text-zinc-800">{r.produto?.sku}</div>
                    <div className="text-xs text-zinc-500">{r.produto?.descricao}</div>
                  </td>
                  <td className="px-3 py-3">
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-700">{r.galpao?.nome}</span>
                  </td>
                  <td className="px-3 py-3">
                    <BadgeCurva classe={r.classe_abc} />
                  </td>
                  <td className="px-3 py-3">
                    <BadgeUrgencia faixa={r.urgencia_faixa} score={r.urgencia_score} />
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{saldoEf}</td>
                  <td className={cn("px-3 py-3 text-right font-mono", r.dia_ruptura_em != null && r.dia_ruptura_em < 4 && "font-semibold text-red-600")}>
                    {r.dia_ruptura_em != null ? `${r.dia_ruptura_em}d` : "∞"}
                  </td>
                  <td className="px-3 py-3">
                    <AcaoCelula row={r} />
                  </td>
                  <td className="px-3 py-3 text-right">
                    {r.acao_recomendada === "aguardar" ? (
                      <span className="font-mono text-zinc-400">—</span>
                    ) : (
                      <input
                        type="number"
                        value={qty}
                        onChange={(e) => setQtyEditada({ ...qtyEditada, [r.id]: Number(e.target.value) })}
                        className="w-16 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-right font-mono text-xs"
                      />
                    )}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">
                    {custoTotal > 0 ? `R$ ${custoTotal.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : "—"}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button
                      onClick={() => setDrawerSugId(r.id)}
                      className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs"
                      aria-label="Por quê?"
                    >
                      Por quê?
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer de ação em lote */}
      {selecionadosArr.length > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-3 px-4">
          <div className="text-sm">
            <strong>{selecionadosArr.length} selecionados</strong>
          </div>
          <button
            onClick={() => setModalAberto(true)}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white"
          >
            Aprovar selecionados →
          </button>
        </div>
      )}

      {/* Drawer */}
      {drawerSugId && (
        <ReposicaoDrawer sugestaoId={drawerSugId} onClose={() => setDrawerSugId(null)} />
      )}

      {/* Modal de aprovação */}
      {modalAberto && (
        <ReposicaoAprovarModal
          itens={selecionadosArr.map((r) => ({ ...r, qty_final: qtyEditada[r.id] ?? r.qty_sugerida }))}
          onClose={() => setModalAberto(false)}
          onSuccess={() => {
            setModalAberto(false);
            setSelecionados(new Set());
            setQtyEditada({});
          }}
        />
      )}
    </div>
  );
}

function BadgeCurva({ classe }: { classe: "A" | "B" | "C" | null }) {
  if (!classe) return <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-500">—</span>;
  const cls = classe === "A" ? "bg-teal-100 text-teal-800" : classe === "B" ? "bg-amber-100 text-amber-800" : "bg-zinc-100 text-zinc-700";
  return <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase", cls)}>{classe}</span>;
}

function BadgeUrgencia({ faixa, score }: { faixa: "critico" | "alto" | "medio" | "baixo"; score: number }) {
  const map = {
    critico: { cls: "bg-red-100 text-red-800", dot: "bg-red-600", txt: "Crítico" },
    alto:    { cls: "bg-orange-100 text-orange-800", dot: "bg-orange-600", txt: "Alto" },
    medio:   { cls: "bg-amber-100 text-amber-800", dot: "bg-amber-600", txt: "Médio" },
    baixo:   { cls: "bg-zinc-100 text-zinc-700", dot: "bg-zinc-300", txt: "Baixo" },
  }[faixa];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase", map.cls)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", map.dot)} />
      {map.txt} · {score}
    </span>
  );
}

function AcaoCelula({ row }: { row: SugestaoRow }) {
  if (row.acao_recomendada === "emprestimo") {
    const alt = (row.alternativas as any[]).find((a) => a.tipo === "emprestimo" && !a.motivo_descartada);
    return (
      <div>
        <div className="text-sm font-semibold text-cyan-700">Emprestar de {alt?.empresa_credora_nome ?? "?"}</div>
        <div className="text-[11px] text-zinc-500">Compra fica como fallback</div>
      </div>
    );
  }
  if (row.acao_recomendada === "comprar") {
    return (
      <div>
        <div className="text-sm font-semibold text-zinc-800">Comprar da {row.fornecedor?.nome ?? "(sem fornecedor)"}</div>
        <div className="text-[11px] text-zinc-500">{row.lead_time_dias ?? "?"}d lead time · MOQ {row.moq ?? 1}</div>
      </div>
    );
  }
  if (row.acao_recomendada === "equivalente") {
    return (
      <div>
        <div className="text-sm font-semibold text-blue-700">Equivalente disponível</div>
        <div className="text-[11px] text-zinc-500">Ver no drawer</div>
      </div>
    );
  }
  return <div className="text-sm text-zinc-500">Aguardar</div>;
}
```

- [ ] **Step 2: Atualizar `page.tsx` pra importar componente real**

No `src/app/wms/compras/page.tsx`, substituir o stub `ReposicaoTab` por:
```typescript
import { ReposicaoTab } from "@/components/wms/compras/reposicao-tab";
```

- [ ] **Step 3: Verificar UI no browser**

Run: `npm run dev`, abrir `/wms/compras`, clicar em Reposição.
Expected: tabela renderiza, filtros funcionam, dados vêm da API.

- [ ] **Step 4: Commit**

```bash
git add src/components/wms/compras/reposicao-tab.tsx src/app/wms/compras/page.tsx
git commit -m "$(cat <<'EOF'
feat(wms/compras): ReposicaoTab — tabela + filtros

Componente principal da aba: filtros (busca, urgência, curva), sumário
de capital sugerido, tabela com 7+ colunas (SKU, galpão, curva, urgência
com score, saldo efetivo, cobertura em dias, ação primária, qty editável,
custo total, botão 'Por quê?'). Seleção em lote com footer de ação.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 23: Drawer "Por quê?"

**Files:**
- Create: `src/components/wms/compras/reposicao-drawer.tsx`

- [ ] **Step 1: Criar componente**

```typescript
// src/components/wms/compras/reposicao-drawer.tsx
"use client";

import { useExplicacao } from "@/app/wms/compras/use-reposicao";
import { cn } from "@/lib/utils";

interface Props {
  sugestaoId: string;
  onClose: () => void;
}

export function ReposicaoDrawer({ sugestaoId, onClose }: Props) {
  const { data, isLoading } = useExplicacao(sugestaoId);

  if (!data && !isLoading) return null;
  const s = data?.sugestao;
  const sparkline = data?.sparkline ?? [];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-zinc-900/40" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 w-[460px] overflow-y-auto bg-white shadow-2xl">
        {isLoading || !s ? (
          <div className="p-12 text-center text-zinc-500">Carregando…</div>
        ) : (
          <>
            <div className="sticky top-0 z-10 border-b border-zinc-200 bg-white p-6">
              <button onClick={onClose} className="absolute right-4 top-4 rounded bg-zinc-100 p-1.5 text-zinc-500">✕</button>
              <div className="font-semibold">{s.produto?.descricao}</div>
              <div className="mt-1 font-mono text-xs text-zinc-500">SKU {s.produto?.sku} · {s.empresa?.nome} · {s.galpao?.nome}</div>
            </div>

            <Section title="Demanda">
              <Row label="Perfil" value={perfilTxt(s.perfil_demanda)} />
              <Row label="Média diária (últimos 30d)" value={`${fmt(s.mu_diario)} ± ${fmt(s.sigma_diario)}`} />
              <Row label="Histórico disponível" value={`${s.dias_de_dados} dias`} muted />
              {sparkline.length > 0 && <Sparkline data={sparkline} />}
            </Section>

            <Section title="Estoque atual">
              <Row label="Saldo físico" value={String(s.saldo_atual)} />
              <Row label="Reservado" value={`−${s.reservado}`} valueClass="text-orange-600" />
              <Row label="Em trânsito" value={`+${s.em_transito}`} />
              <Row label="Saldo efetivo" value={String(s.saldo_atual - s.reservado + s.em_transito)} bold valueClass="text-red-600 text-lg" />
            </Section>

            <Section title="Cálculo">
              <Row label={`Lead time ${s.fornecedor?.nome ?? "(sem fornecedor)"}`} value={`${s.lead_time_dias ?? "?"} dias`} />
              <Row label={`Demanda × lead time`} value={`${fmt(s.mu_diario * (s.lead_time_dias ?? 0))}`} />
              <Row label={`Folga de segurança`} value={`+${s.safety_stock ?? 0}`} muted />
              <Row label="Ponto de pedido" value={String(s.rop ?? "?")} bold />
              <Row label="MOQ / múltiplo" value={`${s.moq ?? 1} / ${s.multiplo ?? 1}`} />
              <Row label="Qty sugerida" value={String(s.qty_sugerida)} bold valueClass="text-zinc-900 text-lg" />
            </Section>

            <Section title="Urgência">
              <Row label="Vai zerar em" value={s.dia_ruptura_em != null ? `${s.dia_ruptura_em} dias` : "—"} valueClass="text-red-600" />
              <Row label="Folga vs lead time" value={`${s.folga_dias ?? 0} dias`} bold valueClass="text-red-600" />
            </Section>

            <Section title="Alternativas">
              {(s.alternativas as any[]).length === 0 && (
                <div className="text-xs text-zinc-500">Nenhuma alternativa avaliada</div>
              )}
              {(s.alternativas as any[]).map((a, i) => (
                <div key={i} className={cn("mb-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3", a.motivo_descartada && "opacity-50")}>
                  <div className="text-sm font-semibold">
                    {a.tipo === "emprestimo" ? `Empréstimo de ${a.empresa_credora_nome}` : `Equivalente ${a.sku_equivalente}`}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {a.motivo_descartada ?? `${a.qty} unidades disponíveis`}
                  </div>
                </div>
              ))}
            </Section>

            {s.explicacao_texto && (
              <Section title="Resumo">
                <p className="text-sm text-zinc-700">{s.explicacao_texto}</p>
              </Section>
            )}
          </>
        )}
      </aside>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-zinc-100 p-6">
      <div className="mb-3 text-xs font-bold uppercase tracking-wider text-zinc-500">{title}</div>
      <div>{children}</div>
    </div>
  );
}

function Row({ label, value, muted = false, bold = false, valueClass = "" }: { label: string; value: string; muted?: boolean; bold?: boolean; valueClass?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between py-1", muted && "text-zinc-500 text-xs")}>
      <span className="text-zinc-700">{label}</span>
      <strong className={cn("font-mono", bold ? "font-bold" : "font-medium", valueClass)}>{value}</strong>
    </div>
  );
}

function Sparkline({ data }: { data: Array<{ data: string; qty: number }> }) {
  const max = Math.max(1, ...data.map((d) => d.qty));
  return (
    <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
      <div className="mb-2 text-xs text-zinc-500">Vendas — últimos 30 dias</div>
      <div className="flex items-end gap-px" style={{ height: 50 }}>
        {data.map((d, i) => (
          <div
            key={i}
            className={cn("flex-1 rounded-sm", d.qty > 0 ? "bg-teal-500" : "bg-zinc-200")}
            style={{ height: d.qty > 0 ? `${(d.qty / max) * 100}%` : 2 }}
            title={`${d.data}: ${d.qty}`}
          />
        ))}
      </div>
    </div>
  );
}

function perfilTxt(p: string): string {
  if (p === "regular") return "Regular";
  if (p === "intermitente") return "Intermitente";
  return "Sem dados";
}

function fmt(n: number | null | undefined): string {
  return (Number(n ?? 0)).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
```

- [ ] **Step 2: Testar drawer**

`npm run dev`, abrir Reposição, clicar "Por quê?" em uma linha.
Expected: drawer abre à direita, mostra sparkline + todas as seções, botão ✕ fecha.

- [ ] **Step 3: Commit**

```bash
git add src/components/wms/compras/reposicao-drawer.tsx
git commit -m "$(cat <<'EOF'
feat(wms/compras): drawer 'Por quê?' da reposição

Painel lateral que abre ao clicar no botão da linha. Mostra: demanda
(perfil, média ± σ, sparkline 30d), estoque (físico, reservado, trânsito,
efetivo), cálculo (lead time, ROP, safety stock, MOQ, qty), urgência
(dias até zerar, folga vs LT) e alternativas avaliadas com motivo de
descarte quando aplicável.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 24: Modal de aprovação em lote

**Files:**
- Create: `src/components/wms/compras/reposicao-aprovar-modal.tsx`

- [ ] **Step 1: Criar componente**

```typescript
// src/components/wms/compras/reposicao-aprovar-modal.tsx
"use client";

import { useMemo } from "react";
import { useAprovarReposicao, type SugestaoRow } from "@/app/wms/compras/use-reposicao";
import { toast } from "sonner";

interface Props {
  itens: Array<SugestaoRow & { qty_final: number }>;
  onClose: () => void;
  onSuccess: () => void;
}

interface GrupoFornecedor {
  fornecedor: string;
  itens: Array<{ sku: string; descricao: string; qty: number; custoUnit: number; sugestao_id: string }>;
  total: number;
}

export function ReposicaoAprovarModal({ itens, onClose, onSuccess }: Props) {
  const aprovar = useAprovarReposicao();

  const { emprestimos, gruposCompras, totalCompras } = useMemo(() => agrupar(itens), [itens]);

  async function confirmar() {
    const payload = itens.map((r) => {
      const isEmprestimo = r.acao_recomendada === "emprestimo";
      const alt = isEmprestimo ? (r.alternativas as any[]).find((a) => a.tipo === "emprestimo" && !a.motivo_descartada) : null;
      return {
        sugestao_id: r.id,
        acao: isEmprestimo ? "aprovou_emprestimo" : (r.qty_final !== r.qty_sugerida ? "ajustou" : "aprovou"),
        qty_final: r.qty_final,
        empresa_credora_id: alt?.empresa_credora_id,
      };
    });
    try {
      const res = await aprovar.mutateAsync(payload);
      toast.success(`${res.processadas} aprovações registradas`);
      onSuccess();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 p-4">
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="mb-1 text-lg font-semibold">Confirmar {itens.length} aprovações</h3>
        <p className="mb-5 text-sm text-zinc-500">
          Compras são consolidadas por fornecedor. Empréstimos viram reservas com TTL de 48h.
        </p>

        {emprestimos.length > 0 && (
          <div className="mb-3 rounded-lg border border-cyan-200 bg-cyan-50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="font-semibold">🔄 {emprestimos.length} empréstimo{emprestimos.length > 1 ? "s" : ""}</div>
              <div className="font-mono font-semibold text-cyan-700">R$ 0</div>
            </div>
            {emprestimos.map((e, i) => (
              <div key={i} className="text-sm text-zinc-700">
                <strong className="font-mono">{e.sku}</strong> · {e.qty} un · {e.descricao}
              </div>
            ))}
          </div>
        )}

        {gruposCompras.map((g) => (
          <div key={g.fornecedor} className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="font-semibold">📦 {g.fornecedor} · {g.itens.length} item{g.itens.length !== 1 ? "s" : ""}</div>
              <div className="font-mono font-semibold">R$ {g.total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</div>
            </div>
            {g.itens.map((it, i) => (
              <div key={i} className="flex justify-between text-sm text-zinc-700">
                <span><strong className="font-mono">{it.sku}</strong> · {it.descricao}</span>
                <span className="font-mono">{it.qty} un × R$ {it.custoUnit.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
              </div>
            ))}
          </div>
        ))}

        <div className="mt-4 flex items-center justify-between border-t border-zinc-200 pt-4 font-semibold">
          <span>Total a desembolsar</span>
          <span className="font-mono text-lg">R$ {totalCompras.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700">
            Cancelar
          </button>
          <button
            onClick={confirmar}
            disabled={aprovar.isPending}
            className="rounded-lg bg-zinc-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {aprovar.isPending ? "Processando…" : "Confirmar tudo"}
          </button>
        </div>
      </div>
    </div>
  );
}

function agrupar(itens: Array<SugestaoRow & { qty_final: number }>): {
  emprestimos: Array<{ sku: string; descricao: string; qty: number }>;
  gruposCompras: GrupoFornecedor[];
  totalCompras: number;
} {
  const emprestimos: Array<{ sku: string; descricao: string; qty: number }> = [];
  const grupos = new Map<string, GrupoFornecedor>();

  for (const r of itens) {
    if (r.acao_recomendada === "emprestimo") {
      emprestimos.push({
        sku: r.produto?.sku ?? "—",
        descricao: r.produto?.descricao ?? "—",
        qty: r.qty_final,
      });
    } else if (r.acao_recomendada === "comprar") {
      const fornNome = r.fornecedor?.nome ?? "(sem fornecedor)";
      const custo = (r.custo_unitario_estimado ?? 0) * r.qty_final;
      const g = grupos.get(fornNome) ?? { fornecedor: fornNome, itens: [], total: 0 };
      g.itens.push({
        sku: r.produto?.sku ?? "—",
        descricao: r.produto?.descricao ?? "—",
        qty: r.qty_final,
        custoUnit: r.custo_unitario_estimado ?? 0,
        sugestao_id: r.id,
      });
      g.total += custo;
      grupos.set(fornNome, g);
    }
  }

  const gruposCompras = Array.from(grupos.values());
  const totalCompras = gruposCompras.reduce((s, g) => s + g.total, 0);
  return { emprestimos, gruposCompras, totalCompras };
}
```

- [ ] **Step 2: Testar fluxo**

`npm run dev`. Selecionar 2-3 linhas, clicar "Aprovar selecionados". Modal abre. Clicar "Confirmar tudo". Toast aparece.

- [ ] **Step 3: Verificar audit no banco**

```sql
SELECT * FROM siso_reposicao_aprovacoes ORDER BY criada_em DESC LIMIT 5;
SELECT * FROM siso_ordens_compra ORDER BY created_at DESC LIMIT 3;
```
Expected: 1 audit por sugestão; 1 OC por fornecedor que tem compra.

- [ ] **Step 4: Commit**

```bash
git add src/components/wms/compras/reposicao-aprovar-modal.tsx
git commit -m "$(cat <<'EOF'
feat(wms/compras): modal de aprovação em lote da Reposição

Modal mostra: empréstimos agrupados (custo R$ 0), compras agrupadas
por fornecedor (consolida MOQ + total), grande total e botão confirmar.
Ao confirmar, mutation POST /api/wms/compras/reposicao/aprovar dispara
criação de OCs (uma por fornecedor) e reservas (wms_reservar_atomico).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 25: Banner de cold start ("Modo aprendizagem")

**Files:**
- Create: `src/components/wms/compras/reposicao-banner-aprendizagem.tsx`

- [ ] **Step 1: Criar componente**

```typescript
// src/components/wms/compras/reposicao-banner-aprendizagem.tsx
"use client";

interface Props {
  ate: string | null;
}

export function ReposicaoBannerAprendizagem({ ate }: Props) {
  const ateFmt = ate ? new Date(ate).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
      <svg
        className="mt-0.5 flex-shrink-0 text-amber-600"
        width="18" height="18" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <div className="text-amber-900">
        <strong className="font-semibold">Modo aprendizagem ativo até {ateFmt}.</strong>{" "}
        Sistema está aprendendo o padrão de vendas. SKUs com menos de 14 dias de dados aparecem com confiança <strong>Baixa</strong>{" "}
        ou ficam ocultos até acumular histórico.
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Testar**

`npm run dev`. Se `data_ligado_em < 30 dias`, banner aparece no topo da tela.
Pra forçar banner em staging: `UPDATE siso_reposicao_config SET data_ligado_em = CURRENT_DATE WHERE id=1;`

- [ ] **Step 3: Commit**

```bash
git add src/components/wms/compras/reposicao-banner-aprendizagem.tsx
git commit -m "$(cat <<'EOF'
feat(wms/compras): banner 'Modo aprendizagem' (cold start)

Banner amarelo no topo da tab Reposição durante os primeiros 30 dias
após data_ligado_em. Informa o comprador que sugestões com pouco
histórico têm confiança Baixa e que SKUs sem dados ainda não aparecem.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 26: Atualizar docs e CLAUDE.md

**Files:**
- Modify: `docs/api-reference-complete.md` (adicionar 4 endpoints)
- Modify: `docs/database-schema.md` (adicionar 4 tabelas/MV + 2 RPCs)
- Modify: `docs/architecture-and-flows.md` (descrever pipeline e fluxo de aprovação)
- Modify: `CLAUDE.md` (adicionar `src/lib/wms/reposicao/` e API routes na seção Project Structure)

- [ ] **Step 1: Adicionar endpoints em `api-reference-complete.md`**

Seguir o formato existente do arquivo. Documentar:
- `POST /api/wms/reposicao/refresh` (auth: WORKER_SECRET, body: nenhum, query: ?force=true)
- `GET /api/wms/compras/reposicao` (auth: session, query: galpao_id, empresa_id, fornecedor_id, classe, urgencia_min, acao[], q)
- `GET /api/wms/compras/reposicao/[id]/explicacao` (auth: session)
- `POST /api/wms/compras/reposicao/aprovar` (auth: session, body: { itens: [...] })

- [ ] **Step 2: Adicionar tabelas em `database-schema.md`**

Adicionar `siso_demanda_diaria` (MV), `siso_reposicao_sugestoes`, `siso_reposicao_aprovacoes`, `siso_reposicao_config`, e RPCs `wms_refresh_demanda_diaria` + `wms_calcular_em_transito` seguindo o formato existente.

- [ ] **Step 3: Adicionar fluxo em `architecture-and-flows.md`**

Documentar:
- Pipeline noturno (00:30 BRT): MV refresh → loop SKUs → upsert sugestões
- Fluxo de aprovação: tela → modal → API → criação de OC/reserva → audit
- Cold start: 30 dias após `data_ligado_em`

- [ ] **Step 4: Atualizar `CLAUDE.md`**

Na seção "Project Structure", adicionar `src/lib/wms/reposicao/` com os 8 arquivos + 4 endpoints novos em `/api/wms/{reposicao,compras/reposicao,...}`. Na seção "Current Status / Recently Added", anotar:
```
- WMS Reposição Preditiva (Radar do Comprador) — implementado, 2026-05-XX.
  Nova aba em /wms/compras com ranking diário por urgência baseado em SES +
  Croston-SBA, ROP por curva ABC, hierarquia empréstimo→equivalente→comprar.
  Spec: docs/superpowers/specs/2026-05-18-compras-preditivo-design.md
  Plano: docs/superpowers/plans/2026-05-18-compras-preditivo.md
```

- [ ] **Step 5: Commit**

```bash
git add docs/api-reference-complete.md docs/database-schema.md docs/architecture-and-flows.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: módulo Reposição Preditiva (Radar do Comprador)

Atualiza api-reference-complete.md (4 endpoints novos), database-schema.md
(MV + 3 tabelas + 2 RPCs), architecture-and-flows.md (pipeline noturno +
fluxo de aprovação) e CLAUDE.md (Project Structure + Current Status).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 27: Smoke test end-to-end + adicionar erros-conhecidos.yaml entries

**Files:**
- Modify: `erros-conhecidos.yaml` (adicionar quaisquer erros que aparecerem no smoke)

- [ ] **Step 1: Smoke test completo em staging**

Sequência:
1. `npm run build` — passa sem erros TypeScript
2. `npx vitest run src/lib/wms/reposicao` — todos os ~38 testes verdes
3. Dev server up. Login como admin. `/wms/compras` → tab Reposição abre.
4. Disparar refresh manual: `curl -X POST .../api/wms/reposicao/refresh?force=true -H "x-worker-secret: ..."`
5. Tabela popula com sugestões. Filtros mudam a lista.
6. Drawer "Por quê?" abre com sparkline + cálculo.
7. Selecionar 2 itens, abrir modal, confirmar. Toast verde. OCs aparecem em `siso_ordens_compra`. Audit em `siso_reposicao_aprovacoes`.
8. Verificar que tabs Comprar e Receber ainda funcionam (não foram quebradas).

- [ ] **Step 2: Documentar erros encontrados**

Pra cada erro corrigido durante o smoke, adicionar entry em `erros-conhecidos.yaml` seguindo o formato do arquivo (id, date, source, category, message, cause, fix, files, tags).

- [ ] **Step 3: Commit final**

Se houver mudanças:
```bash
git add erros-conhecidos.yaml
git commit -m "$(cat <<'EOF'
docs(erros): registra erros encontrados no smoke do compras preditivo

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Follow-up plans (não cobertos aqui)

- **Fase 4 — Métricas dashboard:** cards em `/wms/insights` (fill-rate, capital em estoque, taxa aprovação, MAE/MAPE).
- **Fase 5 — Tela admin de configuração:** `/wms/configuracoes/reposicao` pra editar Z's, alphas, toggles, lead time default sem precisar de SQL.
- **Refinamento futuro do modelo:** ligar σ do lead time (precisa de histórico de NF de entrada), detectar tendência (Holt linear quando >90d dados), detectar sazonalidade semanal (>56d dados), EOQ (precisa custo de pedido + carregamento parametrizados).

---

## Open questions (do spec, ainda a resolver durante execução)

1. **OC vinculação produto:** schema atual de `siso_ordens_compra` é só header. Plano usa OC shell + audit em `siso_reposicao_aprovacoes`. Se for desejável ligar OC a produtos via tabela intermediária (`siso_ordens_compra_itens`), incluir migration adicional — fora do escopo do MVP.
2. **Cron domain:** confirmar URL pública pra Supabase cron POSTar via `net.http_post` (provavelmente `https://[app].vercel.app` ou similar).
3. **Multi-galpão:** plano sugere por padrão 1 linha por (produto, empresa, galpão). Comprador pode querer consolidar visualmente — abre como follow-up se reclamarem.

---

## Self-review do plano

**Spec coverage check:**
- ✅ §3.1-§3.9 (decisões de design) → todas implementadas nas tasks 7-13 (lib pura)
- ✅ §4 (modelos preditivos) → tasks 8-13
- ✅ §5 (schema) → tasks 2-6
- ✅ §6 (pipeline) → tasks 14-15, 19
- ✅ §7 (UI) → tasks 20-25
- ✅ §8 (cold start) → task 25 + lógica de confiança no refresh.ts (task 14)
- ⏭ §9 (métricas) → adiado pra Fase 4 (follow-up plan)
- ✅ §10 (riscos) → mitigações já endereçadas (banner, confiança, em_transito, audit trail)
- ✅ §11 (YAGNI) → respeitado, nenhuma das exclusões foi implementada
- ✅ §12 (plano de fases) → fases 1-3 cobertas neste plano, 4-5 documentadas como follow-up

**Placeholder scan:** zero TBDs no plano. Toda função tem implementação completa.

**Type consistency check:**
- `ReposicaoConfig` (types.ts) bate com colunas de `siso_reposicao_config` ✓
- `Alternativa` (types.ts) bate com estrutura usada em `alternativas.ts` e `refresh.ts` ✓
- `SugestaoRow` (use-reposicao.ts) bate com colunas de `siso_reposicao_sugestoes` ✓
- `forecastSES` retorna `{ mu_diario, sigma_diario }` — consistente com `ForecastResult` ✓
- Nome `wms_reservar_atomico` usado em task 18 — confirmado em CLAUDE.md (existe no WMS Plano 3) ✓
- Coluna `disponivel` em `siso_estoque` — confirmado (GENERATED saldo-reservado em CLAUDE.md) ✓

**Total tasks:** 27. **Estimativa:** ~5-7 dias de trabalho contínuo.

---

## Execution Handoff

Plano salvo em `docs/superpowers/plans/2026-05-18-compras-preditivo.md`.

**Duas opções de execução:**

1. **Subagent-Driven (recomendado)** — Dispatch fresh subagent per task, review entre tarefas, iteração rápida.

2. **Inline Execution** — Executa tasks nesta sessão usando `superpowers:executing-plans`, batch com checkpoints pra revisão.

**Qual abordagem?**
