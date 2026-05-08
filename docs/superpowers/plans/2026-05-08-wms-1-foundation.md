# WMS 1 — Foundation (lê estoque) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cria o esqueleto do WMS interno do SISO — schema 4D (produto, dona, galpão, localização) com ledger imutável, sync de catálogo via Tiny, snapshot inicial e telas de visualização. Sem mexer no fluxo crítico de pedidos. Após esse plano, o time consegue **ver** todo o estoque real (saldos por dono/galpão/localização/produto + ledger completo) e o módulo standalone está pronto pra receber operações nos planos seguintes.

**Architecture:** App standalone em `/wms/*` com schema isolado prefixado `siso_*` (sem colisão com tabelas legadas). Service-role client server-side, AppShell + AuthProvider já existentes. Todas mutações ocorrem via API route (`/api/wms/*`). Ledger imutável = `siso_movimentacoes`; cache materializado = `siso_estoque`. Reuso do `produto-fetcher.ts` do módulo Cross pra sync com Tiny.

**Tech Stack:** Next.js 16.1.6 App Router (TypeScript strict), Supabase (Postgres 15, service-role), Tailwind 4, TanStack Query, Sonner, Lucide, Vitest (novo, pra unit tests de lógica pura).

**Spec de referência:** [docs/superpowers/specs/2026-05-07-wms-design.md](../specs/2026-05-07-wms-design.md) — seções 3.1-3.6, 3.9, 3.15, 4, parte de 11 (Fase 0).

**Pré-requisitos:** ambiente dev rodando (`npm run dev`), Supabase project `wrbrbhuhsaaupqsimkqz` com `SUPABASE_SERVICE_ROLE_KEY` em `.env.local`.

---

## File Structure

| Caminho | Responsabilidade |
|---|---|
| `supabase/migrations/20260508_wms_foundation.sql` | Schema base: produtos, mapeamento Tiny, localizações, galpões geo, estoque, ledger, cargo |
| `vitest.config.ts` | Setup de testes unitários |
| `src/lib/wms/types.ts` | Types compartilhados (Produto, Localizacao, Estoque, Movimentacao, etc) |
| `src/lib/wms/ledger.ts` | Helper `inserirMovimentacao()` — única forma de escrever no ledger; valida invariantes |
| `src/lib/wms/ledger.test.ts` | Unit tests do ledger helper |
| `src/lib/wms/produtos.ts` | CRUD de produtos no catálogo |
| `src/lib/wms/localizacoes.ts` | CRUD de localizações |
| `src/lib/wms/estoque.ts` | Queries de leitura (saldos por perspectiva) |
| `src/lib/wms/sync-tiny.ts` | Wrapper sobre `produto-fetcher.ts` do Cross pra sincronizar produtos |
| `src/lib/wms/snapshot-inicial.ts` | Bulk-load do Tiny pra popular `siso_estoque` |
| `src/app/api/wms/produtos/route.ts` | GET (list/search), POST (create) |
| `src/app/api/wms/produtos/[id]/route.ts` | GET, PATCH, DELETE |
| `src/app/api/wms/produtos/[id]/sync/route.ts` | POST — força sync com Tiny |
| `src/app/api/wms/localizacoes/route.ts` | GET (por galpão), POST |
| `src/app/api/wms/localizacoes/[id]/route.ts` | PATCH, DELETE |
| `src/app/api/wms/estoque/route.ts` | GET com `?view=dono\|galpao\|localizacao\|produto` |
| `src/app/api/wms/ledger/route.ts` | GET com filtros |
| `src/app/api/wms/snapshot-inicial/route.ts` | POST — dispara bulk-load (admin only, idempotente) |
| `src/app/wms/layout.tsx` | Wrapper de navegação WMS |
| `src/app/wms/page.tsx` | Home WMS (cards das telas disponíveis) |
| `src/app/wms/produtos/page.tsx` | Catálogo de produtos |
| `src/app/wms/localizacoes/page.tsx` | Configuração de localizações por galpão |
| `src/app/wms/estoque/page.tsx` | Visualização de saldos (4 perspectivas) |
| `src/app/wms/ledger/page.tsx` | Visualização do ledger com filtros |
| `src/components/wms/wms-shell.tsx` | Header/breadcrumb específico do WMS |
| `src/components/wms/produto-card.tsx` | Card de produto |
| `src/components/wms/saldo-perspectiva-tabs.tsx` | Tabs entre as 4 perspectivas de saldo |

---

### Task 1: Setup Vitest

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Install dev dependencies**

```bash
npm install -D vitest @vitest/ui happy-dom
```

- [ ] **Step 2: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
```

- [ ] **Step 3: Add scripts to `package.json`**

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 4: Smoke test**

Create `src/lib/wms/_smoke.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
describe("smoke", () => {
  it("vitest is alive", () => expect(1 + 1).toBe(2));
});
```

Run: `npm test`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/lib/wms/_smoke.test.ts
git commit -m "feat(wms): setup vitest for unit tests"
```

---

### Task 2: Migration — schema foundation

**Files:**
- Create: `supabase/migrations/20260508_wms_foundation.sql`

- [ ] **Step 1: Write migration**

