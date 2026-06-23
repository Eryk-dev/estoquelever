# WMS Fix · P1 · Foundation Realtime + Insights Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the observation layer of the WMS (realtime publication completeness, fix 4 broken insights RPCs that reference dropped 3D-schema columns, schedule 4 cron jobs that never ran). Migrations-only — zero application code changes.

**Architecture:** All changes via Supabase migrations + pg_cron. Each migration is independent and rollback-safe. After this plan, the home dashboard reacts to events in realtime and the insights motor (16 anomaly rules) starts firing every 5 minutes.

**Tech Stack:** PostgreSQL 15+, Supabase Realtime, pg_cron, pg_net (for cron→HTTP)

**Worktree:** This plan assumes execution in worktree `.claude/worktrees/wms-fix-p1/` (created via `superpowers:using-git-worktrees`). Branch: `wms-fix-p1`.

**Staging only:** All migrations apply to Supabase project `ehbxpbeijofxtsbezwxd` (staging). Do NOT touch prod.

---

## Spec traceability

This plan implements spec §5 of `docs/superpowers/specs/2026-05-26-auditoria-wms-fixes-design.md`. Findings covered (cross-reference §15 Módulo 0 in the appendix):

| Finding | Severity | Resolved by task(s) |
|---|---|---|
| 0.1 — Publication realtime omite 4+ tabelas declaradas | ALTO | Tasks 3-6 (Migration 1) |
| 0.2 — 4 RPCs insights referenciam colunas dropadas (3D) | ALTO | Tasks 7-11 (Migration 2) |
| 0.3 — Motor insights nunca executa (sem cron) | ALTO | Tasks 12-15 (Migration 3) |
| 0.4 — RPCs filtram por `siso_empresas.galpao_id` deprecated | ALTO | Tasks 7-11 (Migration 2) — parte server-side; P6 cobre consumidores |
| 0.6 — Curva ABC stale (função sem cron) | MÉD | Tasks 22-24 (Migration 6) |
| 0.7 — Reservas expiradas sem cron | MÉD | Tasks 16-18 (Migration 4) |
| 0.8 — Inventário locks órfãos sem cron | MÉD | Tasks 19-21 (Migration 5) |
| 1.8 — `siso_wms_pendencias_guarda` NÃO está na publication | BAIXO | Task 4 (parte de Migration 1) |

Princípios não-negociáveis restabelecidos (§2 spec):
- **PR-3** — "Realtime é cross-module" — restaurado pela Migration 1.
- **PR-5** — "Apuração por empresa é tag em movs, nunca coordenada física" — restaurado pela Migration 2 (substitui `siso_empresas.galpao_id`).
- **PR-6** — "Custo médio é global por produto (`siso_custo_medio`)" — restaurado pela Migration 2 (JOIN ao invés de coluna 4D).

---

## Setup

### Task 1: Create worktree and switch context

**Files:** none (git operation only)

- [ ] **Step 1.1:** From repo root `/Users/eryk/Documents/ESTOQUE`, create the worktree:
  ```bash
  git worktree add /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1 -b wms-fix-p1 origin/develop
  ```
- [ ] **Step 1.2:** Verify worktree exists and is on branch `wms-fix-p1`:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1 && git status && git branch --show-current
  ```
  Expected output: `On branch wms-fix-p1` and `wms-fix-p1`.
- [ ] **Step 1.3:** Confirm the `supabase/migrations/` directory exists in the worktree:
  ```bash
  ls /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1/supabase/migrations/ | tail -5
  ```
  Expected: should list the latest migrations including `20260526_cron_refresh_cobertura_1min.sql`.

All subsequent file paths in this plan are relative to the worktree root `/Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1/`. Absolute paths use that prefix.

---

### Task 2: Verify prerequisites (extensions + env)

**Files:** none (verification only)

- [ ] **Step 2.1:** Run via `mcp__supabase__execute_sql` against project `ehbxpbeijofxtsbezwxd`:
  ```sql
  SELECT extname, extversion
  FROM pg_extension
  WHERE extname IN ('pg_cron', 'pg_net')
  ORDER BY extname;
  ```
  Expected: 2 rows (`pg_cron` and `pg_net`). If missing, STOP — extensions must be enabled in Supabase dashboard before continuing.

- [ ] **Step 2.2:** Verify `app.worker_secret` is settable as a database GUC (some Supabase projects already expose `WORKER_SECRET` as a setting). Run:
  ```sql
  SHOW app.worker_secret;
  ```
  Two possible outcomes:
  - **OK:** returns a value → use `current_setting('app.worker_secret')` directly in cron HTTP calls.
  - **ERROR `unrecognized configuration parameter`:** the secret must be passed as a literal in cron migrations. Document the literal value (matching Vercel env `WORKER_SECRET`) and substitute inline. **Do NOT commit a real secret** — use a Supabase-managed secret accessor (`vault.decrypted_secrets`) if available, or coordinate with the user to inject the value via `mcp__supabase__execute_sql` outside the migration.

  **Decision rule for this plan:** if Step 2.2 returns OK, all 4 cron migrations use `current_setting('app.worker_secret')`. If it errors, ask the user once for the staging `WORKER_SECRET` value and substitute it inline at apply-time (commit migration with a placeholder `'__WORKER_SECRET_REPLACE_AT_APPLY__'` and document this in the migration header).

- [ ] **Step 2.3:** Verify the base URL the cron jobs will call. Staging is `https://estoquelever.vercel.app`. Confirm via:
  ```bash
  curl -sI https://estoquelever.vercel.app/api/wms/insights/refresh | head -3
  ```
  Expected: HTTP 401 or 403 (no worker-secret) — confirms the endpoint exists. The cron will supply the header.

- [ ] **Step 2.4:** Record current publication state as the baseline (this is the "failing" pre-state for the first test):
  ```sql
  SELECT schemaname, tablename
  FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime'
  ORDER BY tablename;
  ```
  Expected before fix: 8 tables (`siso_custo_medio`, `siso_estoque`, `siso_inventario_contagens`, `siso_inventario_divergencias`, `siso_inventario_localizacoes`, `siso_inventario_operadores`, `siso_movimentacoes`, `siso_pedido_item_realocacoes`). After this plan: 14 tables.

---

## Migration 1: Realtime publication completeness (Finding 0.1, 1.8)

Adds 6 tables to `supabase_realtime`: `siso_pedidos`, `siso_pedido_itens`, `siso_wms_pendencias_guarda`, `siso_inventario_sessoes`, `siso_devolucoes_pendentes`, `siso_transferencias_galpao`.

### Task 3: Write smoke-test for publication completeness

**Files:**
- Create: `scripts/wms/cenarios/smoke-p1-realtime-publication.sql`

- [ ] **Step 3.1:** Create the smoke-test SQL file with content:
  ```sql
  -- Smoke-test P1 · Migration 1 (realtime publication completeness)
  -- Expected after migration: 14 rows total in supabase_realtime publication,
  -- including the 6 tables added by 20260527_realtime_publication_completeness.sql.

  WITH expected AS (
    SELECT unnest(ARRAY[
      'siso_custo_medio',
      'siso_devolucoes_pendentes',
      'siso_estoque',
      'siso_inventario_contagens',
      'siso_inventario_divergencias',
      'siso_inventario_localizacoes',
      'siso_inventario_operadores',
      'siso_inventario_sessoes',
      'siso_movimentacoes',
      'siso_pedido_item_realocacoes',
      'siso_pedido_itens',
      'siso_pedidos',
      'siso_transferencias_galpao',
      'siso_wms_pendencias_guarda'
    ]) AS tablename
  ),
  actual AS (
    SELECT tablename
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
  )
  SELECT
    e.tablename,
    CASE WHEN a.tablename IS NULL THEN 'MISSING' ELSE 'OK' END AS status
  FROM expected e
  LEFT JOIN actual a USING (tablename)
  ORDER BY status DESC, tablename;
  ```

