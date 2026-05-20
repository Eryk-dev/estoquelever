# Ledger Simplificado 3D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrar o WMS de modelo 4D (com empresa dona como coordenada física) pra 3D (físico fungível por loc + ledger com metadata rica + custo médio global por produto). Arquivar empréstimo, swap e mini-swap. Adicionar 3 relatórios novos.

**Architecture:** Big-bang em branch isolada. Migration única que dropa colunas/tabelas e adiciona novas; reescreve RPCs do ledger; atualiza lib/APIs/frontend em ordem topológica (types → lib → APIs → UI); arquiva código obsoleto em `_archive/`; cria 3 novas páginas de relatório. Sem dados reais em risco — confirmação do user.

**Tech Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Supabase (PostgreSQL + Realtime) · Tailwind 4 · TanStack Query · Sonner · Lucide

**Spec:** `docs/superpowers/specs/2026-05-20-ledger-simplificado-design.md`
**Dormant archive:** `docs/superpowers/archive/`

---

## Fase 0 — Pré-condições

### Task 0.1: Confirmar worktree isolada
- [ ] **Step 1:** Confirmar que o trabalho está numa worktree isolada criada por `superpowers:using-git-worktrees`. Se não estiver, parar e criar antes.

Run: `git rev-parse --show-toplevel && git branch --show-current`
Expected: caminho da worktree + nome de branch tipo `ledger-simplificado-3d`.

### Task 0.2: Verificar premissa zero-dados-reais
- [ ] **Step 1:** Confirmar que `siso_estoque`, `siso_movimentacoes`, `siso_pedido_item_estoques`, `siso_pedido_item_realocacoes` têm apenas dados de teste.

Run via Supabase MCP `mcp__supabase__execute_sql` no projeto principal:
```sql
SELECT
  (SELECT count(*) FROM siso_estoque) AS estoque,
  (SELECT count(*) FROM siso_movimentacoes) AS movs,
  (SELECT count(*) FROM siso_pedido_item_estoques) AS pie,
  (SELECT count(*) FROM siso_pedido_item_realocacoes) AS realoc;
```

Expected: contagens — todas serão truncadas na Task 1.1. Apenas informativo.

- [ ] **Step 2:** Confirmar que `siso_produtos`, `siso_localizacoes`, `siso_empresas`, `siso_galpoes`, `siso_fornecedores` estão preservados (não vão ser truncados).

---

## Fase 1 — Schema Migration (big-bang)

### Task 1.1: Criar migration única
- [ ] **Step 1:** Criar arquivo `supabase/migrations/20260520_ledger_simplificado.sql` com TODO o conteúdo abaixo:

```sql
-- ============================================================================
-- Ledger Simplificado 3D — dropa empresa_dona do físico, cria custo médio global
-- Spec: docs/superpowers/specs/2026-05-20-ledger-simplificado-design.md
-- ============================================================================

BEGIN;

-- 1. DROP tabelas obsoletas (empréstimo regras + mini-swap config)
DROP TABLE IF EXISTS siso_emprestimo_regras CASCADE;
DROP TABLE IF EXISTS siso_wms_mini_swap_config CASCADE;

-- 2. DROP RPCs obsoletas
DROP FUNCTION IF EXISTS wms_executar_mini_swap CASCADE;
DROP FUNCTION IF EXISTS wms_executar_swap CASCADE;
DROP FUNCTION IF EXISTS wms_saldos_devedores CASCADE;

-- 3. TRUNCATE caches operacionais (zero dados reais — confirmado pelo user)
TRUNCATE siso_movimentacoes CASCADE;
TRUNCATE siso_estoque CASCADE;
TRUNCATE siso_pedido_item_estoques CASCADE;
TRUNCATE siso_pedido_item_realocacoes CASCADE;
TRUNCATE siso_wms_pendencias_guarda CASCADE;
TRUNCATE siso_inventario_contagens CASCADE;
TRUNCATE siso_inventario_divergencias CASCADE;
TRUNCATE siso_inventario_localizacoes CASCADE;
TRUNCATE siso_inventario_operadores CASCADE;
TRUNCATE siso_inventario_sessoes CASCADE;

-- 4. ALTER siso_estoque pra 3D
ALTER TABLE siso_estoque
  DROP CONSTRAINT IF EXISTS siso_estoque_produto_dona_galpao_loc_key;
ALTER TABLE siso_estoque DROP COLUMN IF EXISTS empresa_dona_id;
ALTER TABLE siso_estoque DROP COLUMN IF EXISTS custo_medio;
ALTER TABLE siso_estoque
  ADD CONSTRAINT siso_estoque_unique_3d UNIQUE (produto_id, galpao_id, localizacao_id);

-- 5. ALTER siso_movimentacoes — drop colunas obsoletas
ALTER TABLE siso_movimentacoes
  DROP COLUMN IF EXISTS empresa_dona_id,
  DROP COLUMN IF EXISTS emprestimo_devedora_id;

-- 6. ALTER siso_movimentacoes — add metadata nova (todas nullable)
ALTER TABLE siso_movimentacoes
  ADD COLUMN empresa_compradora_id uuid REFERENCES siso_empresas(id),
  ADD COLUMN empresa_vendedora_id  uuid REFERENCES siso_empresas(id),
  ADD COLUMN empresa_referencia_id uuid REFERENCES siso_empresas(id),
  ADD COLUMN fornecedor_id         uuid REFERENCES siso_fornecedores(id),
  ADD COLUMN motivo                text,
  ADD COLUMN cliente_nome          text,
  ADD COLUMN custo_unitario        numeric,
  ADD COLUMN custo_medio_anterior  numeric,
  ADD COLUMN custo_medio_posterior numeric;

-- 7. Atualizar CHECK constraint de origem_tipo
ALTER TABLE siso_movimentacoes
  DROP CONSTRAINT IF EXISTS siso_movimentacoes_origem_tipo_check;
ALTER TABLE siso_movimentacoes
  ADD CONSTRAINT siso_movimentacoes_origem_tipo_check CHECK (origem_tipo IN (
    'nf_compra',
    'devolucao_cliente_integra',
    'devolucao_cliente_avariada',
    'devolucao_fornecedor_recebida',
    'nf_venda',
    'venda_manual',
    'devolucao_fornecedor_enviada',
    'ajuste_manual',
    'ajuste_pick_zerou',
    'inventario_perda',
    'inventario_ganho',
    'inventario_inicial',
    'transferencia_galpao',
    'transferencia_localizacao',
    'reserva_pedido',
    'liberacao_reserva',
    'lancamento_retroativo',
    'estorno'
  ));

-- 8. Criar siso_custo_medio (cache global por produto)
CREATE TABLE siso_custo_medio (
  produto_id              uuid PRIMARY KEY REFERENCES siso_produtos(id) ON DELETE CASCADE,
  custo_medio             numeric NOT NULL DEFAULT 0 CHECK (custo_medio >= 0),
  ultima_movimentacao_id  uuid REFERENCES siso_movimentacoes(id),
  atualizado_em           timestamptz NOT NULL DEFAULT now()
);

-- 9. Realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE siso_custo_medio;

COMMIT;
```

- [ ] **Step 2:** Aplicar migration via Supabase MCP:

Use `mcp__supabase__apply_migration` com:
- project_id: `wrbrbhuhsaaupqsimkqz`
- name: `ledger_simplificado`
- query: (conteúdo do arquivo)

Expected: sucesso. Se falhar por FK violation, identificar tabela faltante no TRUNCATE.