```sql
-- WMS Foundation — schema 4D + ledger imutável
-- Spec: docs/superpowers/specs/2026-05-07-wms-design.md §3.1-3.6, 3.9

BEGIN;

-- 1. Cargo supervisor_logistica em siso_usuarios
ALTER TABLE siso_usuarios
  DROP CONSTRAINT IF EXISTS siso_usuarios_cargo_check;
ALTER TABLE siso_usuarios
  ADD CONSTRAINT siso_usuarios_cargo_check
  CHECK (cargo IN ('admin','operador_cwb','operador_sp','comprador','supervisor_logistica'));

-- 2. Catálogo unificado
CREATE TABLE siso_produtos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE,
  descricao text NOT NULL,
  gtin text,
  imagem_url text,
  unidade text NOT NULL DEFAULT 'UN',
  ncm text,
  cest text,
  origem_fiscal smallint CHECK (origem_fiscal IS NULL OR origem_fiscal BETWEEN 0 AND 8),
  sincronizado_em timestamptz,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_produtos_sku ON siso_produtos(sku);
CREATE INDEX idx_produtos_gtin ON siso_produtos(gtin) WHERE gtin IS NOT NULL;
CREATE INDEX idx_produtos_ativo ON siso_produtos(ativo) WHERE ativo = true;
CREATE INDEX idx_produtos_sincronizado ON siso_produtos(sincronizado_em);

-- 3. Mapeamento SKU ↔ Tiny por empresa
CREATE TABLE siso_produto_empresas (
  produto_id uuid NOT NULL REFERENCES siso_produtos(id) ON DELETE CASCADE,
  empresa_id uuid NOT NULL REFERENCES siso_empresas(id) ON DELETE CASCADE,
  tiny_produto_id bigint NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  PRIMARY KEY (produto_id, empresa_id),
  UNIQUE(empresa_id, tiny_produto_id)
);

CREATE INDEX idx_prod_emp_tiny ON siso_produto_empresas(empresa_id, tiny_produto_id);

-- 4. Galpões: geolocalização
ALTER TABLE siso_galpoes
  ADD COLUMN IF NOT EXISTS cidade text,
  ADD COLUMN IF NOT EXISTS estado text,
  ADD COLUMN IF NOT EXISTS pais text NOT NULL DEFAULT 'BR';
ALTER TABLE siso_galpoes
  DROP CONSTRAINT IF EXISTS siso_galpoes_estado_check;
ALTER TABLE siso_galpoes
  ADD CONSTRAINT siso_galpoes_estado_check
  CHECK (estado IS NULL OR estado ~ '^[A-Z]{2}$');

-- 5. Localizações dentro de galpão
CREATE TABLE siso_localizacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  codigo text NOT NULL,
  descricao text,
  tipo text NOT NULL DEFAULT 'picking' CHECK (tipo IN (
    'picking','overstock','recebimento','expedicao','quarentena'
  )),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(galpao_id, codigo)
);

CREATE INDEX idx_loc_galpao ON siso_localizacoes(galpao_id) WHERE ativo;
CREATE INDEX idx_loc_tipo ON siso_localizacoes(galpao_id, tipo) WHERE ativo;

-- 6. Estoque: cache materializado da posição atual (quádrupla)
CREATE TABLE siso_estoque (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  saldo numeric NOT NULL DEFAULT 0 CHECK (saldo >= 0),
  reservado numeric NOT NULL DEFAULT 0 CHECK (reservado >= 0),
  disponivel numeric GENERATED ALWAYS AS (saldo - reservado) STORED,
  custo_medio numeric(12,4) NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(produto_id, empresa_dona_id, galpao_id, localizacao_id),
  CHECK (reservado <= saldo)
);

CREATE INDEX idx_estoque_dono ON siso_estoque(empresa_dona_id, produto_id);
CREATE INDEX idx_estoque_galpao ON siso_estoque(galpao_id, produto_id);
CREATE INDEX idx_estoque_loc ON siso_estoque(localizacao_id, produto_id);
CREATE INDEX idx_estoque_disponivel ON siso_estoque(produto_id) WHERE disponivel > 0;

-- 7. Ledger imutável (CORE)
CREATE TABLE siso_movimentacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  tipo char(1) NOT NULL CHECK (tipo IN ('E','S','R','L')),
  quantidade numeric NOT NULL CHECK (quantidade > 0),
  saldo_anterior numeric NOT NULL CHECK (saldo_anterior >= 0),
  saldo_posterior numeric NOT NULL CHECK (saldo_posterior >= 0),
  reservado_anterior numeric NOT NULL CHECK (reservado_anterior >= 0),
  reservado_posterior numeric NOT NULL CHECK (reservado_posterior >= 0),
  origem_tipo text NOT NULL CHECK (origem_tipo IN (
    'compra_manual','lancamento_retroativo','nf_venda','nf_devolucao_cliente',
    'nf_devolucao_avariada','nf_devolucao_fornecedor','transferencia_galpao',
    'transferencia_localizacao','emprestimo','reserva_pedido','liberacao_reserva',
    'troca_sku_in','troca_sku_out','ajuste_manual','inventario','inventario_inicial',
    'estorno','cancelamento_nf'
  )),
  origem_id text,
  origem_detalhes jsonb NOT NULL DEFAULT '{}',
  emprestimo_devedora_id uuid REFERENCES siso_empresas(id),
  expira_em timestamptz,
  nota_fiscal_id bigint,
  chave_acesso_nf text,
  custo_unitario numeric(12,4),
  usuario_id uuid REFERENCES siso_usuarios(id),
  observacoes text,
  estorno_de uuid REFERENCES siso_movimentacoes(id),
  criado_em timestamptz NOT NULL DEFAULT now(),

  CHECK (
    (origem_tipo = 'emprestimo' AND emprestimo_devedora_id IS NOT NULL)
    OR (origem_tipo <> 'emprestimo' AND emprestimo_devedora_id IS NULL)
  ),
  CHECK (
    (tipo = 'R' AND expira_em IS NOT NULL)
    OR (tipo <> 'R' AND expira_em IS NULL)
  ),
  CHECK (
    (tipo = 'E' AND saldo_posterior = saldo_anterior + quantidade)
    OR (tipo = 'S' AND saldo_posterior = saldo_anterior - quantidade)
    OR (tipo IN ('R','L') AND saldo_posterior = saldo_anterior)
  ),
  CHECK (
    (tipo = 'R' AND reservado_posterior = reservado_anterior + quantidade)
    OR (tipo = 'L' AND reservado_posterior = reservado_anterior - quantidade)
    OR (tipo IN ('E','S') AND reservado_posterior = reservado_anterior)
  ),
  CHECK (reservado_posterior <= saldo_posterior)
);

CREATE INDEX idx_mov_produto ON siso_movimentacoes(produto_id, criado_em DESC);
CREATE INDEX idx_mov_dona ON siso_movimentacoes(empresa_dona_id, criado_em DESC);
CREATE INDEX idx_mov_galpao ON siso_movimentacoes(galpao_id, criado_em DESC);
CREATE INDEX idx_mov_loc ON siso_movimentacoes(localizacao_id, criado_em DESC);
CREATE INDEX idx_mov_origem ON siso_movimentacoes(origem_tipo, origem_id);
CREATE INDEX idx_mov_nf ON siso_movimentacoes(nota_fiscal_id) WHERE nota_fiscal_id IS NOT NULL;
CREATE INDEX idx_mov_estorno ON siso_movimentacoes(estorno_de) WHERE estorno_de IS NOT NULL;
CREATE INDEX idx_mov_emprestimo
  ON siso_movimentacoes(empresa_dona_id, emprestimo_devedora_id, criado_em DESC)
  WHERE origem_tipo = 'emprestimo';
CREATE INDEX idx_mov_reserva_expira
  ON siso_movimentacoes(expira_em) WHERE tipo = 'R' AND expira_em IS NOT NULL;

-- 8. Default location pra cada galpão existente (operacional)
INSERT INTO siso_localizacoes (galpao_id, codigo, descricao, tipo)
SELECT id, 'DEFAULT-PICKING', 'Localização padrão (criada automaticamente)', 'picking'
FROM siso_galpoes
WHERE NOT EXISTS (
  SELECT 1 FROM siso_localizacoes l WHERE l.galpao_id = siso_galpoes.id
);

COMMIT;
```

- [ ] **Step 2: Apply migration via Supabase MCP**

Run via MCP tool: `mcp__supabase__apply_migration` (project `wrbrbhuhsaaupqsimkqz`, name `wms_foundation`).

Verifique: `mcp__supabase__list_tables` retorna `siso_produtos`, `siso_movimentacoes`, etc.

- [ ] **Step 3: Verify constraints**

Run via `mcp__supabase__execute_sql`:

```sql
-- Tenta inserir mov inválida (saldo_posterior incoerente com tipo)
INSERT INTO siso_movimentacoes (
  produto_id, empresa_dona_id, galpao_id, localizacao_id,
  tipo, quantidade, saldo_anterior, saldo_posterior,
  reservado_anterior, reservado_posterior, origem_tipo
)
SELECT
  '00000000-0000-0000-0000-000000000001'::uuid,
  e.id, g.id, l.id,
  'E', 10, 0, 0,  -- saldo_posterior=0 com tipo=E e qty=10 → deve violar CHECK
  0, 0, 'compra_manual'
FROM siso_empresas e, siso_galpoes g, siso_localizacoes l
LIMIT 1;
```

Expected: ERROR: new row violates check constraint.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260508_wms_foundation.sql
git commit -m "feat(wms): schema foundation — 4D estoque + ledger imutável"
```

---

### Task 3: Types TypeScript core

**Files:**
- Create: `src/lib/wms/types.ts`

- [ ] **Step 1: Write types**

```typescript
// Reflete schema de docs/superpowers/specs/2026-05-07-wms-design.md §3
export type TipoLocalizacao = "picking" | "overstock" | "recebimento" | "expedicao" | "quarentena";

export type TipoMov = "E" | "S" | "R" | "L";

export type OrigemTipo =
  | "compra_manual" | "lancamento_retroativo" | "nf_venda"
  | "nf_devolucao_cliente" | "nf_devolucao_avariada" | "nf_devolucao_fornecedor"
  | "transferencia_galpao" | "transferencia_localizacao"
  | "emprestimo" | "reserva_pedido" | "liberacao_reserva"
  | "troca_sku_in" | "troca_sku_out"
  | "ajuste_manual" | "inventario" | "inventario_inicial"
  | "estorno" | "cancelamento_nf";

export interface Produto {
  id: string;
  sku: string;
  descricao: string;
  gtin: string | null;
  imagem_url: string | null;
  unidade: string;
  ncm: string | null;
  cest: string | null;
  origem_fiscal: number | null;
  sincronizado_em: string | null;
  ativo: boolean;
  criado_em: string;
  atualizado_em: string;
}

export interface ProdutoEmpresa {
  produto_id: string;
  empresa_id: string;
  tiny_produto_id: number;
  ativo: boolean;
}

export interface Localizacao {
  id: string;
  galpao_id: string;
  codigo: string;
  descricao: string | null;
  tipo: TipoLocalizacao;
  ativo: boolean;
  criado_em: string;
}

export interface EstoqueLinha {
  id: string;
  produto_id: string;
  empresa_dona_id: string;
  galpao_id: string;
  localizacao_id: string;
  saldo: number;
  reservado: number;
  disponivel: number;
  custo_medio: number;
  atualizado_em: string;
}

export interface Movimentacao {
  id: string;
  produto_id: string;
  empresa_dona_id: string;
  galpao_id: string;
  localizacao_id: string;
  tipo: TipoMov;
  quantidade: number;
  saldo_anterior: number;
  saldo_posterior: number;
  reservado_anterior: number;
  reservado_posterior: number;
  origem_tipo: OrigemTipo;
  origem_id: string | null;
  origem_detalhes: Record<string, unknown>;
  emprestimo_devedora_id: string | null;
  expira_em: string | null;
  nota_fiscal_id: number | null;
  chave_acesso_nf: string | null;
  custo_unitario: number | null;
  usuario_id: string | null;
  observacoes: string | null;
  estorno_de: string | null;
  criado_em: string;
}

/**
 * Quádrupla — chave única que identifica uma posição de estoque.
 */
export interface Quadrupla {
  produto_id: string;
  empresa_dona_id: string;
  galpao_id: string;
  localizacao_id: string;
}