- [ ] **Step 3.2:** Run the smoke-test via `mcp__supabase__execute_sql`:
  ```sql
  -- (paste content of scripts/wms/cenarios/smoke-p1-realtime-publication.sql here)
  ```
  Expected pre-migration: 6 rows with `status='MISSING'` and 8 rows with `status='OK'`. **This proves the test discriminates** — without the upcoming migration, the 6 tables don't yet exist in the publication.

### Task 4: Write Migration 1 (realtime publication)

**Files:**
- Create: `supabase/migrations/20260527_realtime_publication_completeness.sql`

- [ ] **Step 4.1:** Create the migration with content:
  ```sql
  -- Migration: realtime publication completeness
  -- Date: 2026-05-27
  -- Plan: P1 · Foundation Realtime + Insights Recovery (spec §5)
  -- Finding(s): 0.1 (ALTO — publication omite 4+ tabelas), 1.8 (BAIXO — siso_wms_pendencias_guarda)
  --
  -- Adds the 6 tables that CLAUDE.md declares as part of the realtime contract
  -- but were never added to the publication (likely lost in 3D ledger DROP/CREATE
  -- around 2026-05-20, similar to siso_estoque/siso_movimentacoes that were
  -- already restored in 20260525_realtime_estoque_movimentacoes.sql).
  --
  -- Idempotent: uses ADD TABLE IF NOT EXISTS (Postgres 15+).
  -- Zero risk: publications are append-only metadata; no data is moved/locked.

  DO $$
  DECLARE
    t text;
    tables_to_add text[] := ARRAY[
      'siso_pedidos',
      'siso_pedido_itens',
      'siso_wms_pendencias_guarda',
      'siso_inventario_sessoes',
      'siso_devolucoes_pendentes',
      'siso_transferencias_galpao'
    ];
  BEGIN
    FOREACH t IN ARRAY tables_to_add LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', t);
        RAISE NOTICE 'Added table % to supabase_realtime publication', t;
      ELSE
        RAISE NOTICE 'Table % already in supabase_realtime publication (skipped)', t;
      END IF;
    END LOOP;
  END $$;

  -- Rollback (manual, if ever needed):
  -- ALTER PUBLICATION supabase_realtime DROP TABLE siso_pedidos;
  -- ALTER PUBLICATION supabase_realtime DROP TABLE siso_pedido_itens;
  -- ALTER PUBLICATION supabase_realtime DROP TABLE siso_wms_pendencias_guarda;
  -- ALTER PUBLICATION supabase_realtime DROP TABLE siso_inventario_sessoes;
  -- ALTER PUBLICATION supabase_realtime DROP TABLE siso_devolucoes_pendentes;
  -- ALTER PUBLICATION supabase_realtime DROP TABLE siso_transferencias_galpao;
  ```

### Task 5: Apply Migration 1 and re-run smoke-test

- [ ] **Step 5.1:** Apply via `mcp__supabase__apply_migration` with name `20260527_realtime_publication_completeness` and the SQL content from Task 4.
- [ ] **Step 5.2:** Re-run the smoke-test from Task 3 (Step 3.2). Expected: all 14 rows show `status='OK'`. **This proves the migration works.**
- [ ] **Step 5.3:** Verify the table count matches §5.5 acceptance criterion #1:
  ```sql
  SELECT COUNT(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
  ```
  Expected: `14`.

### Task 6: Commit Migration 1

- [ ] **Step 6.1:** From the worktree root, stage and commit:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1
  git add supabase/migrations/20260527_realtime_publication_completeness.sql scripts/wms/cenarios/smoke-p1-realtime-publication.sql
  git commit -m "feat(wms): adicionar 6 tabelas faltantes à publication realtime

  Restaura PR-3 (realtime cross-module). Adiciona siso_pedidos,
  siso_pedido_itens, siso_wms_pendencias_guarda, siso_inventario_sessoes,
  siso_devolucoes_pendentes e siso_transferencias_galpao à publication
  supabase_realtime. Hook useDashboardTarefasRealtime e similares passam
  a receber eventos (antes assinavam canais que nunca disparavam).

  Spec §5 · P1 · Finding 0.1 e 1.8.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Migration 2: Insights RPCs 3D patch (Findings 0.2, 0.4)

Reescreve 4 RPCs que referenciam colunas dropadas no schema 3D:
- `wms_insight_estoque_slow_mover` — usa `s.custo_medio` e `s.empresa_dona_id` (dropped from `siso_estoque`).
- `wms_insights_estoque_quadrante` — usa `e.custo_medio_avg` e `e.empresa_dona_id`.
- `wms_insights_estoque_valor_atual` — usa `s.empresa_dona_id`, `s.custo_medio` e param `p_empresa_dona_id` (deprecated).
- `wms_insights_hub_kpis` — usa `e.galpao_id` (deprecated em `siso_empresas`) e `custo_medio` (em `siso_estoque`).

**Substitutions:**
- `siso_estoque.custo_medio` → JOIN `siso_custo_medio cm ON cm.produto_id = ...` then use `cm.custo_medio`.
- `siso_estoque.empresa_dona_id` → drop the column from grouping; for slow-mover, key by `(produto_id, galpao_id)` only.
- `siso_empresas.galpao_id` → JOIN via `siso_pedidos.separacao_galpao_id` for pedido-scoped queries.
- For "valor por empresa" reports, the 3D-canonical answer is to drop the `empresa_dona_id` axis from real-time RPCs and direct users to `/wms/relatorios/saldos-por-empresa` (which aggregates by `empresa_compradora_id`/`vendedora_id` tags). This RPC becomes "valor por galpão" only.

### Task 7: Write smoke-test for insights RPCs (failing pre-state)

**Files:**
- Create: `scripts/wms/cenarios/smoke-p1-insights-rpcs.sql`

- [ ] **Step 7.1:** Create the smoke-test SQL file with content:
  ```sql
  -- Smoke-test P1 · Migration 2 (insights RPCs 3D patch)
  -- Expected before migration: each call raises ERROR referencing dropped column.
  -- Expected after migration: each call returns successfully (rowcount >= 0).
  --
  -- Run each block separately and capture which raise errors.

  -- 1. wms_insight_estoque_slow_mover
  -- Pre-fix: ERROR: column s.custo_medio does not exist
  SELECT * FROM wms_insight_estoque_slow_mover('{}'::jsonb) LIMIT 1;

  -- 2. wms_insights_estoque_quadrante
  -- Pre-fix: ERROR: column e.custo_medio does not exist
  SELECT * FROM wms_insights_estoque_quadrante(NULL, NULL, 1) LIMIT 1;

  -- 3. wms_insights_estoque_valor_atual
  -- Pre-fix: ERROR: column s.empresa_dona_id does not exist
  SELECT * FROM wms_insights_estoque_valor_atual(NULL) LIMIT 1;

  -- 4. wms_insights_hub_kpis
  -- Pre-fix: ERROR: column e.galpao_id does not exist OR column custo_medio does not exist
  SELECT wms_insights_hub_kpis(NULL);
  ```

- [ ] **Step 7.2:** Run each query block in Step 7.1 via `mcp__supabase__execute_sql`, **one at a time**. For each, record the exact error message (column name + context). Expected pre-migration: 4 distinct errors mentioning dropped columns. **This proves the tests discriminate** — without the migration, the RPCs are runtime-broken.

### Task 8: Write Migration 2 (insights RPCs 3D patch)

**Files:**
- Create: `supabase/migrations/20260527_insights_rpcs_3d_patch.sql`