- [ ] **Step 3:** Verificar schema final:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name='siso_movimentacoes'
ORDER BY ordinal_position;
```

Expected: ver `empresa_compradora_id`, `empresa_vendedora_id`, `empresa_referencia_id`, `fornecedor_id`, `motivo`, `cliente_nome`, `custo_unitario`, `custo_medio_anterior`, `custo_medio_posterior` presentes. **Não** ver `empresa_dona_id` nem `emprestimo_devedora_id`.

- [ ] **Step 4:** Commit:
```bash
git add supabase/migrations/20260520_ledger_simplificado.sql
git commit -m "feat(wms): migration ledger simplificado 3D (drop empresa dona, add custo medio)"
```

---

## Fase 2 — Reescrever RPCs

### Task 2.1: Reescrever wms_inserir_movimentacao
- [ ] **Step 1:** Criar `supabase/migrations/20260520b_rpc_inserir_movimentacao.sql`:

```sql
CREATE OR REPLACE FUNCTION wms_inserir_movimentacao(
  p_produto_id            uuid,
  p_galpao_id             uuid,
  p_localizacao_id        uuid,
  p_tipo                  char(1),
  p_quantidade            numeric,
  p_origem_tipo           text,
  p_origem_id             uuid DEFAULT NULL,
  p_origem_detalhes       jsonb DEFAULT NULL,
  p_usuario_id            uuid DEFAULT NULL,
  p_expira_em             timestamptz DEFAULT NULL,
  p_estorno_de            uuid DEFAULT NULL,
  p_empresa_compradora_id uuid DEFAULT NULL,
  p_empresa_vendedora_id  uuid DEFAULT NULL,
  p_empresa_referencia_id uuid DEFAULT NULL,
  p_fornecedor_id         uuid DEFAULT NULL,
  p_motivo                text DEFAULT NULL,
  p_cliente_nome          text DEFAULT NULL,
  p_pedido_id             uuid DEFAULT NULL,
  p_nota_fiscal_id        uuid DEFAULT NULL,
  p_chave_acesso_nf       text DEFAULT NULL,
  p_custo_unitario        numeric DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_mov_id              uuid;
  v_saldo_anterior      numeric;
  v_saldo_posterior     numeric;
  v_reservado_anterior  numeric;
  v_reservado_posterior numeric;
  v_custo_medio_atual   numeric;
  v_custo_medio_novo    numeric;
  v_saldo_global        numeric;
  v_recalcula_custo     boolean;
BEGIN
  -- Validação básica
  IF p_tipo NOT IN ('E','S','R','L') THEN
    RAISE EXCEPTION 'tipo inválido: %', p_tipo;
  END IF;
  IF p_tipo = 'R' AND p_expira_em IS NULL THEN
    RAISE EXCEPTION 'reserva (tipo R) exige expira_em';
  END IF;
  IF p_tipo <> 'R' AND p_expira_em IS NOT NULL THEN
    RAISE EXCEPTION 'expira_em só é válido pra tipo R';
  END IF;

  -- Lock pessimista no cache de estoque
  SELECT saldo, reservado
    INTO v_saldo_anterior, v_reservado_anterior
    FROM siso_estoque
   WHERE produto_id=p_produto_id AND galpao_id=p_galpao_id AND localizacao_id=p_localizacao_id
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Primeira mov da quádrupla — cria linha
    v_saldo_anterior := 0;
    v_reservado_anterior := 0;
    INSERT INTO siso_estoque (produto_id, galpao_id, localizacao_id, saldo, reservado)
    VALUES (p_produto_id, p_galpao_id, p_localizacao_id, 0, 0);
  END IF;

  -- Calcular saldos posteriores
  v_saldo_posterior := v_saldo_anterior;
  v_reservado_posterior := v_reservado_anterior;
  IF p_tipo = 'E' THEN
    v_saldo_posterior := v_saldo_anterior + p_quantidade;
  ELSIF p_tipo = 'S' THEN
    v_saldo_posterior := v_saldo_anterior - p_quantidade;
    IF v_saldo_posterior < 0 THEN
      RAISE EXCEPTION 'saldo insuficiente: % - % < 0', v_saldo_anterior, p_quantidade;
    END IF;
  ELSIF p_tipo = 'R' THEN
    v_reservado_posterior := v_reservado_anterior + p_quantidade;
    IF v_reservado_posterior > v_saldo_anterior THEN
      RAISE EXCEPTION 'reserva excede saldo: % + % > %', v_reservado_anterior, p_quantidade, v_saldo_anterior;
    END IF;
  ELSIF p_tipo = 'L' THEN
    v_reservado_posterior := v_reservado_anterior - p_quantidade;
    IF v_reservado_posterior < 0 THEN
      RAISE EXCEPTION 'liberação excede reservado: % - % < 0', v_reservado_anterior, p_quantidade;
    END IF;
  END IF;

  -- Decidir se recalcula custo médio
  v_recalcula_custo := (p_tipo = 'E'
                        AND p_custo_unitario IS NOT NULL
                        AND p_origem_tipo IN ('nf_compra','devolucao_cliente_integra','lancamento_retroativo'));

  -- Snapshot do custo médio
  SELECT COALESCE(custo_medio, 0) INTO v_custo_medio_atual
    FROM siso_custo_medio WHERE produto_id=p_produto_id FOR UPDATE;
  IF NOT FOUND THEN v_custo_medio_atual := 0; END IF;
  v_custo_medio_novo := v_custo_medio_atual;

  IF v_recalcula_custo THEN
    SELECT COALESCE(SUM(saldo),0) INTO v_saldo_global
      FROM siso_estoque WHERE produto_id=p_produto_id;
    -- v_saldo_global ainda reflete o estado ANTES do UPDATE (linha atual já travada com saldo antigo)
    IF v_saldo_global + p_quantidade > 0 THEN
      v_custo_medio_novo := (v_saldo_global * v_custo_medio_atual + p_quantidade * p_custo_unitario)
                          / (v_saldo_global + p_quantidade);
    ELSE
      v_custo_medio_novo := p_custo_unitario;
    END IF;
  END IF;

  -- Inserir mov
  INSERT INTO siso_movimentacoes (
    produto_id, galpao_id, localizacao_id,
    tipo, quantidade,
    saldo_anterior, saldo_posterior,
    reservado_anterior, reservado_posterior,
    origem_tipo, origem_id, origem_detalhes,
    usuario_id, expira_em, estorno_de,
    empresa_compradora_id, empresa_vendedora_id, empresa_referencia_id,
    fornecedor_id, motivo, cliente_nome,
    pedido_id, nota_fiscal_id, chave_acesso_nf,
    custo_unitario, custo_medio_anterior, custo_medio_posterior
  ) VALUES (
    p_produto_id, p_galpao_id, p_localizacao_id,
    p_tipo, p_quantidade,
    v_saldo_anterior, v_saldo_posterior,
    v_reservado_anterior, v_reservado_posterior,
    p_origem_tipo, p_origem_id, p_origem_detalhes,
    p_usuario_id, p_expira_em, p_estorno_de,
    p_empresa_compradora_id, p_empresa_vendedora_id, p_empresa_referencia_id,
    p_fornecedor_id, p_motivo, p_cliente_nome,
    p_pedido_id, p_nota_fiscal_id, p_chave_acesso_nf,
    p_custo_unitario, v_custo_medio_atual, v_custo_medio_novo
  ) RETURNING id INTO v_mov_id;

  -- Atualizar cache de estoque
  UPDATE siso_estoque
     SET saldo = v_saldo_posterior,
         reservado = v_reservado_posterior,
         atualizado_em = now()
   WHERE produto_id=p_produto_id AND galpao_id=p_galpao_id AND localizacao_id=p_localizacao_id;

  -- Atualizar cache de custo médio (se recalculou)
  IF v_recalcula_custo THEN
    INSERT INTO siso_custo_medio (produto_id, custo_medio, ultima_movimentacao_id, atualizado_em)
    VALUES (p_produto_id, v_custo_medio_novo, v_mov_id, now())
    ON CONFLICT (produto_id) DO UPDATE
      SET custo_medio = EXCLUDED.custo_medio,
          ultima_movimentacao_id = EXCLUDED.ultima_movimentacao_id,
          atualizado_em = EXCLUDED.atualizado_em;
  END IF;

  RETURN v_mov_id;
END;
$$;
```

- [ ] **Step 2:** Aplicar migration via Supabase MCP `apply_migration`.

- [ ] **Step 3:** Smoke test direto no banco:

```sql
-- Setup mínimo: produto + galpão + loc + empresa + fornecedor
WITH params AS (
  SELECT p.id AS produto_id, l.galpao_id, l.id AS loc_id,
         (SELECT id FROM siso_empresas LIMIT 1) AS empresa_id,
         (SELECT id FROM siso_fornecedores LIMIT 1) AS fornecedor_id
  FROM siso_produtos p JOIN siso_localizacoes l ON l.tipo='picking' LIMIT 1
)
SELECT wms_inserir_movimentacao(
  params.produto_id, params.galpao_id, params.loc_id,
  'E', 10, 'nf_compra',
  p_empresa_compradora_id := params.empresa_id,
  p_fornecedor_id := params.fornecedor_id,
  p_custo_unitario := 15.50
) FROM params;
```

Expected: retorna UUID. Verificar com:
```sql
SELECT saldo FROM siso_estoque ORDER BY atualizado_em DESC LIMIT 1;
-- = 10
SELECT custo_medio FROM siso_custo_medio ORDER BY atualizado_em DESC LIMIT 1;
-- = 15.50
```

- [ ] **Step 4:** Commit:
```bash
git add supabase/migrations/20260520b_rpc_inserir_movimentacao.sql
git commit -m "feat(wms): RPC wms_inserir_movimentacao com custo médio global + tags de empresa"
```

### Task 2.2: Reescrever wms_reservar_atomico (3D, sem dona)
- [ ] **Step 1:** Criar `supabase/migrations/20260520c_rpc_reservar.sql`:

```sql
CREATE OR REPLACE FUNCTION wms_reservar_atomico(
  p_produto_id     uuid,
  p_galpao_id      uuid,
  p_localizacao_id uuid,
  p_quantidade     numeric,
  p_pedido_id      uuid,
  p_ttl_horas      integer DEFAULT 48,
  p_usuario_id     uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_mov_id uuid;
BEGIN
  v_mov_id := wms_inserir_movimentacao(
    p_produto_id, p_galpao_id, p_localizacao_id,
    'R', p_quantidade, 'reserva_pedido',
    p_origem_id := p_pedido_id,
    p_pedido_id := p_pedido_id,
    p_usuario_id := p_usuario_id,
    p_expira_em := now() + (p_ttl_horas || ' hours')::interval
  );
  RETURN v_mov_id;
END;
$$;
```

- [ ] **Step 2:** Aplicar + commit:
```bash
git commit -m "feat(wms): RPC wms_reservar_atomico 3D"
```

### Task 2.3: Reescrever wms_detectar_divergencias_estoque + wms_rebuild_linha_estoque
- [ ] **Step 1:** Criar `supabase/migrations/20260520d_rpc_reconciliacao.sql`:

```sql
CREATE OR REPLACE FUNCTION wms_detectar_divergencias_estoque()
RETURNS TABLE (
  estoque_id     uuid,
  produto_id     uuid,
  galpao_id      uuid,
  localizacao_id uuid,
  saldo_cache    numeric,
  saldo_ledger   numeric,
  delta          numeric
)
LANGUAGE sql AS $$
  SELECT e.id, e.produto_id, e.galpao_id, e.localizacao_id,
         e.saldo,
         COALESCE(
           SUM(CASE m.tipo WHEN 'E' THEN m.quantidade WHEN 'S' THEN -m.quantidade ELSE 0 END),
           0
         ) AS saldo_ledger,
         e.saldo - COALESCE(
           SUM(CASE m.tipo WHEN 'E' THEN m.quantidade WHEN 'S' THEN -m.quantidade ELSE 0 END),
           0
         ) AS delta
    FROM siso_estoque e
    LEFT JOIN siso_movimentacoes m
      ON m.produto_id=e.produto_id
     AND m.galpao_id=e.galpao_id
     AND m.localizacao_id=e.localizacao_id
   GROUP BY e.id, e.produto_id, e.galpao_id, e.localizacao_id, e.saldo
  HAVING e.saldo <> COALESCE(
    SUM(CASE m.tipo WHEN 'E' THEN m.quantidade WHEN 'S' THEN -m.quantidade ELSE 0 END),
    0
  );
$$;

CREATE OR REPLACE FUNCTION wms_rebuild_linha_estoque(p_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_saldo numeric; v_reservado numeric; v_produto uuid; v_galpao uuid; v_loc uuid;
BEGIN
  SELECT produto_id, galpao_id, localizacao_id INTO v_produto, v_galpao, v_loc
    FROM siso_estoque WHERE id=p_id;

  SELECT
    COALESCE(SUM(CASE tipo WHEN 'E' THEN quantidade WHEN 'S' THEN -quantidade ELSE 0 END), 0),
    COALESCE(SUM(CASE tipo WHEN 'R' THEN quantidade WHEN 'L' THEN -quantidade ELSE 0 END), 0)
  INTO v_saldo, v_reservado
    FROM siso_movimentacoes
   WHERE produto_id=v_produto AND galpao_id=v_galpao AND localizacao_id=v_loc;

  UPDATE siso_estoque
     SET saldo=v_saldo, reservado=GREATEST(0,v_reservado), atualizado_em=now()
   WHERE id=p_id;
END;
$$;
```

- [ ] **Step 2:** Aplicar + commit.

### Task 2.4: Reescrever wms_inventario_proxima_loc + wms_inventario_sugerir
- [ ] **Step 1:** Ler RPCs atuais via `mcp__supabase__execute_sql`:

```sql
SELECT pg_get_functiondef('wms_inventario_proxima_loc'::regproc::oid);
SELECT pg_get_functiondef('wms_inventario_sugerir'::regproc::oid);
```

- [ ] **Step 2:** Criar `supabase/migrations/20260520e_rpc_inventario.sql` — copiar definições atuais e remover qualquer referência a `empresa_dona_id` (parâmetro `p_empresa_dona` no sugerir, filtro/join em proxima_loc se houver).

- [ ] **Step 3:** Aplicar + commit.

### Task 2.5: Refresh materialized views
- [ ] **Step 1:** Criar `supabase/migrations/20260520f_mviews.sql`:

```sql
-- Recriar siso_curva_abc sem empresa_dona
DROP MATERIALIZED VIEW IF EXISTS siso_curva_abc CASCADE;
CREATE MATERIALIZED VIEW siso_curva_abc AS
SELECT
  m.produto_id,
  m.galpao_id,
  SUM(m.quantidade) AS giro_30d,
  PERCENT_RANK() OVER (PARTITION BY m.galpao_id ORDER BY SUM(m.quantidade)) AS pct_giro,
  CASE
    WHEN PERCENT_RANK() OVER (PARTITION BY m.galpao_id ORDER BY SUM(m.quantidade)) >= 0.8 THEN 'A'
    WHEN PERCENT_RANK() OVER (PARTITION BY m.galpao_id ORDER BY SUM(m.quantidade)) >= 0.5 THEN 'B'
    ELSE 'C'
  END AS curva
FROM siso_movimentacoes m
WHERE m.tipo='S'
  AND m.origem_tipo IN ('nf_venda','venda_manual')
  AND m.criado_em >= now() - interval '30 days'
  AND m.estorno_de IS NULL
GROUP BY m.produto_id, m.galpao_id;
CREATE INDEX siso_curva_abc_produto_galpao_idx ON siso_curva_abc (produto_id, galpao_id);

-- Recriar siso_cobertura_estoque (se referencia empresa_dona)
-- Verificar e regenerar igual padrão.

CREATE OR REPLACE FUNCTION wms_refresh_curva_abc() RETURNS void LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW siso_curva_abc;
$$;
```

- [ ] **Step 2:** Antes de aplicar, ler definição atual de `siso_cobertura_estoque` e adaptar pra 3D do mesmo jeito.

- [ ] **Step 3:** Aplicar + commit:
```bash
git commit -m "feat(wms): materialized views ABC + cobertura em 3D"
```

---

## Fase 3 — Arquivar código obsoleto

### Task 3.1: Criar pasta _archive e mover arquivos
- [ ] **Step 1:** Criar diretório:
```bash
mkdir -p src/lib/wms/_archive
```

- [ ] **Step 2:** Mover arquivos com `git mv` (ou `mv` se untracked):
```bash
for f in emprestimos.ts mini-swap.ts mini-swap-types.ts mini-swap.test.ts swap.ts swap-cenarios-extras.test.ts; do
  test -f "src/lib/wms/$f" && mv "src/lib/wms/$f" "src/lib/wms/_archive/$f"
done
```

- [ ] **Step 3:** Adicionar header de archive em cada arquivo movido. Editar primeira linha:
```ts
// ARCHIVED 2026-05-20 — see docs/superpowers/archive/README.md
// This module is no longer imported anywhere. Kept as reference for the
// 4D ownership model in case it gets resurrected.
```

- [ ] **Step 4:** Commit:
```bash
git add -A src/lib/wms/
git commit -m "chore(wms): arquivar emprestimos/swap/mini-swap em _archive/"
```

### Task 3.2: Arquivar páginas e APIs obsoletas
- [ ] **Step 1:** Deletar APIs obsoletas:
```bash
rm -rf src/app/api/wms/emprestimo-regras
rm -rf src/app/api/wms/emprestimos
rm -rf src/app/api/wms/mini-swap
rm -rf src/app/api/wms/swap
```

- [ ] **Step 2:** Deletar páginas obsoletas:
```bash
rm -rf src/app/wms/emprestimos
rm -rf src/app/wms/configuracoes/otimizacoes
```

- [ ] **Step 3:** Deletar componente obsoleto:
```bash
rm src/components/wms/configuracoes/aba-emprestimos.tsx
```

- [ ] **Step 4:** Commit:
```bash
git add -A
git commit -m "chore(wms): deletar APIs e páginas de empréstimos/swap/mini-swap"
```

---

## Fase 4 — Atualizar tipos core

### Task 4.1: Atualizar src/lib/wms/types.ts
- [ ] **Step 1:** Ler `src/lib/wms/types.ts`.

- [ ] **Step 2:** Aplicar mudanças:
  - Renomear `Quadrupla` → `Tripla` (e mudar interface: drop `empresa_dona_id`)
  - `Estoque`: drop `empresa_dona_id`, drop `custo_medio`
  - `Movimentacao`: drop `empresa_dona_id`, `emprestimo_devedora_id`. ADD nullable: `empresa_compradora_id`, `empresa_vendedora_id`, `empresa_referencia_id`, `fornecedor_id`, `motivo`, `cliente_nome`, `custo_unitario`, `custo_medio_anterior`, `custo_medio_posterior`
  - Atualizar `OrigemTipo` (union de strings) com a lista nova da §3.4 do spec — remover `emprestimo`, `swap`, `troca_sku_in`, `troca_sku_out`, `cancelamento_nf`. Adicionar `ajuste_pick_zerou`, `devolucao_fornecedor_recebida`, `devolucao_fornecedor_enviada`.
  - Renomear `PerspectivaEstoque` — remover `'dono'`, manter `'galpao' | 'localizacao' | 'produto'`.
  - Adicionar tipo `CustoMedio`: `{ produto_id: string; custo_medio: number; ultima_movimentacao_id: string | null; atualizado_em: string }`.

- [ ] **Step 3:** Build incremental (vai falhar — esperado):
```bash
npm run build 2>&1 | head -50
```
Expected: erros em arquivos que importam `Quadrupla`/`empresa_dona_id`.

- [ ] **Step 4:** Commit:
```bash
git add src/lib/wms/types.ts
git commit -m "refactor(wms/types): Quadrupla→Tripla, drop empresa_dona, add metadata"
```

### Task 4.2: Atualizar src/types/index.ts (types raiz)
- [ ] **Step 1:** Ler `src/types/index.ts`.
- [ ] **Step 2:** Grep `empresa_dona`, `emprestimo`, `swap` no arquivo. Pra cada referência:
  - Remover propriedades de tipos
  - Atualizar unions
- [ ] **Step 3:** Commit:
```bash
git commit -m "refactor(types): drop empresa_dona references"
```

---

## Fase 5 — Atualizar core lib

> **Padrão pra todas as tasks desta fase:** abrir o arquivo, grep `empresa_dona` + `empresa_dona_id` + `emprestimo_devedora_id`, remover refs. Atualizar assinaturas de função. Ajustar queries SQL pra 3D. Rodar `npm run build` ao final pra verificar progresso.

### Task 5.1: src/lib/wms/ledger.ts
- [ ] **Step 1:** Atualizar `inserirMovimentacao()` — nova assinatura batendo com a RPC (params nullable: empresa_compradora_id, empresa_vendedora_id, empresa_referencia_id, fornecedor_id, motivo, cliente_nome, custo_unitario; remover empresa_dona).
- [ ] **Step 2:** Atualizar `validarCoerencia()` pra agrupar por (produto, galpão, loc) sem dona.
- [ ] **Step 3:** Atualizar `ledger.test.ts` se existir.
- [ ] **Step 4:** Build + commit.

### Task 5.2: src/lib/wms/estoque.ts
- [ ] **Step 1:** Remover view `'dono'`. Manter `'galpao' | 'localizacao' | 'produto'`.
- [ ] **Step 2:** Atualizar queries: dropar `empresa_dona_id` de SELECT/GROUP BY.
- [ ] **Step 3:** Build + commit.

### Task 5.3: src/lib/wms/custo-medio.ts (NOVO)
- [ ] **Step 1:** Criar arquivo `src/lib/wms/custo-medio.ts`:

```ts
import { createServiceClient } from '@/lib/supabase-server';
import type { CustoMedio } from './types';

export async function obterCustoMedio(produtoId: string): Promise<number> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('siso_custo_medio')
    .select('custo_medio')
    .eq('produto_id', produtoId)
    .maybeSingle();
  return data?.custo_medio ?? 0;
}

export async function listarCustosMedios(): Promise<CustoMedio[]> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('siso_custo_medio')
    .select('produto_id, custo_medio, ultima_movimentacao_id, atualizado_em')
    .order('atualizado_em', { ascending: false });
  return data ?? [];
}

/**
 * Função pura — calcula novo custo médio.
 * saldo_global = saldo total do produto somando todas as locs+galpões (snapshot antes da entrada)
 */
export function calcularNovoCustoMedio(
  saldoGlobalAtual: number,
  custoAtual: number,
  qtyEntrada: number,
  custoUnitarioEntrada: number,
): number {
  if (saldoGlobalAtual + qtyEntrada <= 0) {
    return custoUnitarioEntrada;
  }
  return (saldoGlobalAtual * custoAtual + qtyEntrada * custoUnitarioEntrada)
       / (saldoGlobalAtual + qtyEntrada);
}
```

- [ ] **Step 2:** Criar `src/lib/wms/custo-medio.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { calcularNovoCustoMedio } from './custo-medio';

describe('calcularNovoCustoMedio', () => {
  it('primeira entrada absoluta (saldo zero, custo zero) → custo da entrada', () => {
    expect(calcularNovoCustoMedio(0, 0, 10, 15.50)).toBe(15.50);
  });
  it('entrada normal com saldo positivo → média ponderada', () => {
    expect(calcularNovoCustoMedio(10, 15.50, 5, 20)).toBeCloseTo(17.0, 2);
  });
  it('entrada após saldo global zero (mas custo médio guardado) → vira custo da entrada', () => {
    expect(calcularNovoCustoMedio(0, 17.0, 8, 12)).toBe(12);
  });
  it('entrada com custo zero → reduz média ponderada', () => {
    expect(calcularNovoCustoMedio(10, 20, 10, 0)).toBe(10);
  });
  it('mesma média se custos iguais', () => {
    expect(calcularNovoCustoMedio(50, 25, 50, 25)).toBe(25);
  });
});
```

- [ ] **Step 3:** Rodar:
```bash
npx vitest run src/lib/wms/custo-medio.test.ts
```
Expected: 5 passed.

- [ ] **Step 4:** Commit:
```bash
git commit -m "feat(wms): custo-medio lib + função pura testada"
```

### Task 5.4: src/lib/wms/movimentacoes.ts
- [ ] **Step 1:** Atualizar todos os helpers (receber, transferirInterGalpao, replenishmentIntraGalpao, ajustarEstoque, lancarRetroativo): assinaturas sem `empresa_dona`, com novos params relevantes (compradora pra receber, fornecedor pra receber, etc.).
- [ ] **Step 2:** Build + commit.

### Task 5.5: src/lib/wms/reservas.ts
- [ ] **Step 1:** Atualizar `reservarAtomico`, `liberarReserva`, `cleanupReservasExpiradas` pra 3D (sem dona).
- [ ] **Step 2:** Build + commit.

### Task 5.6: src/lib/wms/inventario.ts
- [ ] **Step 1:** Remover toda referência a `empresa_dona_id` (era opcional na sessão — drop).
- [ ] **Step 2:** Atualizar queries e tipos retornados.
- [ ] **Step 3:** Build + commit.

### Task 5.7: src/lib/wms/inventario-reconciliacao.ts (+ teste)
- [ ] **Step 1:** Remover agrupamento por `empresa_dona_id` em `reconciliarTemporal`. Group key vira `(produto, galpao, loc)`.
- [ ] **Step 2:** Atualizar `inventario-reconciliacao.test.ts` — remover fixtures de dona.
- [ ] **Step 3:** Rodar testes:
```bash
npx vitest run src/lib/wms/inventario-reconciliacao.test.ts
```
- [ ] **Step 4:** Build + commit.

### Task 5.8: src/lib/wms/devolucoes.ts (+ teste)
- [ ] **Step 1:** Trocar uso de `empresa_dona_id` por `empresa_referencia_id` (apontando pra vendedora da NF original) em todas as 4 classificações (A/B/C/D).
- [ ] **Step 2:** Atualizar `devolucoes.test.ts`.
- [ ] **Step 3:** Build + commit.

### Task 5.9: src/lib/wms/guarda.ts
- [ ] **Step 1:** Atualizar `resolverLocRecebimento` e `confirmarGuarda`: par S+E neutro (sem dona).
- [ ] **Step 2:** `siso_wms_pendencias_guarda` ainda tem `empresa_dona_id`? Se sim, dropar coluna via migration nova.

Check: `mcp__supabase__execute_sql` →
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name='siso_wms_pendencias_guarda';
```

Se tiver `empresa_dona_id`, criar `supabase/migrations/20260520g_drop_dona_pendencias.sql`:
```sql
ALTER TABLE siso_wms_pendencias_guarda DROP COLUMN IF EXISTS empresa_dona_id;
```
Aplicar.

- [ ] **Step 3:** Build + commit.

### Task 5.10: src/lib/wms/putaway.ts
- [ ] **Step 1:** Atualizar `sugerirLocalizacaoPutaway` — drop empresa_dona como input/filter.
- [ ] **Step 2:** Build + commit.

### Task 5.11: src/lib/wms/roteamento.ts (+ teste)
- [ ] **Step 1:** Mudança grande: a decisão "propria" passa a usar pool físico do galpão origem, sem ordem por empresa.
  - `rotearPedidoDoBanco`: dropa lógica de iteração por tier de empresa. Vira: "tem saldo no galpão origem ≥ qty? OK. Senão tenta outro galpão com saldo, marca como transferência."
  - Drop `empresa_dona` filter em queries de saldo.
- [ ] **Step 2:** Atualizar `roteamento.test.ts` — remover testes de empréstimo/tier. Adicionar testes de pool fungível.
- [ ] **Step 3:** Rodar testes:
```bash
npx vitest run src/lib/wms/roteamento.test.ts
```
- [ ] **Step 4:** Build + commit.

### Task 5.12: src/lib/wms/reconciliacao.ts
- [ ] **Step 1:** Atualizar pra 3D (drop dona dos grouping).
- [ ] **Step 2:** Build + commit.

### Task 5.13: src/lib/wms/snapshot-inicial.ts
- [ ] **Step 1:** Drop empresa_dona como param/loop. Mov gerada usa `empresa_compradora_id` (empresa do tiny do produto) como tag histórica, não como coordenada.
- [ ] **Step 2:** Build + commit.

### Task 5.14: src/lib/wms/transferencias.ts
- [ ] **Step 1:** Drop empresa_dona, par S+E neutro.
- [ ] **Step 2:** Build + commit.

### Task 5.15: src/lib/wms/vendas-disponibilidade.ts
- [ ] **Step 1:** `resolverDisponibilidadeVenda` — drop ordem "empresa origem do pedido primeiro". Vira: ordem por tipo loc (picking > overstock > recebimento > outros) e por maior saldo disponível.
- [ ] **Step 2:** Build + commit.

### Task 5.16: src/lib/wms/cobertura.ts
- [ ] **Step 1:** Drop empresa_dona se houver.
- [ ] **Step 2:** Build + commit.

### Task 5.17: src/lib/wms/dashboard-geral.ts
- [ ] **Step 1:** Remover qualquer contador relacionado a empréstimos/swap/mini-swap.
- [ ] **Step 2:** Build + commit.

### Task 5.18: src/lib/wms/cutover.ts
- [ ] **Step 1:** Drop empresa_dona.
- [ ] **Step 2:** Build + commit.

### Task 5.19: src/lib/wms/kits.ts
- [ ] **Step 1:** Drop empresa_dona.
- [ ] **Step 2:** Build + commit.

### Task 5.20: src/lib/wms/insights/queries.ts + insights/types.ts
- [ ] **Step 1:** Drop empresa_dona dos filtros e tipos de retorno.
- [ ] **Step 2:** Build + commit.

### Task 5.21: src/lib/separacao/realocacao-resolver.ts (+ teste)
- [ ] **Step 1:** Drop empresa_dona da assinatura. Cascade vira: busca próxima loc no galpão excluindo locs já tentadas (sem filtro por empresa).
- [ ] **Step 2:** Atualizar teste.
- [ ] **Step 3:** Build + commit.

### Task 5.22: Webhook + Worker — webhook-processor.ts, webhook-processor-wms.ts, execution-worker-wms.ts
- [ ] **Step 1:** `webhook-processor-wms.ts`:
  - Drop reserva por dona — `reservarAtomico(produto, galpão, loc, qty, pedido)`
  - Drop lógica de empréstimo (rota mista que decidia devedora)
  - Decisão "propria" via pool do galpão origem
- [ ] **Step 2:** `webhook-processor.ts` (legacy) — mesma simplificação, ou substituir por chamadas ao `-wms` se já está em cutover.
- [ ] **Step 3:** `execution-worker-wms.ts`:
  - Saída via `nf_venda` com `empresa_vendedora_id` (= empresa origem do pedido) + `pedido_id`
  - Drop `emprestimo_devedora_id`, drop ordem por tier
- [ ] **Step 4:** Verificar se existe `src/lib/execution-worker.ts` legacy e atualizar igual.
- [ ] **Step 5:** Build + commit:
```bash
git commit -m "refactor(wms/worker): webhook + execution worker em 3D, sem empréstimo"
```

### Task 5.23: src/lib/nf-webhook-handler.ts
- [ ] **Step 1:** Devolução detectada via NF — usar `empresa_referencia_id`.
- [ ] **Step 2:** Build + commit.

### Task 5.24: src/lib/grupo-resolver.ts
- [ ] **Step 1:** Remover agregação de estoque por empresa. Mantém só "qual grupo a empresa pertence" pra fins de display.
- [ ] **Step 2:** Build + commit.

### Task 5.25: src/lib/historico-service.ts
- [ ] **Step 1:** Remover eventos `emprestimo_*` e `swap_*` do registro de histórico.
- [ ] **Step 2:** Build + commit.

### Task 5.26: src/lib/tiny-stub.ts
- [ ] **Step 1:** Drop empresa_dona dos mocks.
- [ ] **Step 2:** Build + commit.

### Task 5.27: Build limpo da camada lib
- [ ] **Step 1:** `npm run build 2>&1 | grep -i "error" | head -20`
- [ ] **Step 2:** Resolver qualquer erro remanescente em libs.
- [ ] **Step 3:** Commit final da fase:
```bash
git commit --allow-empty -m "checkpoint: fase 5 lib core completa"
```

---

## Fase 6 — Atualizar APIs (rotas)

> **Padrão:** abrir o `route.ts`, atualizar handler. Onde dropar param do query/body — atualizar JSDoc + frontend caller na Fase 7. Onde mov é gerada — passar empresa_compradora/vendedora/referencia conforme spec §5.

### Task 6.1: /api/wms/estoque/route.ts
- [ ] Drop `?view=dono` no query parser. Manter `galpao | localizacao | produto`.
- [ ] Commit.

### Task 6.2: /api/wms/ledger/route.ts
- [ ] Retornar novos campos no payload: `empresa_compradora_id`, `empresa_vendedora_id`, `empresa_referencia_id`, `fornecedor_id`, `motivo`, `cliente_nome`, `custo_unitario`, `custo_medio_anterior`, `custo_medio_posterior`.
- [ ] Drop `empresa_dona_id` do filtro.
- [ ] Commit.

### Task 6.3: /api/wms/receber/route.ts
- [ ] Body: drop `empresa_dona_id`. Add `empresa_compradora_id` (obrigatório quando origem='nf_compra'), `fornecedor_id` (obrigatório), `custo_unitario` (obrigatório), `nota_fiscal_id` (opcional), `chave_acesso_nf` (opcional).
- [ ] Modo `entrada_direta`: aceita mesma estrutura, escreve direto na loc destino.
- [ ] Lote: itera mesma estrutura por item.
- [ ] Commit.

### Task 6.4: /api/wms/guarda/route.ts + [id]/* (todos)
- [ ] Cada route file: drop empresa_dona_id de queries/responses.
- [ ] `confirmar`: par S+E neutro (sem dona).
- [ ] `imprimir-lote` e `imprimir`: drop empresa_dona dos templates ZPL se houver.
- [ ] Files: route.ts, rota/route.ts, [id]/route.ts, [id]/iniciar/route.ts, [id]/confirmar/route.ts, [id]/cancelar/route.ts, [id]/imprimir/route.ts, imprimir-lote/route.ts.
- [ ] Commit:
```bash
git commit -m "refactor(api/guarda): 3D, par S+E neutro"
```

### Task 6.5: /api/wms/transferir-galpao/route.ts
- [ ] Drop empresa_dona. Par S+E neutro com mesmo origem_id.
- [ ] Commit.

### Task 6.6: /api/wms/replenishment/route.ts
- [ ] Drop empresa_dona. Par S+E neutro.
- [ ] Commit.

### Task 6.7: /api/wms/ajuste/route.ts
- [ ] Drop empresa_dona. `motivo` obrigatório (validar ≥3 chars).
- [ ] Commit.

### Task 6.8: /api/wms/lancamento-retroativo/route.ts (+ [id]/reconciliar)
- [ ] Drop empresa_dona. Add empresa_compradora (opcional) + custo_unitario (opcional).
- [ ] Commit.

### Task 6.9: /api/wms/reconciliacao/route.ts
- [ ] Drop empresa_dona no GET response.
- [ ] Commit.

### Task 6.10: /api/wms/snapshot-inicial/route.ts
- [ ] Drop empresa_dona — usar empresa_compradora como tag histórica.
- [ ] Commit.

### Task 6.11: /api/wms/rotear/route.ts
- [ ] Body: drop empresa_dona. Resposta: drop devedora/empréstimo.
- [ ] Commit.

### Task 6.12: /api/wms/reservas/cleanup/route.ts
- [ ] Drop empresa_dona.
- [ ] Commit.

### Task 6.13: /api/wms/inventario/route.ts + sugerir + [id]/* (todos)
- [ ] Cada route file: drop empresa_dona_id de params/body/response.
- [ ] `sugerir`: drop param `empresa_dona`.
- [ ] `[id]/aplicar`: gera movs sem dona, com `inventario_perda` / `inventario_ganho`.
- [ ] `[id]/aprovar`: drop empresa_dona dos grouping.
- [ ] `[id]/eventos`: drop empresa_dona do feed.
- [ ] `[id]/proxima-loc`: drop param.
- [ ] `[id]/contagens` (POST): drop empresa_dona_id do body.
- [ ] `[id]/divergencias`: drop dona.
- [ ] `metricas`: drop dona.
- [ ] Files (TODOS): route.ts, sugerir, [id]/route.ts, [id]/iniciar, [id]/party, [id]/proxima-loc, [id]/aprovar, [id]/aprovar-sessao, [id]/aplicar, [id]/contagens, [id]/divergencias, [id]/eventos, [id]/localizacoes/[locId]/finalizar, metricas, cleanup.
- [ ] Commit:
```bash
git commit -m "refactor(api/inventario): drop empresa_dona em toda fila"
```

### Task 6.14: /api/wms/separacao/marcar-item/route.ts
- [ ] Mov de saída: `empresa_vendedora_id` (do pedido), `pedido_id`, `origem_tipo='nf_venda'`.
- [ ] Drop empresa_dona.
- [ ] Commit.

### Task 6.15: /api/wms/separacao/parcial/route.ts
- [ ] Mov 1 (saída parcial): empresa_vendedora + pedido_id + origem='nf_venda'.
- [ ] Mov 2 (ajuste loc zerou): origem='ajuste_pick_zerou', motivo='loc zerou no bipe', sem empresa.
- [ ] Re-busca cascade (chama realocacao-resolver) — sem empresa_dona.
- [ ] Commit.

### Task 6.16: /api/wms/separacao/bipar + bipar-checklist
- [ ] Drop empresa_dona dos params e movs geradas.
- [ ] Commit.

### Task 6.17: /api/wms/separacao/marcar-realocacao + realocacao/[id]
- [ ] Drop empresa_dona. Mov de pick da realocação com empresa_vendedora do pedido.
- [ ] Commit.

### Task 6.18: /api/wms/separacao/desfazer-parcial + desfazer-bip
- [ ] Estorno mantém metadata original. Drop empresa_dona.
- [ ] Commit.

### Task 6.19: /api/wms/separacao/iniciar/route.ts
- [ ] Se referencia mini-swap, dropa toda essa parte (mini-swap arquivado).
- [ ] Commit.

### Task 6.20: /api/wms/separacao/checklist-items/route.ts
- [ ] Drop empresa_dona da query/response.
- [ ] Commit.

### Task 6.21: /api/wms/separacao/* (resto — bipar-embalagem, confirmar-item-embalagem, encaminhar, cancelar, reiniciar, etc.)
- [ ] Grep empresa_dona em cada `src/app/api/wms/separacao/**/route.ts`. Drop refs.
- [ ] Commit:
```bash
git commit -m "refactor(api/separacao): drop empresa_dona de todas as rotas"
```

### Task 6.22: /api/wms/vendas/criar/route.ts
- [ ] Modo `baixa_direta`: mov de saída com `empresa_vendedora_id` (= empresa origem do pedido), `pedido_id`, `origem_tipo='venda_manual'`, `cliente_nome` se informado.
- [ ] Drop empresa_dona da resolução de loc (já chama vendas-disponibilidade que foi atualizado).
- [ ] Commit.

### Task 6.23: /api/wms/vendas/disponibilidade/route.ts
- [ ] Drop param `empresa_origem_id` da ordem de resolução (já refletido na lib).
- [ ] Response: drop campos relacionados a dona.
- [ ] Commit.

### Task 6.24: /api/wms/devolucoes/[id]/classificar/route.ts
- [ ] Use empresa_referencia_id (=vendedora da NF original) em todas as 4 classificações.
- [ ] Commit.

### Task 6.25: /api/wms/localizacoes/[id]/saldos + substituir-e-excluir
- [ ] Drop empresa_dona_id de queries e proteção.
- [ ] `substituir-e-excluir`: move saldo de loc A pra B sem mexer em dona (par S+E neutro).
- [ ] Commit.

### Task 6.26: /api/wms/produtos/[id]/kit/route.ts
- [ ] Drop empresa_dona.
- [ ] Commit.

### Task 6.27: /api/wms/insights/financeiro/route.ts
- [ ] Drop qualquer KPI relacionado a empréstimo/swap.
- [ ] Commit.

### Task 6.28: /api/wms/transferencias/route.ts (+ [id]/*)
- [ ] Drop empresa_dona da lista e detalhes.
- [ ] Commit.

### Task 6.29: Build APIs limpo
- [ ] `npm run build 2>&1 | grep -i error | head -20`
- [ ] Resolver erros remanescentes.
- [ ] Commit checkpoint:
```bash
git commit --allow-empty -m "checkpoint: fase 6 APIs completa"
```

---

## Fase 7 — Atualizar Frontend (componentes + páginas)

> **Padrão UI:** abrir página, grep `empresa_dona` / `empresaDona` / `dona`, remover refs. Atualizar forms (drop seletor de empresa dona). Atualizar tabelas (drop coluna "Dona"). Atualizar tipos importados. Visual: rodar `npm run dev` e checar página no browser. Capturar screenshots se preciso.

### Task 7.1: src/components/wms/wms-shell.tsx
- [ ] **Step 1:** Remover item "Empréstimos" da sidebar.
- [ ] **Step 2:** Adicionar novo grupo "Relatórios" com 3 itens: "Movs por Empresa", "Histórico de Custo", "Saldos por Empresa". URLs: `/wms/relatorios/movs-por-empresa`, `/wms/relatorios/historico-custo`, `/wms/relatorios/saldos-por-empresa`.
- [ ] **Step 3:** Remover toggle de Mini-Swap (link pra /wms/configuracoes/otimizacoes).
- [ ] **Step 4:** Commit.

### Task 7.2: src/components/wms/quadrupla-picker.tsx → tripla-picker
- [ ] **Step 1:** Renomear arquivo: `mv src/components/wms/quadrupla-picker.tsx src/components/wms/tripla-picker.tsx`
- [ ] **Step 2:** Remover input de empresa dona. Componente passa a ter 3 selects: galpão, loc.
- [ ] **Step 3:** Atualizar todos os imports do projeto:
```bash
grep -rl "quadrupla-picker\|QuadruplaPicker" src/ --include="*.tsx" --include="*.ts"
```
Pra cada arquivo: renomear import + componente JSX.
- [ ] **Step 4:** Commit:
```bash
git commit -m "refactor(ui): QuadruplaPicker → TriplaPicker (drop dona)"
```

### Task 7.3: src/components/wms/produto-drawer.tsx
- [ ] Drop seção "Por dona". Mostrar saldo total por galpão.
- [ ] Adicionar exibição de custo médio global do produto.
- [ ] Commit.

### Task 7.4: src/components/wms/ui/modals.tsx (Receber, Ajuste, Transferir, Realocar)
- [ ] **Step 1: Modal Receber:** drop campo "empresa dona". Add: "empresa compradora" (select de empresas), "fornecedor" (select de fornecedores), "custo unitário" (numeric), "nota fiscal" (texto opcional).
- [ ] **Step 2: Modal Ajuste:** drop "empresa dona". Manter "motivo" (textarea obrigatória).
- [ ] **Step 3: Modal Transferir:** drop "empresa dona". Add botão "qty completa" se a loc origem tem 1 só saldo.
- [ ] **Step 4: Modal Realocar:** drop empresa_dona (cascade já é por loc).
- [ ] **Step 5:** Commit.

### Task 7.5: src/components/wms/saldo-perspectiva-tabs.tsx
- [ ] Drop tab "Dono". Manter Galpão / Localização / Produto.
- [ ] Commit.

### Task 7.6: src/components/wms/scan-contagem.tsx
- [ ] Drop campo empresa_dona do bipe de inventário. Operador bipa só QR da loc + QR/código do produto + qty.
- [ ] Commit.

### Task 7.7: src/components/wms/configuracoes-types.ts
- [ ] Drop types relacionados a empréstimo/mini-swap.
- [ ] Commit.

### Task 7.8: src/components/wms/inventario/* (loc-vazia-modal, feed-eventos)
- [ ] Drop empresa_dona dos modais e feed.
- [ ] Commit.

### Task 7.9: src/components/wms/vendas/timeline-pedido.tsx
- [ ] Drop eventos relacionados a empréstimo/swap do timeline.
- [ ] Commit.

### Task 7.10: src/hooks/use-inventario-realtime.ts
- [ ] Drop empresa_dona_id do shape do payload realtime.
- [ ] Commit.

### Task 7.11: /wms/page.tsx (home)
- [ ] Atualizar cards. Remover qualquer card de empréstimos. Adicionar card "Relatórios" se fizer sentido.
- [ ] Commit.

### Task 7.12: /wms/estoque/page.tsx
- [ ] Drop tab "Por dona".
- [ ] Header: exibir custo médio do produto se filtro for por produto.
- [ ] Commit.

### Task 7.13: /wms/ledger/page.tsx
- [ ] Tabela: drop coluna "Empresa Dona". Add colunas (opcional via toggle): "Empresa (compradora/vendedora/ref)", "Fornecedor", "Custo unit.", "Motivo".
- [ ] Filtros: drop empresa_dona, add empresa_compradora, empresa_vendedora, empresa_referencia.
- [ ] Commit.

### Task 7.14: /wms/receber/page.tsx
- [ ] Form: drop "empresa dona". Add "empresa compradora" + "fornecedor" + "custo unitário" + "NF (opcional)".
- [ ] Modo lote: cada linha do lote tem esses campos.
- [ ] Botão "entrada direta": valida que cada linha tem loc destino preenchida.
- [ ] Validar UI no browser: `npm run dev` → http://localhost:3000/wms/receber → tela funciona, submit funciona, NF cria mov.
- [ ] Commit.

### Task 7.15: /wms/guarda/* (page.tsx, [id]/page.tsx, rota/page.tsx)
- [ ] Drop coluna "Dona" das tabelas/cards.
- [ ] Mantém: produto, qty, loc origem (RECEBIMENTO), loc destino sugerida.
- [ ] Etiqueta de produto: drop empresa_dona do ZPL preview.
- [ ] Commit.

### Task 7.16: /wms/transferir/page.tsx
- [ ] Drop seletor de empresa dona origem. Apenas: galpão origem, galpão destino, produto, qty, loc origem (autofill ou pick), loc destino.
- [ ] Commit.

### Task 7.17: /wms/replenishment/page.tsx
- [ ] Drop empresa_dona. Form: galpão, produto, loc origem, loc destino, qty.
- [ ] Commit.

### Task 7.18: /wms/ajuste/page.tsx
- [ ] Drop empresa_dona. Manter: galpão, loc, produto, qty (+/-), motivo obrigatório.
- [ ] Commit.

### Task 7.19: /wms/retroativos/page.tsx
- [ ] Drop empresa_dona. Add empresa_compradora (opcional) + custo_unitario (opcional).
- [ ] Commit.

### Task 7.20: /wms/inventario/page.tsx + [id]/* (todos)
- [ ] Form de nova sessão: drop "empresa dona" (era opcional).
- [ ] Lista de sessões: drop coluna "Empresa".
- [ ] `[id]/page.tsx`: drop ref a dona.
- [ ] `[id]/contar/page.tsx`: drop seletor de dona no bipe. Operador conta total da loc.
- [ ] `[id]/divergencias/page.tsx`: drop coluna "Dona".
- [ ] `metricas/page.tsx`: drop filtro por dona.
- [ ] Commit:
```bash
git commit -m "refactor(ui/inventario): drop empresa_dona de todas telas"
```

### Task 7.21: /wms/separacao/checklist/page.tsx + embalagem/page.tsx + page.tsx
- [ ] Drop refs a dona. Display do pedido mostra empresa vendedora (já existia em outro lugar — confirmar).
- [ ] Commit.

### Task 7.22: /wms/vendas/page.tsx + nova/page.tsx + [id]/page.tsx
- [ ] Lista: drop coluna "Dona".
- [ ] `nova/page.tsx`: form de criar venda — drop seletor "dona". Operador escolhe galpão + produtos + qty. Sistema resolve loc via `vendas-disponibilidade`. Empresa vendedora vem do `vendedor` (auto) ou do select de empresa origem.
- [ ] `[id]/page.tsx`: drop ref a dona.
- [ ] Commit.

### Task 7.23: /wms/devolucoes/[id]/page.tsx + page.tsx
- [ ] Drop empresa_dona. Mostrar `empresa_referencia` (vendedora da NF original) como info.
- [ ] Classificação A/B/C/D segue normal.
- [ ] Commit.

### Task 7.24: /wms/localizacoes/page.tsx
- [ ] Tabela saldos por loc: drop coluna "Dona".
- [ ] Commit.

### Task 7.25: /wms/dashboard/page.tsx
- [ ] Drop card "Empréstimos pendentes" / "Saldos devedores".
- [ ] Commit.

### Task 7.26: /wms/insights/financeiro/page.tsx
- [ ] Drop seções relacionadas a empréstimo/swap.
- [ ] Commit.

### Task 7.27: /wms/configuracoes/page.tsx
- [ ] Drop aba "Empréstimos" (componente já deletado).
- [ ] Drop link/menção a "Otimizações" (página deletada).
- [ ] Commit.

### Task 7.28: Build frontend limpo
- [ ] `npm run build 2>&1 | grep -i error | head -30`
- [ ] Resolver erros TS remanescentes (imports quebrados, types).
- [ ] Commit:
```bash
git commit -m "checkpoint: fase 7 frontend completa"
```

---

## Fase 8 — Reports novos (backend + frontend)

### Task 8.1: API /api/wms/relatorios/movs-por-empresa/route.ts (novo)
- [ ] **Step 1:** Criar arquivo:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { getSessionUser } from '@/lib/session';

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });

  const url = new URL(req.url);
  const dataInicio = url.searchParams.get('data_inicio'); // ISO
  const dataFim    = url.searchParams.get('data_fim');
  const galpaoId   = url.searchParams.get('galpao_id');
  const empresaId  = url.searchParams.get('empresa_id');
  const produtoId  = url.searchParams.get('produto_id');

  if (!dataInicio || !dataFim) {
    return NextResponse.json({ error: 'data_inicio + data_fim obrigatórios' }, { status: 400 });
  }

  const supabase = createServiceClient();
  let query = supabase
    .from('siso_movimentacoes')
    .select(`
      tipo, quantidade, custo_unitario, criado_em,
      produto_id, galpao_id, empresa_compradora_id, empresa_vendedora_id,
      origem_tipo
    `)
    .gte('criado_em', dataInicio)
    .lte('criado_em', dataFim)
    .is('estorno_de', null)
    .in('origem_tipo', ['nf_compra','nf_venda','venda_manual','devolucao_cliente_integra','devolucao_fornecedor_enviada']);
  if (galpaoId) query = query.eq('galpao_id', galpaoId);
  if (produtoId) query = query.eq('produto_id', produtoId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Agrupar em memória por (produto, empresa, tipo)
  const grupos = new Map<string, { produto_id: string; empresa_id: string; tipo: 'E'|'S'; qty_total: number; valor_total: number }>();
  for (const m of data ?? []) {
    const empresa = (m.tipo === 'E' ? m.empresa_compradora_id : m.empresa_vendedora_id);
    if (!empresa) continue;
    if (empresaId && empresa !== empresaId) continue;
    const key = `${m.produto_id}|${empresa}|${m.tipo}`;
    const grp = grupos.get(key) ?? { produto_id: m.produto_id, empresa_id: empresa, tipo: m.tipo as 'E'|'S', qty_total: 0, valor_total: 0 };
    grp.qty_total += Number(m.quantidade);
    grp.valor_total += Number(m.quantidade) * Number(m.custo_unitario ?? 0);
    grupos.set(key, grp);
  }

  return NextResponse.json({ items: Array.from(grupos.values()) });
}
```

- [ ] **Step 2:** Commit.

### Task 8.2: API /api/wms/relatorios/historico-custo/route.ts (novo)
- [ ] Criar arquivo com query:
```ts
// Query: movs do produto com custo_unitario IS NOT NULL ordenadas por criado_em
// Retorna: [{ criado_em, custo_medio_anterior, custo_medio_posterior, custo_unitario, quantidade, origem_tipo, empresa_compradora_id }]
```
- [ ] Commit.

### Task 8.3: API /api/wms/relatorios/saldos-por-empresa/route.ts (novo)
- [ ] Criar arquivo com agregação Σ entradas − Σ saídas por (empresa, produto, galpão).
- [ ] Commit.

### Task 8.4: Página /wms/relatorios/movs-por-empresa/page.tsx (novo)
- [ ] Criar com filtros (data início/fim, galpão, empresa, produto), tabela paginada, botão "Exportar CSV".
- [ ] Visual: rodar e validar no browser.
- [ ] Commit.

### Task 8.5: Página /wms/relatorios/historico-custo/page.tsx (novo)
- [ ] Filtro: produto (busca). Linha temporal + gráfico simples (svg ou lib leve).
- [ ] Tabela: data, qty, custo unitário, custo médio antes, custo médio depois, empresa, fornecedor.
- [ ] Commit.

### Task 8.6: Página /wms/relatorios/saldos-por-empresa/page.tsx (novo)
- [ ] Filtros: galpão, empresa. Tabela: empresa × produto × galpão × saldo virtual.
- [ ] Botão "Exportar CSV".
- [ ] Commit.

### Task 8.7: Verificar sidebar inclui os 3 relatórios
- [ ] Reabrir `src/components/wms/wms-shell.tsx` e confirmar que os 3 links foram adicionados na Task 7.1.

---

## Fase 9 — Docs

### Task 9.1: Atualizar CLAUDE.md
- [ ] **Step 1:** Editar `CLAUDE.md`:
  - Seção "Direção Estratégica" — adicionar parágrafo: "Empresa dona deixou de ser coordenada física em 2026-05-20. Estoque é 3D. Ledger carrega empresa como tag em movs com NF. Apuração por empresa = report. Detalhes: `docs/superpowers/specs/2026-05-20-ledger-simplificado-design.md`."
  - "Schema 4D" → "Schema 3D"
  - Remover descrição de `siso_emprestimo_regras`, `siso_wms_mini_swap_config`
  - Atualizar tabela de `siso_estoque`, `siso_movimentacoes`, adicionar `siso_custo_medio`
  - Drop seções de empréstimo/swap/mini-swap
  - Adicionar seção curta "Reports" listando os 3 endpoints novos
- [ ] **Step 2:** Commit:
```bash
git commit -m "docs(CLAUDE): atualizar pra arquitetura 3D"
```

### Task 9.2: Atualizar docs/database-schema.md
- [ ] Atualizar tabelas + ER diagram.
- [ ] Commit.

### Task 9.3: Atualizar docs/api-reference-complete.md
- [ ] Remover docs de APIs deletadas (empréstimo regras, empréstimos, swap, mini-swap).
- [ ] Adicionar docs das 3 novas (movs-por-empresa, historico-custo, saldos-por-empresa).
- [ ] Atualizar entradas alteradas (receber, ajuste, transferir-galpao, etc.) — novas signatures.
- [ ] Commit.

### Task 9.4: Atualizar docs/architecture-and-flows.md
- [ ] Atualizar flows pra 3D. Remover diagramas de empréstimo/swap/mini-swap.
- [ ] Commit.

### Task 9.5: Atualizar docs/fluxos-siso.md
- [ ] Drop diagramas Mermaid de empréstimo/swap.
- [ ] Commit.

### Task 9.6: Atualizar erros-conhecidos.yaml (se aplicável)
- [ ] Marcar entradas relacionadas a empréstimo/swap como "obsoleto a partir de 2026-05-20".
- [ ] Commit.

---

## Fase 10 — Validação E2E

### Task 10.1: Smoke test no browser — fluxo completo
- [ ] **Step 1:** Subir o dev server:
```bash
npm run dev
```
- [ ] **Step 2:** Abrir browser em `http://localhost:3000/login`. Logar como Eryk / 1234.
- [ ] **Step 3:** Navegar pelos fluxos críticos manualmente. Pra cada um, verificar:
  - Página carrega sem erro JS no console
  - Form submete sem erro
  - Ledger registra mov correta com novos campos