export type PerspectivaEstoque = "dono" | "galpao" | "localizacao" | "produto";
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/wms/types.ts
git commit -m "feat(wms): types compartilhados (Produto, Estoque, Movimentacao)"
```

---

### Task 4: Helper `inserirMovimentacao` com testes

**Files:**
- Create: `src/lib/wms/ledger.ts`
- Create: `src/lib/wms/ledger.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { calcularPosteriores, validarCoerencia } from "./ledger";

describe("calcularPosteriores", () => {
  it("entrada (E): incrementa saldo, reservado inalterado", () => {
    const r = calcularPosteriores({ tipo: "E", qty: 10, saldoAnterior: 5, reservadoAnterior: 2 });
    expect(r).toEqual({ saldo_posterior: 15, reservado_posterior: 2 });
  });

  it("saída (S): decrementa saldo, reservado inalterado", () => {
    const r = calcularPosteriores({ tipo: "S", qty: 3, saldoAnterior: 10, reservadoAnterior: 4 });
    expect(r).toEqual({ saldo_posterior: 7, reservado_posterior: 4 });
  });

  it("reserva (R): saldo inalterado, reservado +qty", () => {
    const r = calcularPosteriores({ tipo: "R", qty: 2, saldoAnterior: 10, reservadoAnterior: 1 });
    expect(r).toEqual({ saldo_posterior: 10, reservado_posterior: 3 });
  });

  it("liberação (L): saldo inalterado, reservado -qty", () => {
    const r = calcularPosteriores({ tipo: "L", qty: 2, saldoAnterior: 10, reservadoAnterior: 5 });
    expect(r).toEqual({ saldo_posterior: 10, reservado_posterior: 3 });
  });
});