- [ ] **Step 8.1:** Create the migration with content:
  ```sql
  -- Migration: insights RPCs 3D patch
  -- Date: 2026-05-27
  -- Plan: P1 · Foundation Realtime + Insights Recovery (spec §5)
  -- Finding(s): 0.2 (ALTO — 4 RPCs broken), 0.4 (ALTO — galpao_id deprecated)
  --
  -- Rewrites 4 insights RPCs that referenced columns dropped in the 3D ledger
  -- migration (20260520_ledger_simplificado.sql):
  --   - siso_estoque.custo_medio  → JOIN siso_custo_medio.custo_medio (global por produto)
  --   - siso_estoque.empresa_dona_id  → dropped; estoque é por (produto, galpão, loc) apenas
  --   - siso_empresas.galpao_id  → trocar por siso_pedidos.separacao_galpao_id
  --
  -- Princípios restabelecidos: PR-5 (empresa = tag em movs) + PR-6 (custo médio global).
  --
  -- Rollback: re-apply 20260514_wms_insights_motor.sql + 20260515_wms_insights_rpcs.sql
  -- (essas RPCs eram a definição original; trazê-las de volta restaura o estado pré-fix
  -- mas reintroduz o bug runtime — só fazer se for pra debug histórico).

  -- ---- 1. wms_insight_estoque_slow_mover (motor anomalias) ----
  CREATE OR REPLACE FUNCTION wms_insight_estoque_slow_mover(p_threshold jsonb DEFAULT '{}'::jsonb)
  RETURNS SETOF wms_insight_resultado
  LANGUAGE plpgsql STABLE AS $$
  DECLARE
    v_dias int := COALESCE((p_threshold->>'dias_sem_saida')::int, 60);
    v_min_valor numeric := COALESCE((p_threshold->>'min_valor')::numeric, 500);
  BEGIN
    RETURN QUERY
    WITH ultima_saida AS (
      SELECT produto_id, galpao_id, MAX(criado_em) AS ultima
      FROM siso_movimentacoes
      WHERE tipo = 'S'
        AND origem_tipo IN ('nf_venda', 'venda_manual')
        AND estorno_de IS NULL
      GROUP BY 1, 2
    ),
    saldos AS (
      SELECT s.produto_id, s.galpao_id, SUM(s.saldo) AS saldo
      FROM siso_estoque s
      WHERE s.saldo > 0
      GROUP BY 1, 2
    )
    SELECT
      'sku'::text,
      sa.produto_id::text || '|' || sa.galpao_id::text,
      'Slow-mover — ' || p.sku,
      p.sku || ' parado há ' ||
        COALESCE(EXTRACT(DAYS FROM (now() - u.ultima))::text, '60+') || ' dias. ' ||
        'R$ ' || ROUND(sa.saldo * cm.custo_medio, 2)::text || ' empatado.',
      jsonb_build_object(
        'dias_parado', COALESCE(EXTRACT(DAYS FROM (now() - u.ultima))::int, 999),
        'saldo', sa.saldo,
        'valor', sa.saldo * cm.custo_medio
      ),
      sa.galpao_id,
      '/wms/insights/estoque'
    FROM saldos sa
    JOIN siso_produtos p ON p.id = sa.produto_id
    JOIN siso_custo_medio cm ON cm.produto_id = sa.produto_id
    LEFT JOIN ultima_saida u
      ON u.produto_id = sa.produto_id
      AND u.galpao_id = sa.galpao_id
    WHERE cm.custo_medio > 0
      AND sa.saldo * cm.custo_medio >= v_min_valor
      AND (u.ultima IS NULL OR u.ultima < now() - (v_dias || ' days')::interval);
  END;
  $$;

  -- ---- 2. wms_insights_estoque_quadrante (consultas frontend) ----
  -- Drop legacy signature first (parameter list changed — empresa_dona_id removed).
  DROP FUNCTION IF EXISTS wms_insights_estoque_quadrante(uuid, uuid, int);

  CREATE OR REPLACE FUNCTION wms_insights_estoque_quadrante(
    p_galpao_id uuid DEFAULT NULL,
    p_limit int DEFAULT 500
  ) RETURNS TABLE (
    produto_id uuid,
    sku text,
    giro_diario numeric,
    dias_cobertura numeric,
    saldo numeric,
    valor numeric,
    status_cobertura text,
    curva text
  ) LANGUAGE plpgsql STABLE AS $$
  #variable_conflict use_column
  BEGIN
    RETURN QUERY
    SELECT
      c.produto_id,
      p.sku,
      c.giro_diario,
      c.dias_cobertura,
      c.disponivel_total AS saldo,
      c.disponivel_total * COALESCE(cm.custo_medio, 0) AS valor,
      c.status_cobertura,
      COALESCE(abc.curva, 'C') AS curva
    FROM siso_cobertura_estoque c
    JOIN siso_produtos p ON p.id = c.produto_id
    LEFT JOIN siso_custo_medio cm ON cm.produto_id = c.produto_id
    LEFT JOIN siso_curva_abc abc ON abc.produto_id = c.produto_id
    WHERE (p_galpao_id IS NULL OR c.galpao_id = p_galpao_id)
    ORDER BY c.disponivel_total * COALESCE(cm.custo_medio, 0) DESC
    LIMIT p_limit;
  END;
  $$;

  -- ---- 3. wms_insights_estoque_valor_atual (consultas frontend, financeiro) ----
  -- Removed empresa_dona_id axis: 3D-canonical "valor por empresa" lives in
  -- /api/wms/relatorios/saldos-por-empresa (recompõe via tags em movs).
  -- Esta RPC vira "valor por galpão" apenas.
  DROP FUNCTION IF EXISTS wms_insights_estoque_valor_atual(uuid);

  CREATE OR REPLACE FUNCTION wms_insights_estoque_valor_atual(
    p_galpao_id uuid DEFAULT NULL
  ) RETURNS TABLE (
    galpao_id uuid,
    galpao_nome text,
    qtd_skus int,
    saldo_total numeric,
    valor_total numeric,
    valor_curva_a numeric,
    valor_curva_b numeric,
    valor_curva_c numeric
  ) LANGUAGE plpgsql STABLE AS $$
  BEGIN
    RETURN QUERY
    WITH base AS (
      SELECT s.galpao_id, s.produto_id,
             SUM(s.saldo) AS saldo,
             COALESCE(cm.custo_medio, 0) AS custo_medio,
             SUM(s.saldo) * COALESCE(cm.custo_medio, 0) AS valor,
             COALESCE(abc.curva, 'C') AS curva
      FROM siso_estoque s
      LEFT JOIN siso_custo_medio cm ON cm.produto_id = s.produto_id
      LEFT JOIN siso_curva_abc abc ON abc.produto_id = s.produto_id
      WHERE s.saldo > 0
        AND (p_galpao_id IS NULL OR s.galpao_id = p_galpao_id)
      GROUP BY s.galpao_id, s.produto_id, cm.custo_medio, abc.curva
    )
    SELECT
      b.galpao_id,
      g.nome,
      COUNT(DISTINCT b.produto_id)::int,
      SUM(b.saldo),
      ROUND(SUM(b.valor), 2),
      ROUND(COALESCE(SUM(b.valor) FILTER (WHERE b.curva = 'A'), 0), 2),
      ROUND(COALESCE(SUM(b.valor) FILTER (WHERE b.curva = 'B'), 0), 2),
      ROUND(COALESCE(SUM(b.valor) FILTER (WHERE b.curva = 'C'), 0), 2)
    FROM base b
    JOIN siso_galpoes g ON g.id = b.galpao_id
    GROUP BY 1, 2
    ORDER BY ROUND(SUM(b.valor), 2) DESC;
  END;
  $$;

  -- ---- 4. wms_insights_hub_kpis (dashboard hub) ----
  -- Trocas:
  --   - siso_empresas.galpao_id (deprecated)  → siso_pedidos.separacao_galpao_id
  --   - siso_estoque.custo_medio  → siso_custo_medio.custo_medio
  --   - filtro devoluções por galpão removido (siso_devolucoes_pendentes não tem
  --     galpao_id direto; agregação global é o comportamento correto pós-3D).
  CREATE OR REPLACE FUNCTION wms_insights_hub_kpis(
    p_galpao_id uuid DEFAULT NULL
  ) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
  DECLARE
    v_throughput_hoje int;
    v_throughput_7d_avg numeric;
    v_lead_time_p50_24h numeric;
    v_lead_time_p50_7d numeric;
    v_acuracidade_pct numeric;
    v_cobertura_critico int;
    v_capital_total numeric;
    v_devolucoes_pct numeric;
  BEGIN
    -- Throughput (filtra por separacao_galpao_id, fonte de verdade pós-3D)
    SELECT COUNT(*) INTO v_throughput_hoje
    FROM siso_pedidos p
    WHERE p.embalagem_concluida_em::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
      AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id);

    SELECT AVG(qtd) INTO v_throughput_7d_avg FROM (
      SELECT embalagem_concluida_em::date AS dia, COUNT(*)::numeric AS qtd
      FROM siso_pedidos p
      WHERE p.embalagem_concluida_em >= now() - interval '7 days'
        AND p.embalagem_concluida_em < (now() AT TIME ZONE 'America/Sao_Paulo')::date
        AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id)
      GROUP BY 1
    ) t;

    -- Lead time 24h
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (p.embalagem_concluida_em - p.criado_em))/60)
    INTO v_lead_time_p50_24h
    FROM siso_pedidos p
    WHERE p.embalagem_concluida_em >= now() - interval '24 hours'
      AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id);

    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (p.embalagem_concluida_em - p.criado_em))/60)
    INTO v_lead_time_p50_7d
    FROM siso_pedidos p
    WHERE p.embalagem_concluida_em >= now() - interval '7 days'
      AND p.embalagem_concluida_em < now() - interval '24 hours'
      AND (p_galpao_id IS NULL OR p.separacao_galpao_id = p_galpao_id);

    -- Acuracidade (1 − div/contagens) últimos 30d
    SELECT CASE WHEN COUNT(il.id) > 0
      THEN ROUND((1 - COUNT(d.id)::numeric / NULLIF(COUNT(il.id), 0)) * 100, 1)
      ELSE NULL END
    INTO v_acuracidade_pct
    FROM siso_inventario_localizacoes il
    JOIN siso_inventario_sessoes s ON s.id = il.sessao_id
    LEFT JOIN siso_inventario_divergencias d
      ON d.sessao_id = il.sessao_id AND d.localizacao_id = il.localizacao_id
    WHERE il.contagem_finalizada_em >= now() - interval '30 days'
      AND (p_galpao_id IS NULL OR s.galpao_id = p_galpao_id);

    -- Cobertura crítico
    SELECT COUNT(*) INTO v_cobertura_critico
    FROM siso_cobertura_estoque
    WHERE status_cobertura IN ('critico','lead_time_risco')
      AND (p_galpao_id IS NULL OR galpao_id = p_galpao_id);

    -- Capital total: valor empatado = saldo × custo_medio (global por produto)
    SELECT SUM(s.saldo * COALESCE(cm.custo_medio, 0))
    INTO v_capital_total
    FROM siso_estoque s
    LEFT JOIN siso_custo_medio cm ON cm.produto_id = s.produto_id
    WHERE s.saldo > 0
      AND (p_galpao_id IS NULL OR s.galpao_id = p_galpao_id);

    -- Devoluções (taxa 30d) — agregação global pós-3D (devoluções não têm galpao direto)
    WITH v AS (
      SELECT COUNT(*) AS qtd
      FROM siso_movimentacoes m
      WHERE m.tipo = 'S' AND m.origem_tipo = 'nf_venda'
        AND m.criado_em >= now() - interval '30 days'
        AND m.estorno_de IS NULL
        AND (p_galpao_id IS NULL OR m.galpao_id = p_galpao_id)
    ),
    d AS (
      SELECT COUNT(*) AS qtd
      FROM siso_devolucoes_pendentes
      WHERE criado_em >= now() - interval '30 days'
        AND status <> 'cancelada'
    )
    SELECT CASE WHEN v.qtd > 0 THEN ROUND(d.qtd::numeric / v.qtd * 100, 2) ELSE NULL END
    INTO v_devolucoes_pct FROM v, d;

    RETURN jsonb_build_object(
      'throughput_hoje', v_throughput_hoje,
      'throughput_7d_avg', ROUND(COALESCE(v_throughput_7d_avg, 0), 1),
      'delta_throughput_pct',
        CASE WHEN COALESCE(v_throughput_7d_avg, 0) > 0
          THEN ROUND((v_throughput_hoje::numeric / v_throughput_7d_avg - 1) * 100, 1)
          ELSE NULL END,
      'lead_time_p50_24h_min', ROUND(COALESCE(v_lead_time_p50_24h, 0), 1),
      'lead_time_p50_7d_min', ROUND(COALESCE(v_lead_time_p50_7d, 0), 1),
      'delta_lead_time_pct',
        CASE WHEN COALESCE(v_lead_time_p50_7d, 0) > 0
          THEN ROUND((v_lead_time_p50_24h / v_lead_time_p50_7d - 1) * 100, 1)
          ELSE NULL END,
      'acuracidade_pct', v_acuracidade_pct,
      'cobertura_critico', v_cobertura_critico,
      'capital_total', ROUND(COALESCE(v_capital_total, 0), 2),
      'devolucoes_taxa_30d', v_devolucoes_pct
    );
  END;
  $$;

  -- Sanity: comment marker for future audits
  COMMENT ON FUNCTION wms_insight_estoque_slow_mover(jsonb) IS
    'Patched 2026-05-27 (P1): removed siso_estoque.custo_medio + empresa_dona_id references (3D schema). See spec §5.';
  COMMENT ON FUNCTION wms_insights_estoque_quadrante(uuid, int) IS
    'Patched 2026-05-27 (P1): removed empresa_dona_id axis + JOIN siso_custo_medio. See spec §5.';
  COMMENT ON FUNCTION wms_insights_estoque_valor_atual(uuid) IS
    'Patched 2026-05-27 (P1): "valor por empresa" agora vive em /api/wms/relatorios/saldos-por-empresa. Aqui só valor por galpão. See spec §5.';
  COMMENT ON FUNCTION wms_insights_hub_kpis(uuid) IS
    'Patched 2026-05-27 (P1): troca siso_empresas.galpao_id por siso_pedidos.separacao_galpao_id; JOIN siso_custo_medio. See spec §5.';
  ```