**Checklist UI (ALL pages — exigência do user):**

| Página | URL | Verificação |
|---|---|---|
| Home | `/wms` | Carrega, cards corretos, sem ref a empréstimos |
| Pedidos lista | `/wms/pedidos` | Lista, filtros, sem coluna "Dona" |
| Pedido detalhe | `/wms/pedidos/[id]` | Drawer abre, exibe empresa origem, sem dona |
| Vendas lista | `/wms/vendas` | Filtros funcionam, sem coluna "Dona" |
| Nova venda | `/wms/vendas/nova` | Form sem campo dona; disponibilidade resolve; submit cria mov com empresa_vendedora |
| Venda detalhe | `/wms/vendas/[id]` | Carrega; timeline sem eventos de empréstimo |
| Separação lista | `/wms/separacao` | Carrega; ordens pendentes aparecem |
| Checklist | `/wms/separacao/checklist?id=X` | Bipa item; mov gerada com empresa_vendedora |
| Embalagem | `/wms/separacao/embalagem?id=X` | Bipa item; sem ref a dona |
| Compras | `/wms/compras` | Carrega; sem ref a empréstimo |
| Cross busca | `/wms/cross` | Carrega; sem ref a dona |
| Cross detalhe | `/wms/cross/[sku]` | Carrega; saldos exibidos sem dona |
| Produtos | `/wms/produtos` | Lista; drawer exibe custo médio global |
| Localizações | `/wms/localizacoes` | Saldos por loc — sem coluna dona |
| Estoque | `/wms/estoque` | 3 tabs: galpão/loc/produto. SEM "dono" |
| Ledger | `/wms/ledger` | Tabela com novas colunas; filtros novos |
| Receber | `/wms/receber` | Form: empresa compradora + fornecedor + custo; submit cria mov |
| Guarda | `/wms/guarda` | Lista de pendências; sem dona |
| Guarda rota | `/wms/guarda/rota` | Ordenação por loc destino; sem dona |
| Guarda detalhe | `/wms/guarda/[id]` | Confirma put-away; par S+E neutro no ledger |
| Transferir | `/wms/transferir` | Form sem dona; transferência inter-galpão funciona |
| Replenishment | `/wms/replenishment` | Form sem dona; mov par S+E |
| Ajuste | `/wms/ajuste` | Form sem dona; motivo obrigatório |
| Retroativos | `/wms/retroativos` | Form com compradora + custo opcionais |
| Fornecedores | `/wms/fornecedores` | CRUD normal |
| ~~Empréstimos~~ | `/wms/emprestimos` | **404 esperado** (página deletada) |
| Cobertura | `/wms/cobertura` | Lista sem dona |
| Devoluções | `/wms/devolucoes` | Fila pendente |
| Devolução detalhe | `/wms/devolucoes/[id]` | Classifica A/B/C/D usando empresa_referencia |
| Dashboard | `/wms/dashboard` | 4 cards corretos; sem "Empréstimos" |
| Inventário lista | `/wms/inventario` | Sessões; criar nova sem campo dona |
| Inventário detalhe | `/wms/inventario/[id]` | Supervisor view; feed sem dona |
| Inventário contar | `/wms/inventario/[id]/contar` | Operador bipa só loc + produto + qty (sem dona) |
| Inventário divergências | `/wms/inventario/[id]/divergencias` | Tabela sem coluna "Dona" |
| Inventário métricas | `/wms/inventario/metricas` | KPIs sem filtro dona |
| Insights hub | `/wms/insights` | Carrega; sem cards de empréstimo |
| Insights pessoas | `/wms/insights/pessoas` | Carrega |
| Insights fluxo | `/wms/insights/fluxo` | Carrega |
| Insights estoque | `/wms/insights/estoque` | Carrega |
| Insights financeiro | `/wms/insights/financeiro` | Carrega; sem KPIs de empréstimo |
| Insights devoluções | `/wms/insights/devolucoes` | Carrega |
| Insights regras | `/wms/insights/regras` | CRUD; sem regras antigas de empréstimo |
| Configurações | `/wms/configuracoes` | Sem aba "Empréstimos"; sem "Otimizações" |
| Configurações conexões | `/wms/configuracoes/conexoes` | OAuth Tiny/ML normais |
| ~~Otimizações~~ | `/wms/configuracoes/otimizacoes` | **404 esperado** |
| **Relatório Movs/Empresa** (NOVO) | `/wms/relatorios/movs-por-empresa` | Filtros + tabela + CSV export |
| **Histórico Custo** (NOVO) | `/wms/relatorios/historico-custo` | Busca produto + linha temporal |
| **Saldos/Empresa** (NOVO) | `/wms/relatorios/saldos-por-empresa` | Tabela + CSV |