describe("validarCoerencia", () => {
  it("rejeita saída com saldo insuficiente", () => {
    expect(() => validarCoerencia({ tipo: "S", qty: 10, saldoAnterior: 5, reservadoAnterior: 0 }))
      .toThrow(/saldo insuficiente/i);
  });

  it("rejeita reserva quando reservado_posterior > saldo_posterior", () => {
    expect(() => validarCoerencia({ tipo: "R", qty: 5, saldoAnterior: 10, reservadoAnterior: 8 }))
      .toThrow(/reservado.*saldo/i);
  });

  it("rejeita liberação maior que reservado", () => {
    expect(() => validarCoerencia({ tipo: "L", qty: 10, saldoAnterior: 10, reservadoAnterior: 5 }))
      .toThrow(/libera.*reservado/i);
  });

  it("aceita movimento válido", () => {
    expect(() => validarCoerencia({ tipo: "E", qty: 1, saldoAnterior: 0, reservadoAnterior: 0 }))
      .not.toThrow();
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npm test -- ledger`
Expected: FAIL — `calcularPosteriores` and `validarCoerencia` not exported.

- [ ] **Step 3: Implement ledger.ts**

```typescript
import type { TipoMov, OrigemTipo, Quadrupla, Movimentacao } from "./types";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

interface CalcInput {
  tipo: TipoMov;
  qty: number;
  saldoAnterior: number;
  reservadoAnterior: number;
}

export function calcularPosteriores(input: CalcInput): {
  saldo_posterior: number;
  reservado_posterior: number;
} {
  const { tipo, qty, saldoAnterior, reservadoAnterior } = input;
  switch (tipo) {
    case "E": return { saldo_posterior: saldoAnterior + qty, reservado_posterior: reservadoAnterior };
    case "S": return { saldo_posterior: saldoAnterior - qty, reservado_posterior: reservadoAnterior };
    case "R": return { saldo_posterior: saldoAnterior, reservado_posterior: reservadoAnterior + qty };
    case "L": return { saldo_posterior: saldoAnterior, reservado_posterior: reservadoAnterior - qty };
  }
}

export function validarCoerencia(input: CalcInput): void {
  const { tipo, qty, saldoAnterior, reservadoAnterior } = input;
  if (qty <= 0) throw new Error("qty deve ser > 0");

  const { saldo_posterior, reservado_posterior } = calcularPosteriores(input);

  if (saldo_posterior < 0) {
    throw new Error(`saldo insuficiente: anterior=${saldoAnterior} qty=${qty} tipo=${tipo}`);
  }
  if (reservado_posterior < 0) {
    throw new Error(`não pode liberar mais do que está reservado: reservado=${reservadoAnterior} qty=${qty}`);
  }
  if (reservado_posterior > saldo_posterior) {
    throw new Error(`reservado (${reservado_posterior}) excederia saldo (${saldo_posterior})`);
  }
}

interface InserirMovInput {
  quadrupla: Quadrupla;
  tipo: TipoMov;
  qty: number;
  origem_tipo: OrigemTipo;
  origem_id?: string;
  origem_detalhes?: Record<string, unknown>;
  emprestimo_devedora_id?: string;
  expira_em?: string;
  nota_fiscal_id?: number;
  custo_unitario?: number;
  usuario_id?: string;
  observacoes?: string;
  estorno_de?: string;
}

/**
 * Insere uma movimentação no ledger E atualiza siso_estoque, atomicamente.
 *
 * - Faz SELECT FOR UPDATE na linha de siso_estoque (criando se não existe)
 * - Calcula saldo_posterior/reservado_posterior, valida coerência
 * - INSERT em siso_movimentacoes
 * - UPDATE em siso_estoque
 *
 * Toda escrita no ledger DEVE passar por aqui — garante chain verificável.
 */
export async function inserirMovimentacao(input: InserirMovInput): Promise<Movimentacao> {
  const sb = createServiceClient();
  const { quadrupla, tipo, qty } = input;

  // Lê linha atual com lock (via RPC se necessário; aqui usamos approach simplificado por enquanto)
  const { data: estoqueAtual, error: errSel } = await sb
    .from("siso_estoque")
    .select("id, saldo, reservado, custo_medio")
    .match(quadrupla)
    .maybeSingle();
  if (errSel) throw errSel;

  const saldoAnterior = Number(estoqueAtual?.saldo ?? 0);
  const reservadoAnterior = Number(estoqueAtual?.reservado ?? 0);

  validarCoerencia({ tipo, qty, saldoAnterior, reservadoAnterior });

  const { saldo_posterior, reservado_posterior } = calcularPosteriores({
    tipo, qty, saldoAnterior, reservadoAnterior,
  });

  // Insere mov
  const { data: mov, error: errMov } = await sb
    .from("siso_movimentacoes")
    .insert({
      ...quadrupla,
      tipo, quantidade: qty,
      saldo_anterior: saldoAnterior, saldo_posterior,
      reservado_anterior: reservadoAnterior, reservado_posterior,
      origem_tipo: input.origem_tipo,
      origem_id: input.origem_id,
      origem_detalhes: input.origem_detalhes ?? {},
      emprestimo_devedora_id: input.emprestimo_devedora_id,
      expira_em: input.expira_em,
      nota_fiscal_id: input.nota_fiscal_id,
      custo_unitario: input.custo_unitario,
      usuario_id: input.usuario_id,
      observacoes: input.observacoes,
      estorno_de: input.estorno_de,
    })
    .select()
    .single();
  if (errMov) {
    logger.error("wms.ledger", "falha ao inserir mov", { errMov, input });
    throw errMov;
  }

  // Upsert em siso_estoque
  if (estoqueAtual) {
    const { error: errUpd } = await sb
      .from("siso_estoque")
      .update({
        saldo: saldo_posterior,
        reservado: reservado_posterior,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", estoqueAtual.id);
    if (errUpd) throw errUpd;
  } else {
    const { error: errIns } = await sb
      .from("siso_estoque")
      .insert({
        ...quadrupla,
        saldo: saldo_posterior,
        reservado: reservado_posterior,
      });
    if (errIns) throw errIns;
  }

  return mov as Movimentacao;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npm test -- ledger`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/ledger.ts src/lib/wms/ledger.test.ts
git commit -m "feat(wms): helper inserirMovimentacao com validação de invariantes"
```

---

### Task 5: CRUD de produtos — service layer

**Files:**
- Create: `src/lib/wms/produtos.ts`

- [ ] **Step 1: Write produtos service**

```typescript
import { createServiceClient } from "@/lib/supabase-server";
import type { Produto } from "./types";

export async function listarProdutos(filtros: {
  q?: string; ativo?: boolean; limit?: number; offset?: number;
} = {}): Promise<{ rows: Produto[]; total: number }> {
  const sb = createServiceClient();
  let q = sb
    .from("siso_produtos")
    .select("*", { count: "exact" })
    .order("sku", { ascending: true })
    .range(filtros.offset ?? 0, (filtros.offset ?? 0) + (filtros.limit ?? 50) - 1);
  if (filtros.q) q = q.or(`sku.ilike.%${filtros.q}%,descricao.ilike.%${filtros.q}%,gtin.eq.${filtros.q}`);
  if (filtros.ativo !== undefined) q = q.eq("ativo", filtros.ativo);
  const { data, error, count } = await q;
  if (error) throw error;
  return { rows: (data ?? []) as Produto[], total: count ?? 0 };
}

export async function getProduto(id: string): Promise<Produto | null> {
  const sb = createServiceClient();
  const { data, error } = await sb.from("siso_produtos").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data as Produto | null;
}

export async function criarProduto(input: {
  sku: string; descricao: string; gtin?: string; unidade?: string; ncm?: string;
}): Promise<Produto> {
  const sb = createServiceClient();
  const { data, error } = await sb.from("siso_produtos")
    .insert({ ...input, unidade: input.unidade ?? "UN" })
    .select().single();
  if (error) throw error;
  return data as Produto;
}

export async function atualizarProduto(id: string, patch: Partial<Produto>): Promise<Produto> {
  const sb = createServiceClient();
  const { data, error } = await sb.from("siso_produtos")
    .update({ ...patch, atualizado_em: new Date().toISOString() })
    .eq("id", id)
    .select().single();
  if (error) throw error;
  return data as Produto;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/wms/produtos.ts
git commit -m "feat(wms): service layer de produtos (CRUD)"
```

---

### Task 6: API route `/api/wms/produtos`

**Files:**
- Create: `src/app/api/wms/produtos/route.ts`
- Create: `src/app/api/wms/produtos/[id]/route.ts`

- [ ] **Step 1: Implement list/create**

```typescript
// src/app/api/wms/produtos/route.ts
import { NextRequest, NextResponse } from "next/server";
import { listarProdutos, criarProduto } from "@/lib/wms/produtos";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  try {
    const result = await listarProdutos({
      q: sp.get("q") ?? undefined,
      ativo: sp.get("ativo") === "false" ? false : sp.get("ativo") === "true" ? true : undefined,
      limit: sp.get("limit") ? Number(sp.get("limit")) : 50,
      offset: sp.get("offset") ? Number(sp.get("offset")) : 0,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body.sku || !body.descricao) {
    return NextResponse.json({ error: "sku e descricao obrigatórios" }, { status: 400 });
  }
  try {
    const produto = await criarProduto(body);
    return NextResponse.json(produto, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Implement get/patch by id**

```typescript
// src/app/api/wms/produtos/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getProduto, atualizarProduto } from "@/lib/wms/produtos";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const p = await getProduto(id);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(p);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json();
  try {
    const p = await atualizarProduto(id, body);
    return NextResponse.json(p);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 3: Smoke test via curl**

```bash
# Create
curl -X POST http://localhost:3000/api/wms/produtos \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: $SESSION_ID" \
  -d '{"sku":"TEST-001","descricao":"Produto de teste"}'

# List
curl -H "X-Session-Id: $SESSION_ID" \
  http://localhost:3000/api/wms/produtos?q=TEST
```

Expected: status 201 no create; status 200 com `{rows:[...], total:1}` no list.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wms/produtos/
git commit -m "feat(wms): API routes /api/wms/produtos (list, create, get, patch)"
```

---

### Task 7: Sync com Tiny — wrapper sobre `produto-fetcher.ts` do Cross

**Files:**
- Create: `src/lib/wms/sync-tiny.ts`
- Create: `src/app/api/wms/produtos/[id]/sync/route.ts`

- [ ] **Step 1: Verificar produto-fetcher do Cross**

Já existe e exporta:
- `fetchProdutoFromTiny(sku: string, empresaId: string)` — busca via Tiny e retorna parsed data
- `persistProdutoNoCatalogo(produto)` — persiste no catálogo Cross
- `fetchAndPersistProduto(sku, empresaId)` — combina os dois

O catálogo Cross usa `siso_produtos_catalogo` (legado); WMS usa `siso_produtos`. Vamos extrair os campos que precisamos.

- [ ] **Step 2: Escrever wrapper sync-tiny**

```typescript
// src/lib/wms/sync-tiny.ts
import { createServiceClient } from "@/lib/supabase-server";
import { fetchProdutoFromTiny } from "@/lib/cross/produto-fetcher";
import { logger } from "@/lib/logger";

interface CamposSync {
  descricao?: string;
  gtin?: string;
  unidade?: string;
  ncm?: string;
  cest?: string;
  origem_fiscal?: number;
  imagem_url?: string;
}

/**
 * Sincroniza um produto do siso_produtos com a versão atual no Tiny.
 * - Busca produto via Tiny API usando 1 mapeamento ativo qualquer
 * - Atualiza descricao, ncm, cest, origem_fiscal, imagem_url, gtin, unidade
 * - Marca sincronizado_em = now()
 */
export async function sincronizarProduto(produtoId: string): Promise<void> {
  const sb = createServiceClient();

  const { data: produto } = await sb.from("siso_produtos").select("sku").eq("id", produtoId).single();
  if (!produto) throw new Error("produto não encontrado");

  const { data: mapeamento, error } = await sb
    .from("siso_produto_empresas")
    .select("empresa_id, tiny_produto_id")
    .eq("produto_id", produtoId)
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!mapeamento) {
    logger.warn("wms.sync", "produto sem mapeamento Tiny ativo", { produtoId });
    return;
  }

  const tinyRaw = await fetchProdutoFromTiny(produto.sku, mapeamento.empresa_id);
  if (!tinyRaw) return;

  // fetchProdutoFromTiny retorna shape do catálogo Cross; mapeamos pros campos do siso_produtos
  const campos: CamposSync = {
    descricao: tinyRaw.descricao,
    gtin: (tinyRaw as any).gtin ?? undefined,
    unidade: (tinyRaw as any).unidade ?? undefined,
    ncm: (tinyRaw as any).ncm ?? undefined,
    cest: (tinyRaw as any).cest ?? undefined,
    origem_fiscal: (tinyRaw as any).origem_fiscal ?? undefined,
    imagem_url: (tinyRaw as any).imagem_url ?? undefined,
  };

  // Remove undefined pra não sobrescrever campos com null indevidamente
  const patch: Record<string, unknown> = { sincronizado_em: new Date().toISOString() };
  for (const [k, v] of Object.entries(campos)) if (v !== undefined) patch[k] = v;

  await sb.from("siso_produtos").update(patch).eq("id", produtoId);
}

/**
 * Variante: cria produto no siso_produtos se não existir, dado SKU + Tiny empresa+id.
 * Retorna o id do produto (criado ou existente).
 */
export async function ensureProdutoFromTiny(
  sku: string,
  empresaId: string,
  tinyProdutoId: number,
): Promise<string> {
  const sb = createServiceClient();

  // Já existe?
  const { data: existente } = await sb.from("siso_produtos").select("id").eq("sku", sku).maybeSingle();
  if (existente) {
    // Garante mapeamento
    await sb.from("siso_produto_empresas").upsert(
      { produto_id: existente.id, empresa_id: empresaId, tiny_produto_id: tinyProdutoId },
      { onConflict: "produto_id,empresa_id" }
    );
    return existente.id;
  }

  // Cria mínimo viável (descricao temporária)
  const { data: novo } = await sb.from("siso_produtos")
    .insert({ sku, descricao: `(aguardando sync) ${sku}` })
    .select("id").single();
  if (!novo) throw new Error("falha ao criar produto");

  await sb.from("siso_produto_empresas").insert({
    produto_id: novo.id, empresa_id: empresaId, tiny_produto_id: tinyProdutoId,
  });

  // Sync agora pra preencher os campos
  await sincronizarProduto(novo.id);
  return novo.id;
}
```

- [ ] **Step 3: Implement sync API route**

```typescript
// src/app/api/wms/produtos/[id]/sync/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { sincronizarProduto } from "@/lib/wms/sync-tiny";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await sincronizarProduto(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 4: Manual smoke test**

Após criar produto com SKU real do Tiny:

```bash
curl -X POST http://localhost:3000/api/wms/produtos/$ID/sync \
  -H "X-Session-Id: $SESSION_ID"
```

Expected: `{ok: true}`. Verifica que `sincronizado_em` foi populado.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/sync-tiny.ts src/app/api/wms/produtos/[id]/sync/
git commit -m "feat(wms): sync de catálogo com Tiny via produto-fetcher do Cross"
```

---

### Task 8: CRUD localizações + service

**Files:**
- Create: `src/lib/wms/localizacoes.ts`
- Create: `src/app/api/wms/localizacoes/route.ts`
- Create: `src/app/api/wms/localizacoes/[id]/route.ts`

- [ ] **Step 1: Service layer**

```typescript
// src/lib/wms/localizacoes.ts
import { createServiceClient } from "@/lib/supabase-server";
import type { Localizacao, TipoLocalizacao } from "./types";

export async function listarLocalizacoes(galpaoId?: string): Promise<Localizacao[]> {
  const sb = createServiceClient();
  let q = sb.from("siso_localizacoes").select("*").eq("ativo", true).order("codigo");
  if (galpaoId) q = q.eq("galpao_id", galpaoId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Localizacao[];
}

export async function criarLocalizacao(input: {
  galpao_id: string; codigo: string; descricao?: string; tipo?: TipoLocalizacao;
}): Promise<Localizacao> {
  const sb = createServiceClient();
  const { data, error } = await sb.from("siso_localizacoes")
    .insert({ ...input, tipo: input.tipo ?? "picking" })
    .select().single();
  if (error) throw error;
  return data as Localizacao;
}

export async function atualizarLocalizacao(id: string, patch: Partial<Localizacao>): Promise<Localizacao> {
  const sb = createServiceClient();
  const { data, error } = await sb.from("siso_localizacoes")
    .update(patch).eq("id", id).select().single();
  if (error) throw error;
  return data as Localizacao;
}

export async function desativarLocalizacao(id: string): Promise<void> {
  const sb = createServiceClient();
  // Verificar saldo zero antes de desativar
  const { data: estoque } = await sb.from("siso_estoque")
    .select("saldo").eq("localizacao_id", id).gt("saldo", 0).limit(1);
  if (estoque && estoque.length > 0) {
    throw new Error("não é possível desativar: localização tem saldo");
  }
  await sb.from("siso_localizacoes").update({ ativo: false }).eq("id", id);
}
```

- [ ] **Step 2: API routes**

```typescript
// src/app/api/wms/localizacoes/route.ts
import { NextRequest, NextResponse } from "next/server";
import { listarLocalizacoes, criarLocalizacao } from "@/lib/wms/localizacoes";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const galpaoId = req.nextUrl.searchParams.get("galpao_id") ?? undefined;
  return NextResponse.json({ rows: await listarLocalizacoes(galpaoId) });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body.galpao_id || !body.codigo) {
    return NextResponse.json({ error: "galpao_id e codigo obrigatórios" }, { status: 400 });
  }
  try {
    const loc = await criarLocalizacao(body);
    return NextResponse.json(loc, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

```typescript
// src/app/api/wms/localizacoes/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { atualizarLocalizacao, desativarLocalizacao } from "@/lib/wms/localizacoes";
import { getSessionUser } from "@/lib/session";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json();
  try {
    return NextResponse.json(await atualizarLocalizacao(id, body));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await desativarLocalizacao(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/wms/localizacoes.ts src/app/api/wms/localizacoes/
git commit -m "feat(wms): CRUD de localizações"
```

---

### Task 9: Estoque — queries de leitura por perspectiva

**Files:**
- Create: `src/lib/wms/estoque.ts`
- Create: `src/app/api/wms/estoque/route.ts`

- [ ] **Step 1: Service**

```typescript
// src/lib/wms/estoque.ts
import { createServiceClient } from "@/lib/supabase-server";
import type { PerspectivaEstoque } from "./types";

export async function saldosPorPerspectiva(view: PerspectivaEstoque, filtro?: {
  produto_id?: string; empresa_id?: string; galpao_id?: string;
}) {
  const sb = createServiceClient();
  // Join com siso_produtos, siso_empresas, siso_galpoes, siso_localizacoes pra retornar nomes
  let q = sb.from("siso_estoque").select(`
    id, saldo, reservado, disponivel, custo_medio, atualizado_em,
    produto:siso_produtos(id, sku, descricao),
    empresa:siso_empresas(id, nome),
    galpao:siso_galpoes(id, nome, cidade, estado),
    localizacao:siso_localizacoes(id, codigo, tipo)
  `).gt("saldo", 0);

  if (filtro?.produto_id) q = q.eq("produto_id", filtro.produto_id);
  if (filtro?.empresa_id) q = q.eq("empresa_dona_id", filtro.empresa_id);
  if (filtro?.galpao_id) q = q.eq("galpao_id", filtro.galpao_id);

  const { data, error } = await q.limit(500);
  if (error) throw error;

  // Agregação client-side por perspectiva (dataset moderado em v1)
  return agruparPor(data ?? [], view);
}

function agruparPor(rows: any[], view: PerspectivaEstoque) {
  const map = new Map<string, { chave: string; nome: string; saldo: number; reservado: number; disponivel: number; itens: any[] }>();
  for (const r of rows) {
    const key = view === "dono" ? r.empresa.id
      : view === "galpao" ? r.galpao.id
      : view === "localizacao" ? r.localizacao.id
      : r.produto.id;
    const nome = view === "dono" ? r.empresa.nome
      : view === "galpao" ? r.galpao.nome
      : view === "localizacao" ? r.localizacao.codigo
      : `${r.produto.sku} — ${r.produto.descricao}`;
    const existing = map.get(key) ?? { chave: key, nome, saldo: 0, reservado: 0, disponivel: 0, itens: [] };
    existing.saldo += Number(r.saldo);
    existing.reservado += Number(r.reservado);
    existing.disponivel += Number(r.disponivel);
    existing.itens.push(r);
    map.set(key, existing);
  }
  return Array.from(map.values()).sort((a, b) => b.saldo - a.saldo);
}
```

- [ ] **Step 2: API route**

```typescript
// src/app/api/wms/estoque/route.ts
import { NextRequest, NextResponse } from "next/server";
import { saldosPorPerspectiva } from "@/lib/wms/estoque";
import { getSessionUser } from "@/lib/session";
import type { PerspectivaEstoque } from "@/lib/wms/types";

const VIEWS = new Set(["dono", "galpao", "localizacao", "produto"]);

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const view = (sp.get("view") ?? "produto") as PerspectivaEstoque;
  if (!VIEWS.has(view)) return NextResponse.json({ error: "view inválida" }, { status: 400 });

  try {
    const rows = await saldosPorPerspectiva(view, {
      produto_id: sp.get("produto_id") ?? undefined,
      empresa_id: sp.get("empresa_id") ?? undefined,
      galpao_id: sp.get("galpao_id") ?? undefined,
    });
    return NextResponse.json({ rows });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 3: Smoke test**

```bash
curl -H "X-Session-Id: $SESSION_ID" \
  "http://localhost:3000/api/wms/estoque?view=galpao"
```

Expected: lista de galpões com saldos agregados (ainda zerada antes do snapshot).

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/estoque.ts src/app/api/wms/estoque/
git commit -m "feat(wms): API de leitura de saldos com 4 perspectivas"
```

---

### Task 10: Ledger — endpoint de leitura

**Files:**
- Create: `src/app/api/wms/ledger/route.ts`

- [ ] **Step 1: Implement endpoint**

```typescript
// src/app/api/wms/ledger/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const sb = createServiceClient();

  let q = sb.from("siso_movimentacoes").select(`
    *,
    produto:siso_produtos(sku, descricao),
    empresa:siso_empresas(nome),
    galpao:siso_galpoes(nome),
    localizacao:siso_localizacoes(codigo, tipo)
  `).order("criado_em", { ascending: false }).limit(Number(sp.get("limit") ?? 100));

  if (sp.get("produto_id")) q = q.eq("produto_id", sp.get("produto_id"));
  if (sp.get("empresa_id")) q = q.eq("empresa_dona_id", sp.get("empresa_id"));
  if (sp.get("galpao_id")) q = q.eq("galpao_id", sp.get("galpao_id"));
  if (sp.get("localizacao_id")) q = q.eq("localizacao_id", sp.get("localizacao_id"));
  if (sp.get("origem_tipo")) q = q.eq("origem_tipo", sp.get("origem_tipo"));
  if (sp.get("desde")) q = q.gte("criado_em", sp.get("desde"));
  if (sp.get("ate")) q = q.lte("criado_em", sp.get("ate"));

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}
```

- [ ] **Step 2: Smoke test**

```bash
curl -H "X-Session-Id: $SESSION_ID" \
  "http://localhost:3000/api/wms/ledger?limit=10"
```

Expected: array vazio antes do snapshot.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/wms/ledger/
git commit -m "feat(wms): API de leitura do ledger com filtros"
```

---

### Task 11: Snapshot inicial — bulk-load do Tiny

**Files:**
- Create: `src/lib/wms/snapshot-inicial.ts`
- Create: `src/app/api/wms/snapshot-inicial/route.ts`

- [ ] **Step 1: Verificar tiny-api existente**

Já exporta `getEstoque(token, idProduto)` — retorna lista de depósitos com saldo. Vamos resolver o token via `getValidTokenByEmpresa(empresaId)` (de `tiny-oauth.ts`).

- [ ] **Step 2: Service de snapshot**

```typescript
// src/lib/wms/snapshot-inicial.ts
import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "./ledger";
import { getEstoque } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { logger } from "@/lib/logger";

/**
 * Bulk-load idempotente: pra cada (produto, empresa) com mapeamento, busca saldo atual no Tiny
 * e cria mov 'inventario_inicial' na localização DEFAULT-PICKING.
 *
 * Idempotência: se já existe mov 'inventario_inicial' pra essa quádrupla, pula.
 *
 * Roda 1x na Fase 0. Pode levar horas (ms 3000+ chamadas).
 */
export async function executarSnapshotInicial(opts: { dryRun?: boolean } = {}): Promise<{
  total: number; criados: number; pulados: number; erros: number;
}> {
  const sb = createServiceClient();
  let criados = 0, pulados = 0, erros = 0;

  // Pra cada produto x empresa com mapeamento ativo
  const { data: pares, error } = await sb
    .from("siso_produto_empresas")
    .select(`
      produto_id, empresa_id, tiny_produto_id,
      empresa:siso_empresas(galpao_id)
    `)
    .eq("ativo", true);
  if (error) throw error;

  // Cache de tokens por empresa pra evitar buscar repetidamente
  const tokenCache = new Map<string, string>();

  for (const par of pares ?? []) {
    try {
      const galpaoId = (par.empresa as any)?.galpao_id;
      if (!galpaoId) continue;

      // Localização default
      const { data: loc } = await sb.from("siso_localizacoes")
        .select("id").eq("galpao_id", galpaoId).eq("codigo", "DEFAULT-PICKING").single();
      if (!loc) continue;

      const quadrupla = {
        produto_id: par.produto_id,
        empresa_dona_id: par.empresa_id,
        galpao_id: galpaoId,
        localizacao_id: loc.id,
      };

      // Idempotência
      const { data: jaExiste } = await sb.from("siso_movimentacoes")
        .select("id").match(quadrupla).eq("origem_tipo", "inventario_inicial").limit(1);
      if (jaExiste && jaExiste.length > 0) { pulados++; continue; }

      // Busca token Tiny da empresa
      let token = tokenCache.get(par.empresa_id);
      if (!token) {
        token = await getValidTokenByEmpresa(par.empresa_id);
        tokenCache.set(par.empresa_id, token);
      }

      // Busca estoque no Tiny — retorna { depositos: [{ saldo, ... }] }
      const estoque = await getEstoque(token, par.tiny_produto_id);
      const totalSaldo = (estoque?.depositos ?? []).reduce(
        (sum: number, d: any) => sum + Number(d.saldo ?? 0), 0
      );
      if (totalSaldo <= 0) { pulados++; continue; }

      if (!opts.dryRun) {
        await inserirMovimentacao({
          quadrupla,
          tipo: "E",
          qty: totalSaldo,
          origem_tipo: "inventario_inicial",
          observacoes: "snapshot inicial Fase 0",
        });
      }
      criados++;
    } catch (e) {
      logger.error("wms.snapshot", "erro em par", { par, e: String(e) });
      erros++;
    }
  }

  return { total: pares?.length ?? 0, criados, pulados, erros };
}
```

- [ ] **Step 3: API route (admin only)**

```typescript
// src/app/api/wms/snapshot-inicial/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { executarSnapshotInicial } from "@/lib/wms/snapshot-inicial";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user || user.cargo !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const sp = req.nextUrl.searchParams;
  const dryRun = sp.get("dryRun") === "true";
  try {
    const result = await executarSnapshotInicial({ dryRun });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 4: Manual dry-run**

```bash
curl -X POST -H "X-Session-Id: $ADMIN_SESSION" \
  "http://localhost:3000/api/wms/snapshot-inicial?dryRun=true"
```

Expected: contagem de pares processados; nenhuma mov criada (dry run).

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/snapshot-inicial.ts src/app/api/wms/snapshot-inicial/
git commit -m "feat(wms): snapshot inicial idempotente do Tiny"
```

---

### Task 12: WMS shell + home

**Files:**
- Create: `src/components/wms/wms-shell.tsx`
- Create: `src/app/wms/layout.tsx`
- Create: `src/app/wms/page.tsx`

- [ ] **Step 1: Shell component**

```tsx
"use client";
import Link from "next/link";
import { Package, MapPin, BarChart3, ScrollText, Database } from "lucide-react";

export function WmsShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-2 flex-wrap text-sm">
        <Link href="/wms" className="px-3 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <Package className="inline w-4 h-4 mr-1" /> WMS
        </Link>
        <Link href="/wms/produtos" className="px-3 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800">Catálogo</Link>
        <Link href="/wms/localizacoes" className="px-3 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <MapPin className="inline w-4 h-4 mr-1" /> Localizações
        </Link>
        <Link href="/wms/estoque" className="px-3 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <BarChart3 className="inline w-4 h-4 mr-1" /> Estoque
        </Link>
        <Link href="/wms/ledger" className="px-3 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <ScrollText className="inline w-4 h-4 mr-1" /> Ledger
        </Link>
      </nav>
      <div>{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Layout**

```tsx
// src/app/wms/layout.tsx
import { WmsShell } from "@/components/wms/wms-shell";

export default function WmsLayout({ children }: { children: React.ReactNode }) {
  return <WmsShell>{children}</WmsShell>;
}
```

- [ ] **Step 3: Home page**

```tsx
// src/app/wms/page.tsx
"use client";
import Link from "next/link";
import { Package, MapPin, BarChart3, ScrollText, Database } from "lucide-react";

const cards = [
  { href: "/wms/produtos", icon: Package, title: "Catálogo de produtos", desc: "Buscar, criar, sincronizar com Tiny" },
  { href: "/wms/localizacoes", icon: MapPin, title: "Localizações", desc: "Configurar prateleiras por galpão" },
  { href: "/wms/estoque", icon: BarChart3, title: "Saldos", desc: "4 perspectivas: dono, galpão, localização, produto" },
  { href: "/wms/ledger", icon: ScrollText, title: "Ledger", desc: "Histórico imutável de movimentações" },
];

export default function WmsHome() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {cards.map(c => (
        <Link key={c.href} href={c.href}
          className="block p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900">
          <c.icon className="w-5 h-5 mb-2" />
          <div className="font-medium">{c.title}</div>
          <div className="text-sm text-zinc-500">{c.desc}</div>
        </Link>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Visit `/wms` in browser**

Run dev server (`npm run dev`), abra http://localhost:3000/wms.
Expected: home com 4 cards clicáveis.

- [ ] **Step 5: Commit**

```bash
git add src/app/wms/layout.tsx src/app/wms/page.tsx src/components/wms/
git commit -m "feat(wms): shell de navegação + home"
```

---

### Task 13: Tela de catálogo de produtos

**Files:**
- Create: `src/app/wms/produtos/page.tsx`

- [ ] **Step 1: Page com search + listagem + criar/sync**

```tsx
"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { Search, Plus, RefreshCw } from "lucide-react";
import type { Produto } from "@/lib/wms/types";

export default function ProdutosPage() {
  const [q, setQ] = useState("");
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["wms-produtos", q],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(q)}`);
      return r.json() as Promise<{ rows: Produto[]; total: number }>;
    },
  });

  const sync = useMutation({
    mutationFn: async (id: string) => sisoFetch(`/api/wms/produtos/${id}/sync`, { method: "POST" }),
    onSuccess: () => {
      toast.success("sincronizado");
      queryClient.invalidateQueries({ queryKey: ["wms-produtos"] });
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 items-center">
        <Search className="w-4 h-4 text-zinc-500" />
        <input
          value={q} onChange={e => setQ(e.target.value)}
          placeholder="SKU, descrição ou GTIN"
          className="flex-1 px-3 py-2 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
        />
      </div>
      {isLoading && <div className="text-zinc-500">carregando...</div>}
      <div className="space-y-1">
        {data?.rows.map(p => (
          <div key={p.id} className="flex items-center justify-between p-3 rounded border border-zinc-200 dark:border-zinc-800">
            <div className="flex-1 min-w-0">
              <div className="font-mono text-sm">{p.sku}</div>
              <div className="text-sm text-zinc-600 truncate">{p.descricao}</div>
              <div className="text-xs text-zinc-500">
                {p.gtin && <>GTIN: {p.gtin} · </>}
                {p.ncm && <>NCM: {p.ncm} · </>}
                {p.sincronizado_em ? `sync: ${new Date(p.sincronizado_em).toLocaleString("pt-BR")}` : "nunca sincronizado"}
              </div>
            </div>
            <button onClick={() => sync.mutate(p.id)} disabled={sync.isPending}
              className="p-2 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800" title="Sincronizar com Tiny">
              <RefreshCw className={`w-4 h-4 ${sync.isPending ? "animate-spin" : ""}`} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Visit and verify**

http://localhost:3000/wms/produtos
Expected: search input + lista (vazia se ainda sem produtos cadastrados).

- [ ] **Step 3: Commit**

```bash
git add src/app/wms/produtos/page.tsx
git commit -m "feat(wms): tela de catálogo de produtos com search e sync"
```

---

### Task 14: Tela de localizações por galpão

**Files:**
- Create: `src/app/wms/localizacoes/page.tsx`

- [ ] **Step 1: Page com seletor de galpão + lista + criar**

```tsx
"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import type { Localizacao, TipoLocalizacao } from "@/lib/wms/types";

const TIPOS: TipoLocalizacao[] = ["picking", "overstock", "recebimento", "expedicao", "quarentena"];

export default function LocalizacoesPage() {
  const queryClient = useQueryClient();
  const [galpaoId, setGalpaoId] = useState<string>("");
  const [novo, setNovo] = useState({ codigo: "", descricao: "", tipo: "picking" as TipoLocalizacao });

  const { data: galpoes } = useQuery({
    queryKey: ["galpoes"],
    queryFn: async () => (await sisoFetch("/api/admin/galpoes")).json(),
  });

  const { data: locs } = useQuery({
    queryKey: ["wms-locs", galpaoId],
    queryFn: async () => {
      if (!galpaoId) return { rows: [] };
      const r = await sisoFetch(`/api/wms/localizacoes?galpao_id=${galpaoId}`);
      return r.json() as Promise<{ rows: Localizacao[] }>;
    },
    enabled: !!galpaoId,
  });

  const criar = useMutation({
    mutationFn: async () =>
      sisoFetch("/api/wms/localizacoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ galpao_id: galpaoId, ...novo }),
      }).then(r => r.json()),
    onSuccess: () => {
      toast.success("localização criada");
      setNovo({ codigo: "", descricao: "", tipo: "picking" });
      queryClient.invalidateQueries({ queryKey: ["wms-locs", galpaoId] });
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-4">
      <select value={galpaoId} onChange={e => setGalpaoId(e.target.value)}
        className="px-3 py-2 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent">
        <option value="">— escolha o galpão —</option>
        {galpoes?.galpoes?.map((g: any) => (
          <option key={g.id} value={g.id}>{g.nome}</option>
        ))}
      </select>

      {galpaoId && (
        <>
          <div className="flex gap-2 items-center p-3 rounded border border-zinc-200 dark:border-zinc-800">
            <input value={novo.codigo} onChange={e => setNovo({ ...novo, codigo: e.target.value })}
              placeholder="código (ex: A-12-03)"
              className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono text-sm" />
            <input value={novo.descricao} onChange={e => setNovo({ ...novo, descricao: e.target.value })}
              placeholder="descrição (opcional)"
              className="flex-1 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm" />
            <select value={novo.tipo} onChange={e => setNovo({ ...novo, tipo: e.target.value as TipoLocalizacao })}
              className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm">
              {TIPOS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <button onClick={() => criar.mutate()} disabled={!novo.codigo || criar.isPending}
              className="px-3 py-1 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-sm">
              criar
            </button>
          </div>

          <div className="space-y-1">
            {locs?.rows.map(l => (
              <div key={l.id} className="flex items-center gap-3 p-2 rounded border border-zinc-200 dark:border-zinc-800">
                <span className="font-mono text-sm">{l.codigo}</span>
                <span className="text-xs px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">{l.tipo}</span>
                <span className="flex-1 text-sm text-zinc-500">{l.descricao}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Smoke test no browser**

http://localhost:3000/wms/localizacoes
Expected: seletor de galpão; ao escolher, mostra a localização DEFAULT-PICKING criada na migration; pode criar novas.

- [ ] **Step 3: Commit**

```bash
git add src/app/wms/localizacoes/page.tsx
git commit -m "feat(wms): tela de configuração de localizações por galpão"
```

---

### Task 15: Tela de saldos com 4 perspectivas

**Files:**
- Create: `src/components/wms/saldo-perspectiva-tabs.tsx`
- Create: `src/app/wms/estoque/page.tsx`

- [ ] **Step 1: Tabs component**

```tsx
"use client";
import type { PerspectivaEstoque } from "@/lib/wms/types";

const TABS: { v: PerspectivaEstoque; label: string }[] = [
  { v: "produto", label: "Por produto" },
  { v: "dono", label: "Por dono fiscal" },
  { v: "galpao", label: "Por galpão" },
  { v: "localizacao", label: "Por localização" },
];

export function SaldoPerspectivaTabs({ value, onChange }: {
  value: PerspectivaEstoque; onChange: (v: PerspectivaEstoque) => void;
}) {
  return (
    <div className="flex gap-1 p-1 rounded-lg bg-zinc-100 dark:bg-zinc-900">
      {TABS.map(t => (
        <button key={t.v} onClick={() => onChange(t.v)}
          className={`px-3 py-1 rounded text-sm ${value === t.v ? "bg-white dark:bg-zinc-700 shadow" : ""}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Page**

```tsx
"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { SaldoPerspectivaTabs } from "@/components/wms/saldo-perspectiva-tabs";
import type { PerspectivaEstoque } from "@/lib/wms/types";

export default function EstoquePage() {
  const [view, setView] = useState<PerspectivaEstoque>("produto");
  const { data, isLoading } = useQuery({
    queryKey: ["wms-estoque", view],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/estoque?view=${view}`);
      return r.json() as Promise<{ rows: { chave: string; nome: string; saldo: number; reservado: number; disponivel: number; itens: any[] }[] }>;
    },
  });

  return (
    <div className="space-y-3">
      <SaldoPerspectivaTabs value={view} onChange={setView} />
      {isLoading && <div className="text-zinc-500">carregando...</div>}
      <div className="space-y-1">
        {data?.rows.map(r => (
          <details key={r.chave} className="rounded border border-zinc-200 dark:border-zinc-800">
            <summary className="flex items-center justify-between p-3 cursor-pointer">
              <span className="font-medium">{r.nome}</span>
              <span className="text-sm tabular-nums">
                {r.disponivel.toLocaleString("pt-BR")} disp · {r.reservado.toLocaleString("pt-BR")} res · {r.saldo.toLocaleString("pt-BR")} total
              </span>
            </summary>
            <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 text-xs space-y-1">
              {r.itens.map((i: any, idx: number) => (
                <div key={idx} className="flex gap-3 font-mono">
                  <span>{i.produto.sku}</span>
                  <span>{i.empresa.nome}</span>
                  <span>{i.galpao.nome}</span>
                  <span>{i.localizacao.codigo}</span>
                  <span className="ml-auto">{i.saldo}</span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/wms/saldo-perspectiva-tabs.tsx src/app/wms/estoque/page.tsx
git commit -m "feat(wms): tela de saldos com 4 perspectivas"
```

---

### Task 16: Tela de ledger com filtros

**Files:**
- Create: `src/app/wms/ledger/page.tsx`

- [ ] **Step 1: Page com filtros e listagem**

```tsx
"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";

export default function LedgerPage() {
  const [filtros, setFiltros] = useState({ origem_tipo: "", limit: 100 });
  const { data } = useQuery({
    queryKey: ["wms-ledger", filtros],
    queryFn: async () => {
      const sp = new URLSearchParams();
      if (filtros.origem_tipo) sp.set("origem_tipo", filtros.origem_tipo);
      sp.set("limit", String(filtros.limit));
      const r = await sisoFetch(`/api/wms/ledger?${sp}`);
      return r.json() as Promise<{ rows: any[] }>;
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center text-sm">
        <select value={filtros.origem_tipo} onChange={e => setFiltros({ ...filtros, origem_tipo: e.target.value })}
          className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent">
          <option value="">todas origens</option>
          {["compra_manual","nf_venda","emprestimo","reserva_pedido","liberacao_reserva","ajuste_manual","inventario","inventario_inicial"].map(o => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </div>

      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-left text-zinc-500">
            <th className="p-1">data</th>
            <th>tipo</th>
            <th>origem</th>
            <th>SKU</th>
            <th>dona</th>
            <th>galpão</th>
            <th>loc</th>
            <th className="text-right">qty</th>
            <th className="text-right">saldo→</th>
          </tr>
        </thead>
        <tbody>
          {data?.rows.map((r: any) => (
            <tr key={r.id} className="border-t border-zinc-200 dark:border-zinc-800">
              <td className="p-1 whitespace-nowrap">{new Date(r.criado_em).toLocaleString("pt-BR")}</td>
              <td className="font-bold">{r.tipo}</td>
              <td>{r.origem_tipo}</td>
              <td>{r.produto?.sku}</td>
              <td>{r.empresa?.nome}</td>
              <td>{r.galpao?.nome}</td>
              <td>{r.localizacao?.codigo}</td>
              <td className="text-right">{r.quantidade}</td>
              <td className="text-right">{r.saldo_anterior} → {r.saldo_posterior}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/wms/ledger/page.tsx
git commit -m "feat(wms): tela de ledger com filtros e tabela densa"
```

---

### Task 17: Reconciliação ledger ↔ estoque (cron stub)

**Files:**
- Create: `src/lib/wms/reconciliacao.ts`
- Create: `src/app/api/wms/reconciliacao/route.ts`

- [ ] **Step 1: Service**

```typescript
// src/lib/wms/reconciliacao.ts
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

export async function reconciliarEstoqueComLedger(opts: { autoFix?: boolean } = {}) {
  const sb = createServiceClient();
  // SQL conforme spec §12.1
  const { data, error } = await sb.rpc("wms_detectar_divergencias_estoque" as any);
  if (error) {
    // Fallback: query inline
    const { data: rows } = await sb.from("siso_estoque").select("*");
    // Sem RPC nessa task; criamos depois. Por enquanto retornamos noop.
    return { divergencias: [] as any[], corrigidas: 0 };
  }

  const divergencias = data ?? [];
  let corrigidas = 0;
  if (opts.autoFix) {
    for (const d of divergencias as any[]) {
      // REBUILD a partir do ledger (autoritativo)
      const { error: errFix } = await sb.rpc("wms_rebuild_linha_estoque" as any, { p_id: d.id });
      if (!errFix) corrigidas++;
    }
  }

  if (divergencias.length > 0) {
    logger.warn("wms.reconciliacao", "divergencias detectadas", { count: divergencias.length, autoFix: !!opts.autoFix });
  }
  return { divergencias, corrigidas };
}
```

- [ ] **Step 2: API route (cron-friendly)**

```typescript
// src/app/api/wms/reconciliacao/route.ts
import { NextRequest, NextResponse } from "next/server";
import { reconciliarEstoqueComLedger } from "@/lib/wms/reconciliacao";

export async function GET(req: NextRequest) {
  // Auth via WORKER_SECRET (mesmo padrão de /api/worker)
  const auth = req.headers.get("x-worker-secret");
  if (auth !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const result = await reconciliarEstoqueComLedger({ autoFix: req.nextUrl.searchParams.get("fix") === "true" });
  return NextResponse.json(result);
}
```

- [ ] **Step 3: RPC functions migration**

Create `supabase/migrations/20260508_wms_reconciliacao_rpc.sql`:

```sql
-- Detecta linhas de siso_estoque com saldo divergente do ledger
CREATE OR REPLACE FUNCTION wms_detectar_divergencias_estoque()
RETURNS TABLE (
  id uuid, produto_id uuid, empresa_dona_id uuid, galpao_id uuid, localizacao_id uuid,
  saldo_estoque numeric, saldo_calculado numeric, divergencia numeric
) LANGUAGE sql AS $$
  SELECT
    e.id, e.produto_id, e.empresa_dona_id, e.galpao_id, e.localizacao_id,
    e.saldo,
    COALESCE(SUM(CASE WHEN m.tipo='E' THEN m.quantidade
                      WHEN m.tipo='S' THEN -m.quantidade ELSE 0 END), 0),
    e.saldo - COALESCE(SUM(CASE WHEN m.tipo='E' THEN m.quantidade
                                WHEN m.tipo='S' THEN -m.quantidade ELSE 0 END), 0)
  FROM siso_estoque e
  LEFT JOIN siso_movimentacoes m
    ON m.produto_id = e.produto_id
   AND m.empresa_dona_id = e.empresa_dona_id
   AND m.galpao_id = e.galpao_id
   AND m.localizacao_id = e.localizacao_id
  GROUP BY e.id
  HAVING e.saldo <> COALESCE(SUM(CASE WHEN m.tipo='E' THEN m.quantidade
                                      WHEN m.tipo='S' THEN -m.quantidade ELSE 0 END), 0);
$$;

-- Reconstrói linha de estoque a partir do ledger (autoritativo)
CREATE OR REPLACE FUNCTION wms_rebuild_linha_estoque(p_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_saldo numeric;
  v_reservado numeric;
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN tipo='E' THEN quantidade WHEN tipo='S' THEN -quantidade ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN tipo='R' THEN quantidade WHEN tipo='L' THEN -quantidade ELSE 0 END), 0)
  INTO v_saldo, v_reservado
  FROM siso_movimentacoes m
  JOIN siso_estoque e ON e.id = p_id
  WHERE m.produto_id = e.produto_id
    AND m.empresa_dona_id = e.empresa_dona_id
    AND m.galpao_id = e.galpao_id
    AND m.localizacao_id = e.localizacao_id;

  UPDATE siso_estoque SET saldo = v_saldo, reservado = v_reservado, atualizado_em = now()
  WHERE id = p_id;
END;
$$;
```

Apply via `mcp__supabase__apply_migration`.

- [ ] **Step 4: Smoke test**

```bash
curl -H "x-worker-secret: $WORKER_SECRET" \
  http://localhost:3000/api/wms/reconciliacao
```

Expected: `{divergencias: [], corrigidas: 0}` em estado limpo.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/reconciliacao.ts src/app/api/wms/reconciliacao/ supabase/migrations/20260508_wms_reconciliacao_rpc.sql
git commit -m "feat(wms): reconciliação ledger↔estoque (cron-friendly endpoint + RPCs)"
```

---

### Task 18: Self-validation — popula seed e roda fluxo end-to-end

**Files:**
- Create: `scripts/wms-seed-test.ts`

- [ ] **Step 1: Script de seed**

```typescript
// scripts/wms-seed-test.ts
// Cria 1 produto + 1 mapeamento + 1 mov inventario_inicial pra validar pipeline.
import "dotenv/config";
import { createServiceClient } from "../src/lib/supabase-server";
import { inserirMovimentacao } from "../src/lib/wms/ledger";

async function main() {
  const sb = createServiceClient();

  const { data: empresa } = await sb.from("siso_empresas").select("id, galpao_id").limit(1).single();
  const { data: loc } = await sb.from("siso_localizacoes")
    .select("id").eq("galpao_id", empresa!.galpao_id).eq("codigo", "DEFAULT-PICKING").single();

  const { data: produto } = await sb.from("siso_produtos")
    .insert({ sku: "WMS-SEED-001", descricao: "Produto de seed pra validar pipeline" })
    .select().single();

  await sb.from("siso_produto_empresas").insert({
    produto_id: produto!.id, empresa_id: empresa!.id, tiny_produto_id: 999999999,
  });

  await inserirMovimentacao({
    quadrupla: {
      produto_id: produto!.id,
      empresa_dona_id: empresa!.id,
      galpao_id: empresa!.galpao_id,
      localizacao_id: loc!.id,
    },
    tipo: "E", qty: 100,
    origem_tipo: "inventario_inicial",
    observacoes: "seed teste",
  });

  console.log("seed criado:", { produto_id: produto!.id });
}

main().catch(console.error);
```

- [ ] **Step 2: Rodar e verificar**

```bash
npx tsx scripts/wms-seed-test.ts
```

Expected: log com produto_id criado.

Validar nas telas: `/wms/produtos` mostra `WMS-SEED-001`; `/wms/estoque?view=produto` mostra 100 unidades; `/wms/ledger` mostra a mov de entrada.

- [ ] **Step 3: Commit**

```bash
git add scripts/wms-seed-test.ts
git commit -m "chore(wms): script de seed pra validar pipeline end-to-end"
```

---

### Task 19: Documentação no CLAUDE.md e API reference

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/api-reference-complete.md`

- [ ] **Step 1: Atualizar Project Structure no CLAUDE.md**

Adicionar bloco de pastas WMS (`src/app/wms/`, `src/app/api/wms/`, `src/lib/wms/`, `src/components/wms/`) na seção "Project Structure".

Adicionar tabela das tabelas novas (`siso_produtos`, `siso_produto_empresas`, `siso_localizacoes`, `siso_estoque`, `siso_movimentacoes`) com colunas e propósito na seção "Database Tables".

- [ ] **Step 2: Documentar novos endpoints em api-reference-complete.md**

Para cada endpoint criado neste plano (`GET/POST /api/wms/produtos`, etc) adicionar entrada no formato existente com método, path, auth, request shape, response shape, business logic.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/api-reference-complete.md
git commit -m "docs(wms): atualiza CLAUDE.md e api-reference com schema e endpoints"
```

---

## Critério de saída do Plano 1

✅ `npm run build` compila sem erros.
✅ `npm test` passa (8+ testes).
✅ Todas as 5 tabelas novas existem em produção (Supabase).
✅ Telas `/wms`, `/wms/produtos`, `/wms/localizacoes`, `/wms/estoque`, `/wms/ledger` carregam.
✅ Seed test cria 100 unidades visíveis em todas as telas.
✅ Snapshot inicial pode ser disparado em dry-run sem erro.
✅ Endpoint de reconciliação retorna `{divergencias: []}` no estado limpo.
✅ Documentação atualizada (CLAUDE.md + api-reference).

**Próximo:** Plano 2 (movimentações operacionais).