### Task 9: Apply Migration 2

- [ ] **Step 9.1:** Apply via `mcp__supabase__apply_migration` with name `20260527_insights_rpcs_3d_patch` and the SQL content from Task 8.

### Task 10: Verify Migration 2 (re-run smoke-test + acceptance)

- [ ] **Step 10.1:** Re-run each of the 4 query blocks from Task 7 Step 7.2. Expected: all 4 succeed (return rows or empty result; no errors). **This proves the migration fixes the runtime errors.**
- [ ] **Step 10.2:** Run §5.5 acceptance criterion #4 — verify the HTTP endpoint works end-to-end:
  ```bash
  curl -sI -H "x-session-id: <staging-admin-session>" https://estoquelever.vercel.app/api/wms/insights/hub | head -3
  ```
  Expected: `HTTP/2 200`. Pre-fix this returned 500 with column-not-found in the response body. (If session-id is unavailable, skip this step — the SQL test in 10.1 is sufficient evidence the RPCs work.)
- [ ] **Step 10.3:** Verify dropped-and-recreated functions don't break dependents. Run:
  ```sql
  SELECT
    p.proname,
    pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
  WHERE p.proname IN (
    'wms_insight_estoque_slow_mover',
    'wms_insights_estoque_quadrante',
    'wms_insights_estoque_valor_atual',
    'wms_insights_hub_kpis'
  )
  ORDER BY p.proname;
  ```
  Expected: 4 rows, each with the new signatures (e.g., `wms_insights_estoque_quadrante(p_galpao_id uuid, p_limit integer)` — note absence of `p_empresa_dona_id`).