- [ ] **Step 4:** Pra cada linha do checklist acima: abrir página, validar, marcar OK ou anotar erro.

- [ ] **Step 5:** Pra cada erro encontrado: voltar à task correspondente da Fase 6 ou 7, corrigir, repetir.

### Task 10.2: Smoke test do fluxo "pedido → expedição"
- [ ] **Step 1:** Subir um pedido fake via webhook receiver ou criar uma venda manual em `/wms/vendas/nova`.
- [ ] **Step 2:** Aprovar via UI ou auto-aprovar via webhook.
- [ ] **Step 3:** Verificar:
  - Reserva criada no ledger (tipo R com `pedido_id`)
  - Iniciar separação → mov S `nf_venda` com `empresa_vendedora`
  - Embalar → estados transicionam
  - Expedir → status final
- [ ] **Step 4:** Verificar no `/wms/ledger` que todas as movs aparecem com metadata correta.

### Task 10.3: Smoke test inventário
- [ ] **Step 1:** Em `/wms/inventario`, criar sessão "Manual" pra galpão CWB.
- [ ] **Step 2:** Adicionar 2-3 locs à sessão.
- [ ] **Step 3:** Iniciar; bipar contagens em `/contar`. Conferir que o sistema aceita só total (sem dona).
- [ ] **Step 4:** Aprovar sessão. Verificar divergências computadas no nível do pool (sem agrupamento por dona).
- [ ] **Step 5:** Aplicar — movs `inventario_perda`/`inventario_ganho` geradas sem empresa-tag.

### Task 10.4: Smoke test recebimento + guarda
- [ ] **Step 1:** Em `/wms/receber`, registrar entrada: empresa compradora=NetAir, fornecedor=Tiger, SKU=EW123, qty=10, custo=15.50, modo=dock.
- [ ] **Step 2:** Verificar que mov E `nf_compra` foi criada na loc RECEBIMENTO com tag empresa_compradora.
- [ ] **Step 3:** Verificar que `siso_custo_medio` foi atualizado.
- [ ] **Step 4:** Em `/wms/guarda`, confirmar a pendência: bipar QR loc destino, qty 10.
- [ ] **Step 5:** Verificar que par S+E `transferencia_localizacao` foi gerado RECEBIMENTO → loc destino, **sem tag de empresa**.

### Task 10.5: Smoke test reports
- [ ] **Step 1:** Em `/wms/relatorios/movs-por-empresa`, filtrar últimos 7 dias, sem outros filtros. Validar tabela.
- [ ] **Step 2:** Em `/wms/relatorios/historico-custo`, buscar SKU EW123. Validar linha temporal.
- [ ] **Step 3:** Em `/wms/relatorios/saldos-por-empresa`, validar agregação.
- [ ] **Step 4:** Testar export CSV em cada um — download deve baixar arquivo válido.