### Task 11: Commit Migration 2

- [ ] **Step 11.1:** Stage and commit:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1
  git add supabase/migrations/20260527_insights_rpcs_3d_patch.sql scripts/wms/cenarios/smoke-p1-insights-rpcs.sql
  git commit -m "fix(wms): reescrever 4 RPCs insights para schema 3D

  Remove referências a colunas dropadas no schema 3D
  (siso_estoque.custo_medio, siso_estoque.empresa_dona_id,
  siso_empresas.galpao_id). Troca por JOIN com siso_custo_medio
  e siso_pedidos.separacao_galpao_id. Restaura PR-5 e PR-6.

  Mudança de contrato:
  - wms_insights_estoque_quadrante: param p_empresa_dona_id removido
  - wms_insights_estoque_valor_atual: coluna empresa_dona_id removida
    do retorno (apuração por empresa vive em /relatorios/saldos-por-empresa)

  Spec §5 · P1 · Finding 0.2 e 0.4.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Migration 3: Cron — insights refresh (every 5 min) (Finding 0.3)

### Task 12: Write smoke-test for insights cron

**Files:**
- Create: `scripts/wms/cenarios/smoke-p1-cron-insights.sql`

- [ ] **Step 12.1:** Create the smoke-test SQL file with content:
  ```sql
  -- Smoke-test P1 · Migration 3 (insights refresh cron)
  -- Expected after migration: 1 row with jobname='wms_insights_refresh'
  -- and schedule='*/5 * * * *' and active=true.

  SELECT jobid, jobname, schedule, active,
         left(command, 80) AS command_preview
  FROM cron.job
  WHERE jobname = 'wms_insights_refresh';
  ```

- [ ] **Step 12.2:** Run the smoke-test via `mcp__supabase__execute_sql`. Expected pre-migration: 0 rows. **This proves the job does not exist yet.**

### Task 13: Write Migration 3 (insights cron)

**Files:**
- Create: `supabase/migrations/20260527_cron_insights_refresh_5min.sql`

- [ ] **Step 13.1:** Create the migration with content:
  ```sql
  -- Migration: cron — insights refresh every 5 min
  -- Date: 2026-05-27
  -- Plan: P1 · Foundation Realtime + Insights Recovery (spec §5)
  -- Finding: 0.3 (ALTO — motor insights nunca executa)
  --
  -- Schedules HTTP POST to /api/wms/insights/refresh every 5 minutes.
  -- The endpoint runs the 16 anomaly-detection rules and refreshes
  -- siso_wms_insights_ativos. Without this cron, 0 alerts ever fire.
  --
  -- Auth: uses current_setting('app.worker_secret') if available; otherwise
  -- substitute a literal value at apply-time (see Plan task 2.2).
  --
  -- Idempotent: unschedules any existing job with the same name before scheduling.
  -- Rollback: SELECT cron.unschedule('wms_insights_refresh');

  DO $$
  DECLARE
    v_jobid integer;
  BEGIN
    FOR v_jobid IN
      SELECT jobid FROM cron.job WHERE jobname = 'wms_insights_refresh'
    LOOP
      PERFORM cron.unschedule(v_jobid);
    END LOOP;
  END $$;

  SELECT cron.schedule(
    'wms_insights_refresh',
    '*/5 * * * *',
    $cron$
      SELECT net.http_post(
        url := 'https://estoquelever.vercel.app/api/wms/insights/refresh',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-worker-secret', current_setting('app.worker_secret', true)
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );
    $cron$
  );
  ```

  > **If Step 2.2 confirmed `app.worker_secret` is NOT settable as a GUC**, replace `current_setting('app.worker_secret', true)` with the literal staging WORKER_SECRET value (coordinate with user). The `, true)` second argument to `current_setting` returns NULL instead of error if the GUC is missing — safe fallback if the project uses a different auth mechanism (the endpoint will respond 401 and pg_net will log the failure, surfaced via Step 14.2 query).

### Task 14: Apply Migration 3 and verify

- [ ] **Step 14.1:** Apply via `mcp__supabase__apply_migration` with name `20260527_cron_insights_refresh_5min` and the SQL content from Task 13.
- [ ] **Step 14.2:** Re-run the smoke-test from Task 12 (Step 12.2). Expected: 1 row with `jobname='wms_insights_refresh'`, `schedule='*/5 * * * *'`, `active=true`. **This proves the migration scheduled the job.**
- [ ] **Step 14.3:** Wait ~6 minutes (one cron tick), then verify the job actually fires:
  ```sql
  SELECT
    runid,
    job_pid,
    database,
    username,
    command IS NOT NULL AS has_command,
    status,
    return_message,
    start_time,
    end_time
  FROM cron.job_run_details
  WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'wms_insights_refresh')
  ORDER BY start_time DESC
  LIMIT 3;
  ```
  Expected: at least 1 row with `status='succeeded'` and recent `start_time`. If `status='failed'`, inspect `return_message` — most likely cause is missing `app.worker_secret`; revisit Step 13.1.

### Task 15: Commit Migration 3

- [ ] **Step 15.1:** Stage and commit:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1
  git add supabase/migrations/20260527_cron_insights_refresh_5min.sql scripts/wms/cenarios/smoke-p1-cron-insights.sql
  git commit -m "feat(wms): agendar cron de refresh de insights (5min)

  Ativa o motor de detecção de anomalias. Sem este cron, as 16 regras
  insights nunca dispararam — siso_wms_insights_ativos ficava vazio
  permanentemente. Cron POSTa em /api/wms/insights/refresh com
  x-worker-secret a cada 5 minutos.

  Spec §5 · P1 · Finding 0.3.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Migration 4: Cron — reservas cleanup (every 1h) (Finding 0.7)

### Task 16: Write smoke-test for reservas cleanup cron

**Files:**
- Create: `scripts/wms/cenarios/smoke-p1-cron-reservas-cleanup.sql`

- [ ] **Step 16.1:** Create the smoke-test SQL file with content:
  ```sql
  -- Smoke-test P1 · Migration 4 (reservas cleanup cron)
  -- Expected after migration: 1 row with jobname='wms_reservas_cleanup'
  -- and schedule='0 * * * *' (top of every hour).

  SELECT jobid, jobname, schedule, active,
         left(command, 80) AS command_preview
  FROM cron.job
  WHERE jobname = 'wms_reservas_cleanup';
  ```

- [ ] **Step 16.2:** Run the smoke-test. Expected pre-migration: 0 rows. **This proves the job does not exist yet.**

### Task 17: Write Migration 4 (reservas cleanup cron)

**Files:**
- Create: `supabase/migrations/20260527_cron_reservas_cleanup_1h.sql`

- [ ] **Step 17.1:** Create the migration with content:
  ```sql
  -- Migration: cron — reservas cleanup every 1h
  -- Date: 2026-05-27
  -- Plan: P1 · Foundation Realtime + Insights Recovery (spec §5)
  -- Finding: 0.7 (MÉD — reservas expiradas sem cron)
  --
  -- Schedules HTTP POST to /api/wms/reservas/cleanup every hour.
  -- The endpoint releases R movs (reservations) whose expira_em < now()
  -- by inserting estorno pairs into the ledger. Without this cron,
  -- expired reservations accumulate as zumbi and the cache reservado
  -- value drifts upward indefinitely.
  --
  -- Idempotent: unschedules any existing job with the same name before scheduling.
  -- Rollback: SELECT cron.unschedule('wms_reservas_cleanup');

  DO $$
  DECLARE
    v_jobid integer;
  BEGIN
    FOR v_jobid IN
      SELECT jobid FROM cron.job WHERE jobname = 'wms_reservas_cleanup'
    LOOP
      PERFORM cron.unschedule(v_jobid);
    END LOOP;
  END $$;

  SELECT cron.schedule(
    'wms_reservas_cleanup',
    '0 * * * *',
    $cron$
      SELECT net.http_post(
        url := 'https://estoquelever.vercel.app/api/wms/reservas/cleanup',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-worker-secret', current_setting('app.worker_secret', true)
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
    $cron$
  );
  ```

### Task 18: Apply Migration 4 and verify

- [ ] **Step 18.1:** Apply via `mcp__supabase__apply_migration` with name `20260527_cron_reservas_cleanup_1h` and SQL content from Task 17.
- [ ] **Step 18.2:** Re-run the smoke-test from Task 16 (Step 16.2). Expected: 1 row with `jobname='wms_reservas_cleanup'`, `schedule='0 * * * *'`, `active=true`. **This proves the migration scheduled the job.**
- [ ] **Step 18.3:** Stage and commit:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1
  git add supabase/migrations/20260527_cron_reservas_cleanup_1h.sql scripts/wms/cenarios/smoke-p1-cron-reservas-cleanup.sql
  git commit -m "feat(wms): agendar cron de cleanup de reservas (1h)

  Libera reservas R expiradas (expira_em < now()) chamando o endpoint
  /api/wms/reservas/cleanup a cada hora. Sem cron, reservas órfãs
  acumulavam e a coluna reservado em siso_estoque inflava com o tempo.

  Spec §5 · P1 · Finding 0.7.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Migration 5: Cron — inventário cleanup (every 30 min) (Finding 0.8)

### Task 19: Write smoke-test for inventário cleanup cron

**Files:**
- Create: `scripts/wms/cenarios/smoke-p1-cron-inventario-cleanup.sql`

- [ ] **Step 19.1:** Create the smoke-test SQL file with content:
  ```sql
  -- Smoke-test P1 · Migration 5 (inventário cleanup cron)
  -- Expected after migration: 1 row with jobname='wms_inventario_cleanup'
  -- and schedule='*/30 * * * *' (every 30 minutes).

  SELECT jobid, jobname, schedule, active,
         left(command, 80) AS command_preview
  FROM cron.job
  WHERE jobname = 'wms_inventario_cleanup';
  ```

- [ ] **Step 19.2:** Run the smoke-test. Expected pre-migration: 0 rows.

### Task 20: Write Migration 5 (inventário cleanup cron)

**Files:**
- Create: `supabase/migrations/20260527_cron_inventario_cleanup_30min.sql`

- [ ] **Step 20.1:** Create the migration with content:
  ```sql
  -- Migration: cron — inventário cleanup every 30 min
  -- Date: 2026-05-27
  -- Plan: P1 · Foundation Realtime + Insights Recovery (spec §5)
  -- Finding: 0.8 (MÉD — inventário locks órfãos sem cron)
  --
  -- Schedules HTTP POST to /api/wms/inventario/cleanup every 30 minutes.
  -- The endpoint releases siso_localizacao_locks órfãos (operador caiu mid-
  -- contagem) e desbloqueia siso_inventario_localizacoes presas em
  -- 'em_contagem' há mais de N minutos sem heartbeat. Sem cron, locks
  -- ficam até alguém abrir a sessão e clicar manual no botão.
  --
  -- Idempotent: unschedules any existing job with the same name before scheduling.
  -- Rollback: SELECT cron.unschedule('wms_inventario_cleanup');

  DO $$
  DECLARE
    v_jobid integer;
  BEGIN
    FOR v_jobid IN
      SELECT jobid FROM cron.job WHERE jobname = 'wms_inventario_cleanup'
    LOOP
      PERFORM cron.unschedule(v_jobid);
    END LOOP;
  END $$;

  SELECT cron.schedule(
    'wms_inventario_cleanup',
    '*/30 * * * *',
    $cron$
      SELECT net.http_post(
        url := 'https://estoquelever.vercel.app/api/wms/inventario/cleanup',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-worker-secret', current_setting('app.worker_secret', true)
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
    $cron$
  );
  ```

### Task 21: Apply Migration 5 and verify + commit

- [ ] **Step 21.1:** Apply via `mcp__supabase__apply_migration` with name `20260527_cron_inventario_cleanup_30min` and SQL content from Task 20.
- [ ] **Step 21.2:** Re-run the smoke-test from Task 19 (Step 19.2). Expected: 1 row with `jobname='wms_inventario_cleanup'`, `schedule='*/30 * * * *'`, `active=true`.
- [ ] **Step 21.3:** Stage and commit:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1
  git add supabase/migrations/20260527_cron_inventario_cleanup_30min.sql scripts/wms/cenarios/smoke-p1-cron-inventario-cleanup.sql
  git commit -m "feat(wms): agendar cron de cleanup de inventário (30min)

  Libera locks órfãos de localização (operador caiu mid-contagem)
  chamando /api/wms/inventario/cleanup a cada 30 minutos. Sem cron,
  locks ficavam até alguém abrir a sessão e clicar manual.

  Spec §5 · P1 · Finding 0.8.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Migration 6: Cron — curva ABC refresh (diário) (Finding 0.6)

### Task 22: Write smoke-test for curva ABC cron

**Files:**
- Create: `scripts/wms/cenarios/smoke-p1-cron-curva-abc.sql`

- [ ] **Step 22.1:** Create the smoke-test SQL file with content:
  ```sql
  -- Smoke-test P1 · Migration 6 (curva ABC refresh diário)
  -- Expected after migration: 1 row with jobname='wms_curva_abc_refresh_diario'
  -- and schedule='0 3 * * *' (3am UTC = 00:00 BRT).

  SELECT jobid, jobname, schedule, active,
         left(command, 100) AS command_preview
  FROM cron.job
  WHERE jobname = 'wms_curva_abc_refresh_diario';

  -- Verify the function it calls still exists
  SELECT proname, pg_get_function_identity_arguments(oid) AS args
  FROM pg_proc WHERE proname = 'wms_refresh_curva_abc';
  ```

- [ ] **Step 22.2:** Run the smoke-test. Expected pre-migration: 0 rows for first query (no job yet); 1 row for second query (function `wms_refresh_curva_abc` exists from migration `20260520f_mviews.sql`).

### Task 23: Write Migration 6 (curva ABC cron)

**Files:**
- Create: `supabase/migrations/20260527_cron_curva_abc_refresh_diario.sql`