### Task 10.6: Lint + build final
- [ ] **Step 1:** `npm run lint`
- [ ] **Step 2:** `npm run build`
- [ ] **Step 3:** Resolver erros remanescentes (esperado: zero).
- [ ] **Step 4:** Commit final:
```bash
git commit --allow-empty -m "checkpoint: ledger simplificado 3D — E2E validado"
```

### Task 10.7: Update `erros-conhecidos.yaml`
- [ ] **Step 1:** Adicionar entrada documentando a migração:
```yaml
- id: 2026-05-20-empresa-dona-dropada
  date: 2026-05-20
  source: arquitetura
  category: business_logic
  message: "empresa_dona deixou de ser coordenada física"
  cause: Modelo 4D não refletia realidade — peças idênticas indistinguíveis no físico
  fix: Migration 20260520_ledger_simplificado dropou empresa_dona de estoque/movs; ledger agora carrega empresa como tag em movs com NF
  files: [supabase/migrations/20260520_ledger_simplificado.sql, src/lib/wms/types.ts, src/lib/wms/ledger.ts]
  tags: [migracao, schema-3d, ledger]
```
- [ ] **Step 2:** Commit.

---

## Self-Review Checklist

> Execute esta seção mentalmente após terminar todas as fases.

**1. Cobertura do spec:**
- §1-2 (contexto + decisões): mapeado nas Fases 1-9 ✓
- §3 (modelo de dados): Task 1.1 + 4.1 ✓
- §4 (custo médio): Task 2.1 (RPC) + 5.3 (lib) ✓
- §5 (catálogo operações): Fase 5 + Fase 6 (APIs por operação) ✓
- §6 (reports): Fase 8 ✓
- §7 (migração): Fase 1 ✓
- §8 (arquivamento): Fase 3 ✓
- §9 (impactos consumidores): Tasks 5.22 + 6.x + 7.x ✓
- §10 (testes): Tasks 5.x (unit) + 10.x (E2E) ✓
- §11 (riscos): mitigações refletidas no plano (build incremental, checklist UI)
- §12 (critérios sucesso): cobertos pelo checklist da Task 10.1

**2. Placeholders:** zero "TBD" / "TODO" / "fill in details" no plano.

**3. Type consistency:** `Tripla` (não `Quadrupla`) usado consistentemente. `empresa_compradora_id`/`empresa_vendedora_id`/`empresa_referencia_id` com mesmos nomes em schema, RPC, types, APIs, frontend.

**4. UI checklist completa:** Task 10.1 lista TODAS as 45+ páginas com validação esperada. Páginas deletadas marcadas como "404 esperado". Páginas novas marcadas como "NOVO".

---

## Execution

**Plan complete and saved to `docs/superpowers/plans/2026-05-20-ledger-simplificado-3d.md`.**

Próximo passo: escolher execução.

1. **Subagent-Driven (recomendado)** — dispatch fresh subagent por task, review entre tasks, iteração rápida. Bom pra plano longo (~85 tasks).
2. **Inline Execution** — executar tasks na sessão atual via executing-plans, batch com checkpoints.

Qual abordagem?