- [ ] **Step 23.1:** Create the migration with content:
  ```sql
  -- Migration: cron — curva ABC refresh diário (3am UTC = 00:00 BRT)
  -- Date: 2026-05-27
  -- Plan: P1 · Foundation Realtime + Insights Recovery (spec §5)
  -- Finding: 0.6 (MÉD — curva ABC stale, função sem cron)
  --
  -- Schedules direct SQL call to wms_refresh_curva_abc() once per day at
  -- 3am UTC (00:00 BRT — fim do dia comercial brasileiro). Unlike the
  -- other crons in this plan, this one runs SQL directly (no HTTP) because
  -- the function exists in the database and doesn't need an HTTP boundary.
  --
  -- siso_curva_abc é materialized view com ranking ABC por giro 30d.
  -- Sem refresh diário, fica stale logo após a primeira semana do mês.
  -- Refresh leva poucos segundos (universo total de produtos = ~milhares).
  --
  -- Idempotent: unschedules any existing job with the same name before scheduling.
  -- Rollback: SELECT cron.unschedule('wms_curva_abc_refresh_diario');

  DO $$
  DECLARE
    v_jobid integer;
  BEGIN
    FOR v_jobid IN
      SELECT jobid FROM cron.job WHERE jobname = 'wms_curva_abc_refresh_diario'
    LOOP
      PERFORM cron.unschedule(v_jobid);
    END LOOP;
  END $$;

  SELECT cron.schedule(
    'wms_curva_abc_refresh_diario',
    '0 3 * * *',
    $cron$SELECT wms_refresh_curva_abc();$cron$
  );
  ```

### Task 24: Apply Migration 6 and verify + commit

- [ ] **Step 24.1:** Apply via `mcp__supabase__apply_migration` with name `20260527_cron_curva_abc_refresh_diario` and SQL content from Task 23.
- [ ] **Step 24.2:** Re-run the smoke-test from Task 22 (Step 22.2). Expected: 1 row with `jobname='wms_curva_abc_refresh_diario'`, `schedule='0 3 * * *'`, `active=true`.
- [ ] **Step 24.3:** Manually trigger the function once to verify it works (and warm the MV):
  ```sql
  SELECT wms_refresh_curva_abc();
  SELECT COUNT(*) FROM siso_curva_abc;
  ```
  Expected: function returns void without error; count > 0 (some products ranked).
- [ ] **Step 24.4:** Stage and commit:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1
  git add supabase/migrations/20260527_cron_curva_abc_refresh_diario.sql scripts/wms/cenarios/smoke-p1-cron-curva-abc.sql
  git commit -m "feat(wms): agendar cron diário de refresh da curva ABC

  Chama wms_refresh_curva_abc() todo dia às 03:00 UTC (00:00 BRT,
  fim do dia comercial). Sem cron, ranking ABC ficava stale logo na
  primeira semana e regras insights baseadas em curva (slow_mover,
  mudanca_curva) trabalhavam com dados velhos.

  Spec §5 · P1 · Finding 0.6.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Final verification (§5.5 acceptance criteria)

### Task 25: Verify all §5.5 acceptance criteria

**Files:** none (verification only)

- [ ] **Step 25.1 — Criterion #1: 14 tables in publication.** Run:
  ```sql
  SELECT COUNT(*) AS total, array_agg(tablename ORDER BY tablename) AS tables
  FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime';
  ```
  Expected: `total = 14`. The `tables` array must include all 14 expected names from Task 3 Step 3.1.

- [ ] **Step 25.2 — Criterion #3: 5 cron jobs.** Run:
  ```sql
  SELECT jobname, schedule, active
  FROM cron.job
  WHERE jobname LIKE 'wms_%'
  ORDER BY jobname;
  ```
  Expected: exactly 5 rows — `wms_curva_abc_refresh_diario`, `wms_insights_refresh`, `wms_inventario_cleanup`, `wms_refresh_cobertura_1min` (pre-existing from migration `20260526_cron_refresh_cobertura_1min.sql`), `wms_reservas_cleanup`. All with `active = true`.

  > If a 6th job appears (e.g., `wms_refresh_cobertura_30min` legacy duplicate), inspect and `cron.unschedule()` the duplicate manually. The migration `20260526_cron_refresh_cobertura_1min.sql` already handles this for cobertura.

- [ ] **Step 25.3 — Criterion #4: insights endpoint returns 200.** Run:
  ```bash
  curl -sI -H "x-worker-secret: <staging-worker-secret>" -X POST https://estoquelever.vercel.app/api/wms/insights/refresh | head -3
  ```
  Expected: `HTTP/2 200`. Replace `<staging-worker-secret>` with the actual value (ask user if not in env). This is the same call the cron makes — proves the endpoint is functional.

  Alternative (no curl): query `cron.job_run_details` for the latest `wms_insights_refresh` run:
  ```sql
  SELECT status, return_message, start_time
  FROM cron.job_run_details
  WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'wms_insights_refresh')
  ORDER BY start_time DESC LIMIT 1;
  ```
  Expected: `status = 'succeeded'`.

- [ ] **Step 25.4 — Criterion #5: alerts firing.** Wait at least 10 minutes after Migration 3 applied (~2 cron ticks), then run:
  ```sql
  SELECT COUNT(*) AS ativos, MAX(criado_em) AS mais_recente
  FROM siso_wms_insights_ativos
  WHERE dispensado_em IS NULL;
  ```
  Expected: `ativos > 0` (assuming staging has any data that triggers any of the 16 rules). If `ativos = 0` after 10 min, inspect:
  ```sql
  SELECT codigo, ativa, ultima_execucao_em, ultima_qtd_resultados
  FROM siso_wms_insights_regras
  ORDER BY ultima_execucao_em DESC NULLS LAST;
  ```
  Expected: `ultima_execucao_em` populated for all active rules. If NULL, the refresh endpoint isn't iterating over rules — escalate (likely a bug in `/api/wms/insights/refresh` outside P1 scope).

- [ ] **Step 25.5 — Criterion #2 (smoke E2E): classificar uma devolução pendente atualiza quadro home sem refresh.** This requires manual UI test:
  1. Open `/wms` in two browser tabs (logged in as admin).
  2. In tab A, observe the "Devoluções pendentes" card counter (or, if P5 hasn't added it yet, observe via SQL: `SELECT COUNT(*) FROM siso_devolucoes_pendentes WHERE status = 'aguardando_classificacao';`).
  3. In tab B, classify a pending devolução via `/wms/devolucoes/[id]`.
  4. Tab A should see the counter decrement within ~2 seconds **without page refresh** (realtime subscription on `siso_devolucoes_pendentes` triggers React Query invalidation).

  > **Note:** This criterion crosses with P5 (which adds the card UI). If the home doesn't yet have a devoluções card, the test is "did the realtime channel fire?" — verifiable by browser DevTools → Network → WS → look for a postgres_changes event mentioning `siso_devolucoes_pendentes`. Document this in the merge PR.

- [ ] **Step 25.6 — No regression in pre-existing realtime tables.** Run:
  ```sql
  SELECT tablename FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime'
    AND tablename IN ('siso_estoque', 'siso_movimentacoes', 'siso_custo_medio')
  ORDER BY tablename;
  ```
  Expected: 3 rows. **Proves Migration 1 didn't accidentally remove anything.**

### Task 26: Run the integration test suite (if it exists)

- [ ] **Step 26.1:** From worktree root, run the existing integration tests:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1
  npm run test --silent 2>&1 | tail -30 || true
  ```
  Expected: no new failures introduced by this plan. P1 is migrations-only so no test files were added; this step just confirms nothing regressed.
- [ ] **Step 26.2:** If a `scenarios` runner exists (`npm run scenarios`), run a smoke subset focused on insights:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1
  npm run scenarios -- --filter insights 2>&1 | tail -20 || true
  ```
  This is best-effort; if no insights-tagged scenarios exist, skip.

---

## Finishing

### Task 27: Review the full diff before merge

- [ ] **Step 27.1:** From worktree root, list all commits on the branch:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1
  git log --oneline origin/develop..HEAD
  ```
  Expected: 6 commits (one per migration), in chronological order.

- [ ] **Step 27.2:** Sanity-check the file list:
  ```bash
  git diff --name-only origin/develop..HEAD
  ```
  Expected: exactly 12 files (6 migrations + 6 smoke-tests):
  ```
  scripts/wms/cenarios/smoke-p1-cron-curva-abc.sql
  scripts/wms/cenarios/smoke-p1-cron-insights.sql
  scripts/wms/cenarios/smoke-p1-cron-inventario-cleanup.sql
  scripts/wms/cenarios/smoke-p1-cron-reservas-cleanup.sql
  scripts/wms/cenarios/smoke-p1-insights-rpcs.sql
  scripts/wms/cenarios/smoke-p1-realtime-publication.sql
  supabase/migrations/20260527_cron_curva_abc_refresh_diario.sql
  supabase/migrations/20260527_cron_insights_refresh_5min.sql
  supabase/migrations/20260527_cron_inventario_cleanup_30min.sql
  supabase/migrations/20260527_cron_reservas_cleanup_1h.sql
  supabase/migrations/20260527_insights_rpcs_3d_patch.sql
  supabase/migrations/20260527_realtime_publication_completeness.sql
  ```
  Zero files in `src/` (P1 is migrations-only — this is a hard invariant).

- [ ] **Step 27.3:** Verify no `src/` changes:
  ```bash
  git diff --name-only origin/develop..HEAD -- src/
  ```
  Expected: empty output. **If any `src/` file appears, STOP and escalate** — P1 is migrations-only by design (see plan header).

### Task 28: Push branch and open PR

- [ ] **Step 28.1:** Push the branch to origin:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1
  git push -u origin wms-fix-p1
  ```

- [ ] **Step 28.2:** Open a PR via `gh`:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1
  gh pr create --base develop --title "fix(wms): P1 · Foundation Realtime + Insights Recovery" --body "$(cat <<'EOF'
  ## Summary

  Restaura a camada de observação do WMS — migrations-only, zero código aplicação.

  - 6 tabelas adicionadas à publication `supabase_realtime` (PR-3 restaurado)
  - 4 RPCs insights reescritas para schema 3D (PR-5 + PR-6 restaurados)
  - 4 cron jobs agendados (insights 5min, reservas 1h, inventário 30min, curva ABC diária)

  Implementa spec §5 de `docs/superpowers/specs/2026-05-26-auditoria-wms-fixes-design.md`.
  Cobre findings 0.1, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8, 1.8 (8 dos 141 totais).

  ## Test plan

  - [ ] `SELECT COUNT(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime'` retorna 14
  - [ ] `SELECT * FROM cron.job WHERE jobname LIKE 'wms_%'` retorna 5 jobs ativos
  - [ ] `SELECT wms_insights_hub_kpis(NULL)` retorna jsonb sem erro de coluna
  - [ ] `SELECT * FROM wms_insights_estoque_quadrante(NULL, 5)` retorna até 5 linhas sem erro
  - [ ] `SELECT * FROM wms_insights_estoque_valor_atual(NULL)` retorna por galpão sem erro
  - [ ] `SELECT * FROM wms_insight_estoque_slow_mover('{}'::jsonb) LIMIT 5` executa sem erro
  - [ ] Após 10min: `SELECT COUNT(*) FROM siso_wms_insights_ativos WHERE dispensado_em IS NULL` > 0
  - [ ] `cron.job_run_details` mostra `status='succeeded'` para os 4 novos jobs

  ## Rollback

  Cada migration é rollback-safe — instruções na seção de comentários de cada arquivo. Resumo:
  - Realtime: `ALTER PUBLICATION supabase_realtime DROP TABLE <name>` (6×)
  - Insights RPCs: re-aplicar `20260514_wms_insights_motor.sql` + `20260515_wms_insights_rpcs.sql` (restaura estado pré-fix mas re-introduz o bug runtime)
  - Crons: `SELECT cron.unschedule('<jobname>')` (4×)

  ## Próximos planos desbloqueados

  - **P5 (Visibilidade Home)** — depende exclusivamente desta publication estar completa. Pode começar imediatamente após merge.

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```

  Capture the PR URL — return it as the final output of this plan execution.

### Task 29: Update CLAUDE.md (Recently Implemented section)

- [ ] **Step 29.1:** After PR is approved and merged to `develop`, switch back to the main worktree and add a one-line entry to `CLAUDE.md` under "In Progress / Minor" → "Recently Implemented":
  ```markdown
  - **WMS Fix P1 (Foundation Realtime + Insights Recovery) — implementado em 2026-05-27.** Restaura observation layer: 6 tabelas faltantes na publication `supabase_realtime` (siso_pedidos, siso_pedido_itens, siso_wms_pendencias_guarda, siso_inventario_sessoes, siso_devolucoes_pendentes, siso_transferencias_galpao); 4 RPCs insights reescritas para schema 3D (remove `siso_estoque.custo_medio` → JOIN `siso_custo_medio`, `siso_empresas.galpao_id` → `siso_pedidos.separacao_galpao_id`); 4 cron jobs agendados (insights 5min, reservas 1h, inventário 30min, curva ABC diária). Migrations: `20260527_realtime_publication_completeness.sql`, `20260527_insights_rpcs_3d_patch.sql`, `20260527_cron_{insights_refresh_5min,reservas_cleanup_1h,inventario_cleanup_30min,curva_abc_refresh_diario}.sql`. Spec: `docs/superpowers/specs/2026-05-26-auditoria-wms-fixes-design.md` §5. Plan: `docs/superpowers/plans/2026-05-26-wms-fix-p1-foundation-realtime-insights.md`.
  ```

- [ ] **Step 29.2:** Commit the CLAUDE.md update directly to `develop`:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE
  git checkout develop && git pull
  # edit CLAUDE.md (use Edit tool, not echo/cat)
  git add CLAUDE.md
  git commit -m "docs(wms): registrar P1 (foundation realtime + insights recovery) em CLAUDE.md

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  git push
  ```

### Task 30: Remove worktree (cleanup)

- [ ] **Step 30.1:** After PR is merged, remove the worktree:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE
  git worktree remove /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p1
  git branch -d wms-fix-p1
  ```
  Expected: clean removal, no uncommitted changes.

---

## Rollback playbook (full plan)

If P1 must be fully rolled back, run in this exact order:

```sql
-- 1. Unschedule crons
SELECT cron.unschedule('wms_curva_abc_refresh_diario');
SELECT cron.unschedule('wms_inventario_cleanup');
SELECT cron.unschedule('wms_reservas_cleanup');
SELECT cron.unschedule('wms_insights_refresh');

-- 2. Restore broken RPCs (re-apply original migrations 20260514 + 20260515).
-- This re-introduces the runtime errors but is what "pre-P1" looked like.
-- Only do this if a downstream consumer depends on the dropped parameters.
-- (Generally: prefer leaving the P1 patch in place even on rollback.)

-- 3. Remove tables from publication
ALTER PUBLICATION supabase_realtime DROP TABLE siso_transferencias_galpao;
ALTER PUBLICATION supabase_realtime DROP TABLE siso_devolucoes_pendentes;
ALTER PUBLICATION supabase_realtime DROP TABLE siso_inventario_sessoes;
ALTER PUBLICATION supabase_realtime DROP TABLE siso_wms_pendencias_guarda;
ALTER PUBLICATION supabase_realtime DROP TABLE siso_pedido_itens;
ALTER PUBLICATION supabase_realtime DROP TABLE siso_pedidos;
```

Then revert the merge commit in `develop` (via `git revert -m 1 <merge-sha>`).

---

## Plan completion checklist

- [ ] All 30 tasks executed in order
- [ ] 6 commits on branch `wms-fix-p1` (one per migration)
- [ ] Zero files in `src/` touched (migrations-only invariant)
- [ ] All 5 §5.5 acceptance criteria verified
- [ ] PR opened against `develop` with test plan
- [ ] CLAUDE.md updated post-merge
- [ ] Worktree removed
