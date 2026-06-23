# WMS Fix · P6 · Estado Fantasma + Cleanups + Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate state-with-no-TTL (transferência em_transito sem cleanup), zombie cleanups (operadores inventário, locs em_contagem com bloqueada_por finalizado), deprecated column usage (`siso_empresas.galpao_id`), audit trail gaps (7 compras endpoints), hardcoded galpão names ("CWB"/"SP"), quarentena in inventory suggest, structured category for ajuste manual. Plus delete 3 dead-code endpoints and polish 19 small issues.

**Architecture:** Mix of migrations (cron, schema additions, enum), cleanup helpers, surgical refactors (compras-release decoupling from deprecated column, vendas-disponibilidade removing hardcoded names), and audit-trail wiring (7 endpoints gain `registrarEventos`).

**Tech Stack:** TypeScript, PostgreSQL migrations, pg_cron, plpgsql, existing helpers.

**Worktree:** `.claude/worktrees/wms-fix-p6/`. Branch: `wms-fix-p6`.

**Staging only.**

**Dependency note:** P6 runs parallel to P1/P2/P3. Some tasks have cross-plan overlaps documented inline (e.g., "RPCs insights consumidores" coordinates with P1's RPC patch; "saldo recebimento órfão endpoint" feeds P5 card).

---

## Table of Contents

- [0. Setup](#0-setup)
- [A. Estado Fantasma (findings 6.1–6.6, 6.7, 5.4, 4.6, 4.18)](#a-estado-fantasma)
- [B. Hardcoded / Schema (findings 6.9–6.16, 1.12)](#b-hardcoded--schema)
- [C. Audit Trail (findings 3.5, 5.9, 5.10, 4.15, 6.20, 6.21)](#c-audit-trail)
- [D. Categoria Estruturada + Deadcode (findings 6.24, 6.25, 6.26, 6.27, 8.14)](#d-categoria-estruturada--deadcode)
- [E. Idempotência + Polish (findings 6.29–6.47, 5.14, 5.16, 4.13, 4.14, 4.19, 4.20, 2.15, 2.17, 2.18, 2.19, 2.20, 2.21, 2.22, 3.10–3.17, 4.8, 6.14–6.17, 7.5, 7.8–7.16, 8.11, 8.13)](#e-idempotência--polish)
- [F. Final Verification](#f-final-verification)

---

## Conventions

- **One commit per task.** Conventional Commits: `fix(<scope>): <subject> [#P6-<finding-id>]`. Example: `fix(wms/transferencias): adicionar expira_em + cron auto-cancel [#P6-6.1]`.
- **TDD strict:** every behavioral task writes the test/scenario FIRST, runs to confirm it fails, then implements.
- **Migrations:** `supabase/migrations/<YYYYMMDD>_<slug>.sql`. UP wrapped in `BEGIN; ... COMMIT;`. DOWN documented in commit body when reversible. Apply via `mcp__supabase__apply_migration` against `ehbxpbeijofxtsbezwxd`.
- **Scenarios:** `scripts/wms/cenarios/catalogo/NN-...ts`. Register in `scripts/wms/cenarios/run-all.ts`. Run isolated via `npx tsx scripts/wms/cenarios/catalogo/NN-foo.ts`.
- **Logger:** never `console.log` — use `logger.info/warn/error(source, message, meta)`.
- **Audit trail:** import `registrarEvento`/`registrarEventos` from `@/lib/historico-service`. Fire-and-forget — never `await` in a way that blocks the response if it fails.
- **DECISION REQUIRED markers** flag tasks where user input is needed; each has a default recommendation marked `RECOMMENDED:`.

---

## 0. Setup

### Task 0.1 — Create worktree + branch

- [ ] Verify clean working tree on `develop`: `git status`.
- [ ] Create worktree:
  ```bash
  git worktree add .claude/worktrees/wms-fix-p6 -b wms-fix-p6 develop
  cd .claude/worktrees/wms-fix-p6
  ```
- [ ] Install deps (if needed): `npm install` (only if `package.json` changed since worktree base).
- [ ] Create `.env.test.local` by copying staging vars from root `.env.local`.
- [ ] Commit baseline: not needed — worktree starts clean from develop.

### Task 0.2 — Verify test harness baseline

- [ ] Start dev server in another terminal: `npm run dev -- -p 3001` (must be 3001 — test harness expects).
- [ ] Run baseline scenarios to confirm they pass before any changes:
  ```bash
  npm run scenarios -- --only 01,07,08,17
  ```
  Confirm all 4 pass. If any fail, STOP and re-check `.env.test.local` before continuing.
- [ ] Capture baseline of `siso_logs` count for later sanity check:
  ```bash
  psql "$DATABASE_URL_STAGING" -c "SELECT count(*) FROM siso_pedido_historico;" > /tmp/p6-baseline-historico.txt
  ```

### Task 0.3 — Map all P6 findings to tasks

- [ ] Read this entire plan file front-to-back.
- [ ] Cross-check against §10.2 of spec at `docs/superpowers/specs/2026-05-26-auditoria-wms-fixes-design.md`.
- [ ] Mark this task done only after every finding (6.1–6.47, plus cross-cutting 5.4 / 5.5 / 5.9 / 5.10 / 5.11 / 5.14 / 5.16 / 4.6 / 4.8 / 4.10 / 4.13–4.20 / 3.5 / 3.6 / 3.9–3.17 / 2.11 / 2.15–2.22 / 1.12 / 1.15 / 7.5 / 7.8–7.16 / 8.11 / 8.13 / 8.14) has a task ID below.

---

## A. Estado Fantasma

### A.1 — Transferência em_transito sem TTL [#P6-6.1, #P6-8.1]

Migration adds `expira_em` (default `now() + 7 days`) and cron auto-cancels stale rows. Coordinates with P5 for home card.

#### Task A.1.1 — Write failing scenario `22-transferencia-em-transito-expira.ts`

- [ ] File: `scripts/wms/cenarios/catalogo/22-transferencia-em-transito-expira.ts`.
- [ ] Skeleton (mirror `15-transferencia-inter-galpao.ts`):
  ```ts
  import type { Cenario } from "../_harness/types";
  import { runStandalone } from "../_harness/standalone";
  import { assertEquals } from "../_harness/asserts";

  const cenario: Cenario = {
    nome: "22 — transferência em_transito expira após cron",
    async setup(ctx) {
      const { staging } = ctx;
      // Cria transferência inter-galpão CWB→SP de 1 produto
      const trResp = await ctx.http.post("/api/wms/transferir-galpao", {
        galpao_origem_id: staging.galpaoCwbId,
        galpao_destino_id: staging.galpaoSpId,
        itens: [{
          produto_id: staging.produtoAlphaId,
          localizacao_origem_id: staging.locCwbPickingId,
          qty: 1,
        }],
      });
      assertEquals(trResp.status, 200, "criar transferência");
      const { transferencia_id } = await trResp.json();
      // Força expira_em pro passado
      await ctx.sb
        .from("siso_transferencias_galpao")
        .update({ expira_em: new Date(Date.now() - 24 * 3600 * 1000).toISOString() })
        .eq("id", transferencia_id);
      return { transferencia_id };
    },
    async run(ctx, data) {
      // Dispara cleanup via endpoint worker
      const resp = await ctx.http.get("/api/wms/transferencias/cleanup", {
        headers: { "x-worker-secret": process.env.WORKER_SECRET! },
      });
      assertEquals(resp.status, 200, "cleanup deve responder 200");
      const body = await resp.json();
      if (body.canceladas < 1) throw new Error(`canceladas=${body.canceladas}, esperado ≥1`);
    },
    async assertEsperado(ctx, data) {
      const { data: tr } = await ctx.sb
        .from("siso_transferencias_galpao")
        .select("status")
        .eq("id", data.transferencia_id)
        .single();
      assertEquals(tr?.status, "cancelada", "transferência deve estar cancelada");
    },
  };

  if (require.main === module) {
    runStandalone(cenario);
  }
  export default cenario;
  ```
- [ ] Register in `scripts/wms/cenarios/run-all.ts` (append to the catalog array).
- [ ] Run: `npx tsx scripts/wms/cenarios/catalogo/22-transferencia-em-transito-expira.ts` — confirm fails (`/api/wms/transferencias/cleanup` does not exist yet → 404).

#### Task A.1.2 — Migration `transferencias_expira_em`

- [ ] File: `supabase/migrations/20260527_transferencias_expira_em.sql`.
- [ ] Content:
  ```sql
  -- Adiciona expira_em + cancela_em_em pendentes; cron auto-cancela stale rows.
  -- 7 dias é razoável pra qualquer transferência física CWB↔SP via transportadora.
  BEGIN;

  ALTER TABLE siso_transferencias_galpao
    ADD COLUMN IF NOT EXISTS expira_em timestamptz;

  -- Backfill: pendentes ganham now()+7d; recebidas/canceladas ficam NULL (não interessa).
  UPDATE siso_transferencias_galpao
     SET expira_em = COALESCE(criada_em, now()) + interval '7 days'
   WHERE expira_em IS NULL
     AND status = 'em_transito';

  -- Default pro futuro
  ALTER TABLE siso_transferencias_galpao
    ALTER COLUMN expira_em SET DEFAULT (now() + interval '7 days');

  -- Index pra cleanup eficiente
  CREATE INDEX IF NOT EXISTS idx_transf_galpao_expira_em
    ON siso_transferencias_galpao(expira_em)
    WHERE status = 'em_transito';

  COMMIT;

  -- DOWN:
  --   ALTER TABLE siso_transferencias_galpao DROP COLUMN expira_em;
  --   DROP INDEX idx_transf_galpao_expira_em;
  ```
- [ ] Apply via `mcp__supabase__apply_migration` (project `ehbxpbeijofxtsbezwxd`).

#### Task A.1.3 — Endpoint `GET /api/wms/transferencias/cleanup`

- [ ] File: `src/app/api/wms/transferencias/cleanup/route.ts` (new).
- [ ] Content:
  ```ts
  import { NextRequest, NextResponse } from "next/server";
  import { createServiceClient } from "@/lib/supabase-server";
  import { logger } from "@/lib/logger";
  import { estornarMovimentacao } from "@/lib/wms/ledger";

  /**
   * GET /api/wms/transferencias/cleanup
   * Worker-secret protected.
   * Cancela transferências em_transito cujo expira_em < now() e estorna a mov S original.
   */
  export async function GET(req: NextRequest) {
    if (req.headers.get("x-worker-secret") !== process.env.WORKER_SECRET) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const sb = createServiceClient();
    const { data: stale } = await sb
      .from("siso_transferencias_galpao")
      .select("id")
      .eq("status", "em_transito")
      .lt("expira_em", new Date().toISOString());

    let canceladas = 0;
    const erros: Array<{ id: string; error: string }> = [];
    for (const tr of (stale ?? []) as Array<{ id: string }>) {
      try {
        // Coleta itens e estorna mov_saida_id pra reaplicar saldo
        const { data: itens } = await sb
          .from("siso_transferencia_galpao_itens")
          .select("id, mov_saida_id, mov_estorno_id")
          .eq("transferencia_id", tr.id);
        for (const item of (itens ?? []) as Array<{
          id: string;
          mov_saida_id: string | null;
          mov_estorno_id: string | null;
        }>) {
          if (item.mov_saida_id && !item.mov_estorno_id) {
            const novaMov = await estornarMovimentacao({
              mov_id: item.mov_saida_id,
              usuario_id: "00000000-0000-0000-0000-000000000000", // system
              motivo: "cron expira_em — transferência abandonada > 7 dias",
            });
            await sb
              .from("siso_transferencia_galpao_itens")
              .update({ mov_estorno_id: novaMov.id })
              .eq("id", item.id);
          }
        }
        await sb
          .from("siso_transferencias_galpao")
          .update({
            status: "cancelada",
            cancelada_em: new Date().toISOString(),
            observacoes: "auto-cancelada pelo cron de expira_em",
          })
          .eq("id", tr.id);
        canceladas++;
      } catch (err) {
        erros.push({ id: tr.id, error: err instanceof Error ? err.message : String(err) });
        logger.error("transferencias.cleanup", "falha ao auto-cancelar", {
          transferencia_id: tr.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return NextResponse.json({ canceladas, erros });
  }
  ```
- [ ] Re-run scenario 22 — confirm passes.
- [ ] Commit: `feat(wms/transferencias): expira_em + cleanup endpoint [#P6-6.1]`.

#### Task A.1.4 — Migration `cron_transferencias_em_transito_cleanup`

- [ ] File: `supabase/migrations/20260527_cron_transferencias_em_transito_cleanup.sql`.
- [ ] Content:
  ```sql
  -- Schedules the cleanup endpoint to run every 6h via pg_cron + http extension.
  BEGIN;

  -- pg_cron + http já habilitados (vide migrations 20260526 cobertura)
  -- Job: chama o endpoint worker secret-protected
  SELECT cron.schedule(
    'cron_transferencias_em_transito_cleanup',
    '0 */6 * * *',  -- a cada 6h no minuto 0
    $$
    SELECT net.http_get(
      url := concat(current_setting('app.base_url', true), '/api/wms/transferencias/cleanup'),
      headers := jsonb_build_object('x-worker-secret', current_setting('app.worker_secret', true))
    );
    $$
  );

  COMMIT;

  -- DOWN:
  --   SELECT cron.unschedule('cron_transferencias_em_transito_cleanup');
  ```
- [ ] **Note:** `app.base_url` e `app.worker_secret` precisam estar setados via `ALTER DATABASE ... SET`. Se ainda não estiverem (cron P1 deve ter setado), incluir nesta migration:
  ```sql
  -- Confirma settings (se faltar, P1 também adiciona)
  -- ALTER DATABASE postgres SET app.base_url = 'https://estoquelever.vercel.app';
  -- ALTER DATABASE postgres SET app.worker_secret = '<env WORKER_SECRET>';
  ```
- [ ] Apply migration. Verify with: `SELECT * FROM cron.job WHERE jobname='cron_transferencias_em_transito_cleanup';`.
- [ ] Commit: `feat(supabase): cron cleanup transferências em_transito 6h [#P6-6.1]`.

> **Coordinate with P5:** This endpoint feeds `card-transferencias-em-transito` in `/wms/page.tsx`. P5 reads `siso_transferencias_galpao WHERE status='em_transito' ORDER BY expira_em` to show countdown.

---

### A.2 — Endpoint `GET /api/wms/saldo-recebimento-orfao` [#P6-5.4]

Detecta saldo em loc tipo='recebimento' sem pendência ativa de guarda. Cancelar pendência hoje deixa saldo fantasma — alerta visual em P5 consome este endpoint.

#### Task A.2.1 — Write failing scenario `23-saldo-recebimento-orfao.ts`

- [ ] File: `scripts/wms/cenarios/catalogo/23-saldo-recebimento-orfao.ts`.
- [ ] Skeleton:
  ```ts
  import type { Cenario } from "../_harness/types";
  import { runStandalone } from "../_harness/standalone";
  import { assertEquals } from "../_harness/asserts";

  const cenario: Cenario = {
    nome: "23 — saldo recebimento órfão detectado após cancelar pendência",
    async setup(ctx) {
      const { staging } = ctx;
      const recResp = await ctx.http.post("/api/wms/receber", {
        galpao_id: staging.galpaoCwbId,
        itens: [{
          produto_id: staging.produtoAlphaId,
          qty: 7,
          custo_unitario: 10,
          origem_tipo: "nf_compra",
        }],
      });
      assertEquals(recResp.status, 200, "recebimento inicial");
      const recBody = await recResp.json();
      const pendId = recBody.pendencias[0].id;
      // Cancela pendência sem mover saldo (saldo fica fantasma em RECEBIMENTO)
      const cancelResp = await ctx.http.post(`/api/wms/guarda/${pendId}/cancelar`, {
        motivo: "teste cenário 23",
      });
      assertEquals(cancelResp.status, 200, "cancelar pendência");
      return { pendId };
    },
    async run(ctx) {
      const resp = await ctx.http.get(
        `/api/wms/saldo-recebimento-orfao?galpao_id=${ctx.staging.galpaoCwbId}`,
      );
      assertEquals(resp.status, 200, "endpoint responde");
      const body = await resp.json();
      if (!body.itens || body.itens.length === 0)
        throw new Error("esperava ≥1 saldo órfão");
      const algumAlpha = body.itens.find(
        (i: any) => i.produto_id === ctx.staging.produtoAlphaId,
      );
      if (!algumAlpha)
        throw new Error("esperava saldo órfão de produtoAlpha");
      if (Number(algumAlpha.saldo) !== 7)
        throw new Error(`saldo=${algumAlpha.saldo}, esperado 7`);
    },
    async assertEsperado() { /* já validado em run */ },
  };

  if (require.main === module) runStandalone(cenario);
  export default cenario;
  ```
- [ ] Run, confirm 404 (endpoint não existe).

#### Task A.2.2 — Implement `GET /api/wms/saldo-recebimento-orfao`

- [ ] File: `src/app/api/wms/saldo-recebimento-orfao/route.ts` (new).
- [ ] Content:
  ```ts
  import { NextRequest, NextResponse } from "next/server";
  import { createServiceClient } from "@/lib/supabase-server";
  import { requireWarehouseAccess } from "@/lib/wms/auth";

  /**
   * GET /api/wms/saldo-recebimento-orfao?galpao_id=<uuid>
   *
   * Lista saldos em locs tipo='recebimento' que NÃO têm pendência de guarda
   * ativa (pendente ou em_guarda). Sinaliza saldo fantasma: peça chegou no
   * dock mas a pendência foi cancelada antes de guardar — o saldo continua
   * "preso" no RECEBIMENTO e ninguém vai endereçá-lo.
   *
   * Consumido pelo card de alerta na home /wms (P5).
   */
  export async function GET(req: NextRequest) {
    const auth = await requireWarehouseAccess(req);
    if (!auth.ok) return auth.response;

    const galpaoId = req.nextUrl.searchParams.get("galpao_id");

    const sb = createServiceClient();

    // 1. Locs tipo='recebimento' do galpão (ou todos se galpao_id ausente)
    let locQuery = sb
      .from("siso_localizacoes")
      .select("id, codigo, galpao_id")
      .eq("tipo", "recebimento")
      .eq("ativo", true);
    if (galpaoId) locQuery = locQuery.eq("galpao_id", galpaoId);
    const { data: locsRec } = await locQuery;
    const locIds = (locsRec ?? []).map((l) => l.id as string);
    if (locIds.length === 0) return NextResponse.json({ itens: [] });

    // 2. Saldos > 0 nessas locs
    const { data: saldos } = await sb
      .from("siso_estoque")
      .select("produto_id, galpao_id, localizacao_id, saldo, disponivel")
      .in("localizacao_id", locIds)
      .gt("saldo", 0);

    const saldosArr = (saldos ?? []) as Array<{
      produto_id: string;
      galpao_id: string;
      localizacao_id: string;
      saldo: number;
      disponivel: number;
    }>;
    if (saldosArr.length === 0) return NextResponse.json({ itens: [] });

    // 3. Pendências ativas em cada (produto, loc) — agrega qty
    const { data: pends } = await sb
      .from("siso_wms_pendencias_guarda")
      .select("produto_id, localizacao_origem_id, qty_pendente")
      .in("status", ["pendente", "em_guarda"])
      .in("localizacao_origem_id", locIds);

    const pendIndex = new Map<string, number>();
    for (const p of (pends ?? []) as Array<{
      produto_id: string;
      localizacao_origem_id: string;
      qty_pendente: number;
    }>) {
      const key = `${p.produto_id}|${p.localizacao_origem_id}`;
      pendIndex.set(key, (pendIndex.get(key) ?? 0) + Number(p.qty_pendente));
    }

    // 4. Resolve produtos + locs metadata
    const produtoIds = [...new Set(saldosArr.map((s) => s.produto_id))];
    const { data: produtos } = await sb
      .from("siso_produtos")
      .select("id, sku, descricao")
      .in("id", produtoIds);
    const prodMap = new Map(
      ((produtos ?? []) as Array<{ id: string; sku: string; descricao: string }>).map(
        (p) => [p.id, p],
      ),
    );
    const locMap = new Map(
      ((locsRec ?? []) as Array<{ id: string; codigo: string; galpao_id: string }>).map(
        (l) => [l.id, l],
      ),
    );

    const itens: Array<{
      produto_id: string;
      sku: string;
      descricao: string;
      galpao_id: string;
      localizacao_id: string;
      localizacao_codigo: string;
      saldo: number;
      pendente_total: number;
      orfao: number;
    }> = [];
    for (const s of saldosArr) {
      const key = `${s.produto_id}|${s.localizacao_id}`;
      const pendQty = pendIndex.get(key) ?? 0;
      const orfao = Number(s.saldo) - pendQty;
      if (orfao > 0) {
        const prod = prodMap.get(s.produto_id);
        const loc = locMap.get(s.localizacao_id);
        if (!prod || !loc) continue;
        itens.push({
          produto_id: s.produto_id,
          sku: prod.sku,
          descricao: prod.descricao,
          galpao_id: s.galpao_id,
          localizacao_id: s.localizacao_id,
          localizacao_codigo: loc.codigo,
          saldo: Number(s.saldo),
          pendente_total: pendQty,
          orfao,
        });
      }
    }

    return NextResponse.json({ itens });
  }
  ```
- [ ] Re-run scenario 23 — confirm passes.
- [ ] Commit: `feat(wms/saldo-recebimento-orfao): endpoint detecta saldo fantasma [#P6-5.4]`.

> **Coordinate with P5:** P5 task `card-saldo-recebimento-orfao` reads from this endpoint and renders a yellow alert card on `/wms/page.tsx`. P5 click links to `/wms/receber?galpao_id=X&filter=orfao`.

---

### A.3 — `cleanupInventario` estende: operadores zumbi + locks com bloqueada_por finalizado [#P6-4.10, #P6-6.3, #P6-6.5, #P6-6.6, #P6-4.18]

Atual cleanup só libera locks > 30min sem contagem. Precisa cobrir:
1. Operadores ativos (finalizado_em IS NULL) sem ação > 30min → força finalizado_em
2. Locs em_contagem cujo bloqueada_por já está finalizado → libera lock
3. Quando operador sai-party, libera locs em_contagem dele

#### Task A.3.1 — Write failing scenario `24-cleanup-operadores-zumbi.ts`

- [ ] File: `scripts/wms/cenarios/catalogo/24-cleanup-operadores-zumbi.ts`.
- [ ] Skeleton:
  ```ts
  import type { Cenario } from "../_harness/types";
  import { runStandalone } from "../_harness/standalone";
  import { assertEquals } from "../_harness/asserts";

  const cenario: Cenario = {
    nome: "24 — cleanup libera operador zumbi e lock órfão",
    async setup(ctx) {
      const { staging } = ctx;
      // Cria sessão e entra na party como test-runner
      const sessResp = await ctx.http.post("/api/wms/inventario", {
        tipo: "cycle_count",
        galpao_id: staging.galpaoCwbId,
        modo: "blind",
        tamanho_pool: 5,
      });
      const { id: sessao_id } = await sessResp.json();
      await ctx.http.post(`/api/wms/inventario/${sessao_id}/iniciar`);
      await ctx.http.post(`/api/wms/inventario/${sessao_id}/party`);
      // Reivindica próxima loc → cria bloqueada_por
      const proxResp = await ctx.http.post(`/api/wms/inventario/${sessao_id}/proxima-loc`);
      const proxBody = await proxResp.json();
      const locInvId = proxBody.inv_loc_id;
      // Força ultima_acao_em pro passado (operador zumbi)
      await ctx.sb
        .from("siso_inventario_operadores")
        .update({ ultima_acao_em: new Date(Date.now() - 45 * 60 * 1000).toISOString() })
        .eq("sessao_id", sessao_id)
        .is("finalizado_em", null);
      return { sessao_id, locInvId };
    },
    async run(ctx) {
      const resp = await ctx.http.get("/api/wms/inventario/cleanup", {
        headers: { "x-worker-secret": process.env.WORKER_SECRET! },
      });
      assertEquals(resp.status, 200);
      const body = await resp.json();
      if (!body.operadoresFinalizados || body.operadoresFinalizados < 1)
        throw new Error("esperava ≥1 operador zumbi finalizado");
    },
    async assertEsperado(ctx, data) {
      const { data: op } = await ctx.sb
        .from("siso_inventario_operadores")
        .select("finalizado_em")
        .eq("sessao_id", data.sessao_id)
        .single();
      if (!op?.finalizado_em) throw new Error("operador deveria estar finalizado");
      // Lock deveria ter sido liberado (status volta a pendente)
      const { data: loc } = await ctx.sb
        .from("siso_inventario_localizacoes")
        .select("status, bloqueada_por")
        .eq("id", data.locInvId)
        .single();
      assertEquals(loc?.status, "pendente", "loc deveria voltar a pendente");
      assertEquals(loc?.bloqueada_por, null, "bloqueada_por deveria ser null");
    },
  };

  if (require.main === module) runStandalone(cenario);
  export default cenario;
  ```
- [ ] Run, confirm fails (cleanup atual não cobre operadores zumbi).

#### Task A.3.2 — Estende `recoveryInventario`

- [ ] File: `src/lib/wms/inventario-recovery.ts`.
- [ ] Substitui o arquivo inteiro:
  ```ts
  import { createServiceClient } from "@/lib/supabase-server";
  import { logger } from "@/lib/logger";

  /**
   * Cleanup órfãos do inventário:
   * 1. Sessões em_andamento sem atividade > 4h → marca alerta (log)
   * 2. Locks de loc > 30min sem contagem → libera o lock
   * 3. Operadores ativos sem ação > 30min → força finalizado_em + libera locks
   *    cuja bloqueada_por é esse operador
   * 4. Locks cuja bloqueada_por já está finalizado (sair-party não limpou) → libera
   */
  export async function recoveryInventario(): Promise<{
    sessoesAlerta: string[];
    locksLiberados: number;
    operadoresFinalizados: number;
    locksLiberadosPorFinalizado: number;
  }> {
    const sb = createServiceClient();
    const cutoff4h = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    const cutoff30m = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    // 1. Sessões em andamento sem atividade recente
    const { data: ativas } = await sb
      .from("siso_inventario_sessoes")
      .select("id, iniciada_em")
      .eq("status", "em_andamento");

    const alertaIds: string[] = [];
    for (const s of (ativas ?? []) as Array<{
      id: string;
      iniciada_em: string | null;
    }>) {
      const { data: ultima } = await sb
        .from("siso_inventario_contagens")
        .select("criado_em")
        .eq("sessao_id", s.id)
        .order("criado_em", { ascending: false })
        .limit(1)
        .maybeSingle();
      const ultimaTs =
        (ultima as { criado_em: string } | null)?.criado_em ?? s.iniciada_em;
      if (ultimaTs && ultimaTs < cutoff4h) {
        alertaIds.push(s.id);
        logger.warn("wms.inventario.recovery", "sessão sem atividade recente", {
          sessao_id: s.id,
          ultimaTs,
        });
      }
    }

    // 2. Locks > 30min sem contagem nova
    const { data: locks } = await sb
      .from("siso_inventario_localizacoes")
      .select("id, sessao_id, localizacao_id, bloqueada_em, bloqueada_por")
      .eq("status", "em_contagem")
      .lt("bloqueada_em", cutoff30m);

    let locksLiberados = 0;
    for (const l of (locks ?? []) as Array<{
      id: string;
      sessao_id: string;
      localizacao_id: string;
      bloqueada_em: string;
      bloqueada_por: string;
    }>) {
      const { data: ultimaCont } = await sb
        .from("siso_inventario_contagens")
        .select("criado_em")
        .eq("sessao_id", l.sessao_id)
        .eq("localizacao_id", l.localizacao_id)
        .order("criado_em", { ascending: false })
        .limit(1)
        .maybeSingle();
      const ts =
        (ultimaCont as { criado_em: string } | null)?.criado_em ?? l.bloqueada_em;
      if (ts && ts < cutoff30m) {
        await sb
          .from("siso_inventario_localizacoes")
          .update({
            bloqueada_por: null,
            bloqueada_em: null,
            status: "pendente",
          })
          .eq("id", l.id);
        locksLiberados++;
      }
    }

    // 3. Operadores ativos zumbi (ultima_acao_em > 30min)
    const { data: zumbis } = await sb
      .from("siso_inventario_operadores")
      .select("id, sessao_id, usuario_id, ultima_acao_em")
      .is("finalizado_em", null)
      .lt("ultima_acao_em", cutoff30m);

    let operadoresFinalizados = 0;
    let locksLiberadosPorFinalizado = 0;
    for (const op of (zumbis ?? []) as Array<{
      id: string;
      sessao_id: string;
      usuario_id: string;
      ultima_acao_em: string;
    }>) {
      // Finaliza operador (trigger BEFORE UPDATE limpa claim_*)
      await sb
        .from("siso_inventario_operadores")
        .update({ finalizado_em: new Date().toISOString() })
        .eq("id", op.id);
      operadoresFinalizados++;
      // Libera locks de loc cuja bloqueada_por é esse operador
      const { data: orphLocs } = await sb
        .from("siso_inventario_localizacoes")
        .select("id")
        .eq("sessao_id", op.sessao_id)
        .eq("bloqueada_por", op.usuario_id)
        .eq("status", "em_contagem");
      for (const ol of (orphLocs ?? []) as Array<{ id: string }>) {
        await sb
          .from("siso_inventario_localizacoes")
          .update({
            bloqueada_por: null,
            bloqueada_em: null,
            status: "pendente",
          })
          .eq("id", ol.id);
        locksLiberadosPorFinalizado++;
      }
      logger.warn("wms.inventario.recovery", "operador zumbi finalizado", {
        operador_id: op.id,
        sessao_id: op.sessao_id,
        usuario_id: op.usuario_id,
        ultima_acao_em: op.ultima_acao_em,
      });
    }

    // 4. Locks cuja bloqueada_por já está finalizado_em (sair-party deixou rastro)
    // Subquery: pega ids de loc onde bloqueada_por está finalizado nesta sessão
    const { data: locksFinalizados } = await sb.rpc(
      "wms_locks_bloqueada_por_finalizado",
    );
    if (Array.isArray(locksFinalizados)) {
      for (const id of locksFinalizados as string[]) {
        await sb
          .from("siso_inventario_localizacoes")
          .update({
            bloqueada_por: null,
            bloqueada_em: null,
            status: "pendente",
          })
          .eq("id", id);
        locksLiberadosPorFinalizado++;
      }
    }

    return {
      sessoesAlerta: alertaIds,
      locksLiberados,
      operadoresFinalizados,
      locksLiberadosPorFinalizado,
    };
  }
  ```

#### Task A.3.3 — Migration RPC `wms_locks_bloqueada_por_finalizado`

- [ ] File: `supabase/migrations/20260527_wms_locks_bloqueada_por_finalizado.sql`.
- [ ] Content:
  ```sql
  BEGIN;

  CREATE OR REPLACE FUNCTION wms_locks_bloqueada_por_finalizado()
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  AS $function$
    SELECT il.id
      FROM siso_inventario_localizacoes il
      JOIN siso_inventario_operadores op
        ON op.sessao_id = il.sessao_id
       AND op.usuario_id = il.bloqueada_por
     WHERE il.status = 'em_contagem'
       AND il.bloqueada_por IS NOT NULL
       AND op.finalizado_em IS NOT NULL;
  $function$;

  COMMIT;

  -- DOWN:
  --   DROP FUNCTION wms_locks_bloqueada_por_finalizado();
  ```
- [ ] Apply migration.
- [ ] Re-run scenario 24 — confirm passes.
- [ ] Commit: `feat(wms/inventario): cleanup operadores zumbi e locks órfãos [#P6-4.10 #P6-6.3 #P6-6.5 #P6-6.6 #P6-4.18]`.

> **Coordinate with P3:** P3 já adiciona idempotência + UNIQUE handling em `lib/wms/inventario.ts`. As alterações deste task NÃO tocam aquele arquivo — só `inventario-recovery.ts`. Sem conflito.

> **Coordinate with P1:** P1 adiciona cron de cleanup que invoca este endpoint a cada 30min — depois desta tarefa, o cron passa a finalizar zumbis automaticamente.

---

### A.4 — `compras-release` migrado off `siso_empresas.galpao_id` [#P6-3.9, #P6-6.4]

Hoje `resolveEmpresaGalpaoId` lê `siso_empresas.galpao_id` (deprecated — é espelho do 1º preferencial). Decisão correta vem de `siso_pedidos.separacao_galpao_id` (já é setado pelo webhook-processor com base na empresa origem + roteamento).

**Source-of-truth analysis:**
- `siso_ordens_compra.galpao_id`: galpão de **recebimento** da OC (onde a peça vai chegar)
- `siso_pedidos.separacao_galpao_id`: galpão de **execução** da separação (onde o pedido vai ser separado, decidido no webhook)
- Comparação `ocGalpaoId === pedidoGalpaoId` decide `propria` vs `transferencia`

**Fix:** trocar `resolveEmpresaGalpaoId(empresaId)` por leitura direta de `pedido.separacao_galpao_id`. Quando NULL (raro — pedidos antigos pré-WMS), fallback pra `siso_empresa_galpoes_preferenciais` (1º galpão preferencial da empresa).

#### Task A.4.1 — Write failing scenario `25-compras-release-galpao-via-pedido.ts`

- [ ] File: `scripts/wms/cenarios/catalogo/25-compras-release-galpao-via-pedido.ts`.
- [ ] Skeleton (depende de helpers existentes — adapte do cenário 03):
  ```ts
  import type { Cenario } from "../_harness/types";
  import { runStandalone } from "../_harness/standalone";
  import { assertEquals } from "../_harness/asserts";

  const cenario: Cenario = {
    nome: "25 — compras-release usa separacao_galpao_id ao invés de empresa.galpao_id deprecated",
    async setup(ctx) {
      const { staging } = ctx;
      // Cria pedido OC com empresa NetAir (preferencial CWB) MAS força separacao_galpao_id=SP
      // pra simular roteamento que escolheu galpão diferente do preferencial da empresa.
      // Cria pedido com qty=2, sem saldo em nenhum galpão → vira OC.
      const webhookResp = await ctx.http.post("/api/wms/webhook/tiny", {
        type: "pedido",
        empresa_cnpj: "34857388000163", // NetAir
        pedido_numero: "PEDIDO-25",
        items: [{ sku: staging.skuAlphaSemEstoque, qty: 2 }],
      });
      assertEquals(webhookResp.status, 200);
      // Espera webhook processar
      await ctx.sleep(2000);
      const { data: pedido } = await ctx.sb
        .from("siso_pedidos")
        .select("id, separacao_galpao_id")
        .eq("numero", "PEDIDO-25")
        .single();
      // Força separacao_galpao_id pro galpão SP (mesmo NetAir sendo CWB-preferencial)
      await ctx.sb
        .from("siso_pedidos")
        .update({ separacao_galpao_id: staging.galpaoSpId })
        .eq("id", pedido.id);
      // Cria OC no galpão SP
      const { data: oc } = await ctx.sb
        .from("siso_ordens_compra")
        .insert({
          galpao_id: staging.galpaoSpId,
          fornecedor: "TestFornecedor",
          status: "aberta",
          comprado_por: ctx.staging.adminId,
          comprado_em: new Date().toISOString(),
        })
        .select("id")
        .single();
      // Linka item à OC e marca como recebido
      await ctx.sb
        .from("siso_pedido_itens")
        .update({
          compra_status: "recebido",
          ordem_compra_id: oc.id,
        })
        .eq("pedido_id", pedido.id);
      return { pedido_id: pedido.id, oc_id: oc.id };
    },
    async run(ctx, data) {
      // Importa o release pra disparar manualmente
      const { checkAndReleasePedidos } = await import("../../../../src/lib/compras-release");
      const { data: itens } = await ctx.sb
        .from("siso_pedido_itens")
        .select("id")
        .eq("pedido_id", data.pedido_id);
      const released = await checkAndReleasePedidos(itens!.map((i) => i.id));
      if (!released.includes(data.pedido_id))
        throw new Error("pedido deveria ter sido liberado");
    },
    async assertEsperado(ctx, data) {
      const { data: pedido } = await ctx.sb
        .from("siso_pedidos")
        .select("decisao_final, status_separacao, separacao_galpao_id")
        .eq("id", data.pedido_id)
        .single();
      // OC galpão = SP, pedido galpão = SP → mesmoGalpao → decisao=propria
      assertEquals(pedido?.decisao_final, "propria", "deve ser propria (mesmo galpão)");
      assertEquals(
        pedido?.separacao_galpao_id,
        ctx.staging.galpaoSpId,
        "separacao_galpao_id preserva SP",
      );
    },
  };

  if (require.main === module) runStandalone(cenario);
  export default cenario;
  ```
- [ ] Run, confirm a current behavior: empresa.galpao_id de NetAir é CWB → ocGalpao=SP, pedidoGalpao=CWB → decide `transferencia` (WRONG). Test fails because expects `propria`.

#### Task A.4.2 — Refactor `compras-release.ts`

- [ ] File: `src/lib/compras-release.ts`.
- [ ] Substitui o helper `resolveEmpresaGalpaoId` por leitura via pedido:
  - Linha 88: ao selecionar pedido, inclui `separacao_galpao_id`:
    ```ts
    const { data: pedido, error: pedidoError } = await supabase
      .from("siso_pedidos")
      .select("id, empresa_origem_id, status_separacao, separacao_galpao_id")
      .eq("id", pedidoId)
      .single();
    ```
  - Linha 110: troca por:
    ```ts
    let pedidoGalpaoId: string | null = pedido.separacao_galpao_id;
    // Fallback pra pedidos antigos sem separacao_galpao_id setado
    if (!pedidoGalpaoId) {
      pedidoGalpaoId = await resolvePedidoGalpaoIdFallback(supabase, pedido.empresa_origem_id);
    }
    ```
  - Adiciona helper novo no fim do arquivo (e remove `resolveEmpresaGalpaoId`):
    ```ts
    /**
     * Fallback pra pedidos pré-WMS que não têm separacao_galpao_id setado.
     * Pega o 1º galpão preferencial da empresa origem.
     */
    async function resolvePedidoGalpaoIdFallback(
      supabase: ReturnType<typeof createServiceClient>,
      empresaId: string | null,
    ): Promise<string | null> {
      if (!empresaId) return null;
      const { data: pref } = await supabase
        .from("siso_empresa_galpoes_preferenciais")
        .select("galpao_id, siso_galpoes!inner(nome)")
        .eq("empresa_id", empresaId)
        .order("siso_galpoes(nome)", { ascending: true })
        .limit(1)
        .maybeSingle();
      return (pref as { galpao_id: string } | null)?.galpao_id ?? null;
    }
    ```
  - Linha 128 (`empresaExecId` cross-galpão lookup): troca por preferenciais N:N:
    ```ts
    let empresaExecId = pedido.empresa_origem_id;
    if (!mesmoGalpao) {
      // Procura empresa cujo 1º preferencial é o ocGalpaoId
      const { data: prefEmp } = await supabase
        .from("siso_empresa_galpoes_preferenciais")
        .select("empresa_id, siso_empresas!inner(id, ativo)")
        .eq("galpao_id", ocGalpaoId)
        .eq("siso_empresas.ativo", true)
        .order("empresa_id", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (prefEmp) {
        empresaExecId = (prefEmp as { empresa_id: string }).empresa_id;
      }
    }
    ```
- [ ] Run scenario 25 — confirm passes (decisao=`propria` quando pedido.separacao_galpao_id=SP e OC.galpao_id=SP).
- [ ] Run cenários existentes 03 (OC completo) e 01 (auto propria) — confirma não regridem.
- [ ] Commit: `fix(compras-release): usa separacao_galpao_id ao invés de empresa.galpao_id deprecated [#P6-3.9 #P6-6.4]`.

> **Coordinate with P1:** P1 já patch RPCs insights que liam `siso_empresas.galpao_id`. Este task remove o último consumer Node de runtime. Após P1 + este: 0 leituras em runtime — só os admin/list endpoints (que mantêm pra UI mostrar preferencial). 

#### Task A.4.3 — Migration documentando soft-deprecation runtime

- [ ] File: `supabase/migrations/20260527_compras_release_galpao_via_oc.sql`.
- [ ] Conteúdo é uma migration "documentational" + check que valida não há runtime path lendo deprecated:
  ```sql
  -- Marca soft-deprecation runtime de siso_empresas.galpao_id.
  -- Coluna fica (UI admin lê pra mostrar preferencial), mas NENHUM consumer
  -- de runtime crítico pode mais filtrar/decidir por ela.
  -- O trigger sync_empresa_galpao_id_from_preferenciais continua mantendo o
  -- espelho atualizado pra UI.
  BEGIN;

  COMMENT ON COLUMN siso_empresas.galpao_id IS
    'DEPRECATED (runtime) — espelho do 1º galpão preferencial mantido por trigger.'
    ' Não usar em decisões de negócio. Source of truth: siso_empresa_galpoes_preferenciais.'
    ' UI admin pode ler pra exibir o "preferencial principal" agregado.';

  COMMIT;
  ```
- [ ] Apply.
- [ ] Commit: `docs(supabase): documenta deprecação runtime de siso_empresas.galpao_id [#P6-6.4]`.

---

### A.5 — Delete `transferir-galpao` endpoint órfão [#P6-6.7, #P6-8.11]

#### Task A.5.1 — Search for callers

- [ ] Run search:
  ```bash
  grep -rn "/api/wms/transferir-galpao" /Users/eryk/Documents/ESTOQUE/src /Users/eryk/Documents/ESTOQUE/scripts /Users/eryk/Documents/ESTOQUE/docs --include="*.ts" --include="*.tsx" --include="*.md" | grep -v "spec\|plan"
  ```
- [ ] If any caller found: PARAR e perguntar usuário. Caso contrário (esperado), prossegue.

#### Task A.5.2 — Write failing test: endpoint should 404

- [ ] File: `scripts/wms/cenarios/catalogo/26-transferir-galpao-removido.ts`.
- [ ] Skeleton:
  ```ts
  import type { Cenario } from "../_harness/types";
  import { runStandalone } from "../_harness/standalone";
  import { assertEquals } from "../_harness/asserts";

  const cenario: Cenario = {
    nome: "26 — endpoint /api/wms/transferir-galpao não existe mais (404)",
    async setup() { return {}; },
    async run(ctx) {
      const resp = await ctx.http.post("/api/wms/transferir-galpao", {});
      assertEquals(resp.status, 404, "endpoint deve retornar 404");
    },
    async assertEsperado() {},
  };

  if (require.main === module) runStandalone(cenario);
  export default cenario;
  ```
- [ ] Run, confirm fails (endpoint still exists, responds 200 ou 400 — não 404).

#### Task A.5.3 — Delete endpoint

- [ ] `rm src/app/api/wms/transferir-galpao/route.ts && rmdir src/app/api/wms/transferir-galpao`.
- [ ] Update `CLAUDE.md`: remove `transferir-galpao/route.ts` line from the API structure section.
- [ ] Update `docs/api-reference-complete.md`: remove the `POST /api/wms/transferir-galpao` entry.
- [ ] Re-run scenario 26 — confirm passes.
- [ ] Commit: `feat(wms): remove endpoint órfão /api/wms/transferir-galpao [#P6-6.7 #P6-8.11]`.

---

## B. Hardcoded / Schema

### B.1 — RPC `wms_inventario_sugerir` exclui `tipo='quarentena'` [#P6-6.10, #P6-6.9 (devolucoes)]

Quarentena tem produtos retidos (avaria, garantia) — não devem ser sugeridos pra cycle count (geraria divergência sobre saldo "esperado-bloqueado").

#### Task B.1.1 — Write failing scenario `27-sugerir-exclui-quarentena.ts`

- [ ] File: `scripts/wms/cenarios/catalogo/27-sugerir-exclui-quarentena.ts`.
- [ ] Skeleton:
  ```ts
  import type { Cenario } from "../_harness/types";
  import { runStandalone } from "../_harness/standalone";
  import { assertEquals } from "../_harness/asserts";

  const cenario: Cenario = {
    nome: "27 — wms_inventario_sugerir exclui locs tipo=quarentena",
    async setup(ctx) {
      const { staging } = ctx;
      // Cria loc tipo=quarentena no galpão CWB com saldo (via classificar devolucao avariada)
      const { data: locQ } = await ctx.sb
        .from("siso_localizacoes")
        .insert({
          galpao_id: staging.galpaoCwbId,
          codigo: "QUARENTENA-TEST-27",
          tipo: "quarentena",
          ativo: true,
        })
        .select("id")
        .single();
      // Insere saldo via ajuste pra dar volume na quarentena
      await ctx.http.post("/api/wms/ajuste", {
        tripla: {
          produto_id: staging.produtoAlphaId,
          galpao_id: staging.galpaoCwbId,
          localizacao_id: locQ.id,
        },
        qty: 5,
        direcao: "entrada",
        motivo: "seed cenário 27",
      });
      return { locQuarentenaId: locQ.id };
    },
    async run(ctx, data) {
      const { data: sugestoes } = await ctx.sb.rpc("wms_inventario_sugerir", {
        p_galpao: ctx.staging.galpaoCwbId,
        p_tamanho: 50,
      });
      const found = (sugestoes as Array<{ localizacao_id: string }>).some(
        (s) => s.localizacao_id === data.locQuarentenaId,
      );
      if (found) throw new Error("loc quarentena não pode aparecer na sugestão");
    },
    async assertEsperado() {},
  };

  if (require.main === module) runStandalone(cenario);
  export default cenario;
  ```
- [ ] Run, confirm fails (loc quarentena aparece).

#### Task B.1.2 — Migration `wms_inventario_sugerir` exclui quarentena

- [ ] File: `supabase/migrations/20260527_inventario_sugerir_excluir_quarentena.sql`.
- [ ] Content (RPC completa, copia de 20260520e + adiciona `loc.tipo <> 'quarentena'` em todas as 3 CTEs):
  ```sql
  BEGIN;

  CREATE OR REPLACE FUNCTION wms_inventario_sugerir(p_galpao uuid, p_tamanho integer DEFAULT 30)
  RETURNS TABLE(localizacao_id uuid, codigo text, motivo text, score numeric)
  LANGUAGE plpgsql
  AS $function$
  DECLARE
    v_qtd_a int := GREATEST(1, FLOOR(p_tamanho * 0.5)::int);
    v_qtd_div int := GREATEST(0, FLOOR(p_tamanho * 0.3)::int);
    v_qtd_old int := GREATEST(0, p_tamanho - v_qtd_a - v_qtd_div);
  BEGIN
    RETURN QUERY
    WITH curva_a AS (
      SELECT e.localizacao_id AS loc_id,
             SUM(c.giro_30d) AS score
      FROM siso_estoque e
      JOIN siso_curva_abc c ON c.produto_id = e.produto_id AND c.galpao_id = e.galpao_id
      JOIN siso_localizacoes loc ON loc.id = e.localizacao_id
      WHERE c.curva = 'A'
        AND loc.galpao_id = p_galpao
        AND loc.ativo
        AND loc.tipo <> 'quarentena'  -- ← exclui retidos
        AND e.saldo > 0
      GROUP BY e.localizacao_id
      ORDER BY score DESC
      LIMIT v_qtd_a
    ),
    divergentes AS (
      SELECT d.localizacao_id AS loc_id,
             COUNT(*)::numeric AS score
      FROM siso_inventario_divergencias d
      JOIN siso_inventario_sessoes s ON s.id = d.sessao_id
      JOIN siso_localizacoes loc ON loc.id = d.localizacao_id
      WHERE d.status = 'aplicada'
        AND s.aplicada_em >= now() - interval '60 days'
        AND loc.galpao_id = p_galpao
        AND loc.ativo
        AND loc.tipo <> 'quarentena'  -- ← exclui retidos
        AND d.localizacao_id NOT IN (SELECT loc_id FROM curva_a)
      GROUP BY d.localizacao_id
      ORDER BY score DESC
      LIMIT v_qtd_div
    ),
    antigos AS (
      SELECT loc.id AS loc_id,
             COALESCE(
               EXTRACT(EPOCH FROM (now() - loc.ultima_contagem_em)) / 86400,
               9999
             )::numeric AS score
      FROM siso_localizacoes loc
      WHERE loc.galpao_id = p_galpao
        AND loc.ativo
        AND loc.tipo <> 'quarentena'  -- ← exclui retidos
        AND (loc.ultima_contagem_em IS NULL
             OR loc.ultima_contagem_em < now() - interval '30 days')
        AND loc.id NOT IN (SELECT loc_id FROM curva_a)
        AND loc.id NOT IN (SELECT loc_id FROM divergentes)
        AND EXISTS (
          SELECT 1 FROM siso_estoque e
          WHERE e.localizacao_id = loc.id
            AND e.saldo > 0
        )
      ORDER BY score DESC
      LIMIT v_qtd_old
    )
    SELECT ca.loc_id, loc.codigo, 'curva_a'::text, ca.score
      FROM curva_a ca JOIN siso_localizacoes loc ON loc.id = ca.loc_id
    UNION ALL
    SELECT d.loc_id, loc.codigo, 'divergente_recente'::text, d.score
      FROM divergentes d JOIN siso_localizacoes loc ON loc.id = d.loc_id
    UNION ALL
    SELECT a.loc_id, loc.codigo, 'sem_contagem_recente'::text, a.score
      FROM antigos a JOIN siso_localizacoes loc ON loc.id = a.loc_id;
  END;
  $function$;

  COMMIT;

  -- DOWN:
  --   Restaurar versão anterior em 20260520e_rpc_inventario.sql linha 506+.
  ```
- [ ] Apply migration.
- [ ] Re-run scenario 27 — confirm passes.
- [ ] Commit: `fix(wms/inventario): sugerir exclui locs tipo=quarentena [#P6-6.10 #P6-6.9]`.

---

### B.2 — Devoluções loc quarentena com ORDER BY [#P6-6.11, #P6-6.8]

`classificarDevolucao` (avariado) escolhe loc quarentena via `LIMIT 1` sem ORDER — não-determinístico.

#### Task B.2.1 — Edit `devolucoes.ts`

- [ ] File: `src/lib/wms/devolucoes.ts`.
- [ ] Localizar (linhas ~158-168):
  ```ts
  const { data: quarentena } = await sb
    .from("siso_localizacoes")
    .select("id")
    .match({
      galpao_id: input.galpao_id,
      tipo: "quarentena",
      ativo: true,
    })
    .limit(1)
    .maybeSingle();
  ```
- [ ] Adicionar `.order("codigo", { ascending: true })` antes do `.limit(1)`:
  ```ts
  const { data: quarentena } = await sb
    .from("siso_localizacoes")
    .select("id")
    .match({
      galpao_id: input.galpao_id,
      tipo: "quarentena",
      ativo: true,
    })
    .order("codigo", { ascending: true })  // ← determinístico
    .limit(1)
    .maybeSingle();
  ```

#### Task B.2.2 — Migration de log/doc (não-código)

- [ ] File: `supabase/migrations/20260527_devolucoes_loc_quarentena_order.sql`.
- [ ] Content (sem alteração SQL — só doc):
  ```sql
  -- Documentational only: lib/wms/devolucoes.ts agora ordena quarentena por
  -- codigo ASC pra determinismo entre múltiplas locs quarentena por galpão.
  -- Nenhuma alteração de schema.
  BEGIN;
  -- intencionalmente vazia
  COMMIT;
  ```
- [ ] (Migration vazia serve apenas pra documentar o link doc↔fix; pode-se pular se preferir.)
- [ ] Commit: `fix(wms/devolucoes): order quarentena por codigo ASC (determinismo) [#P6-6.11 #P6-6.8]`.

---

### B.3 — `vendas-disponibilidade` sem hardcoded "CWB"/"SP" [#P6-6.12]

Atual `TIPO_RANK` é OK (não tem hardcoded). O problema reside em `vendas/criar` (cwb_atende/sp_atende). Cobrir ambos.

#### Task B.3.1 — Audit current state

- [ ] Read `src/lib/wms/vendas-disponibilidade.ts` end-to-end. **Status:** o arquivo já NÃO tem hardcoded CWB/SP (somente TIPO_RANK por tipo de loc). **Marca task como NO-OP** com observação.
- [ ] Commit (vazio doc-only): pulará — sem mudança.

> **Note:** finding 6.12 originalmente apontava `equivalente/confirmar/route.ts` (que NÃO está no escopo P6 — está em P2 + delete). Como `vendas-disponibilidade.ts` já está clean, marca closed via verificação.

---

### B.4 — `vendas/criar` `cwb_atende`/`sp_atende` dinâmico [#P6-6.13, #P6-7.12]

Hoje (linhas 281-282): `cwb_atende: galpaoNome === "CWB", sp_atende: galpaoNome === "SP"` — falha pra qualquer galpão novo.

**DECISION REQUIRED:** as colunas `cwb_atende`/`sp_atende` em `siso_pedido_itens` são legacy. Duas opções:
1. **Manter (compatibilidade):** popular dinamicamente. Toda nova venda em galpão diferente de CWB/SP ficaria com ambos false.
2. **Deprecar:** marcar colunas como deprecated via comment; popular como NULL.

**RECOMMENDED:** opção 1 (compatibilidade) — `cwb_atende` e `sp_atende` ainda são lidos em algumas queries legadas (`pedidos/tracking`, painéis). Migrar pra "dinâmico-por-prefixo-do-nome" é mais seguro: popular conforme nome real do galpão.

#### Task B.4.1 — Write failing scenario `28-vendas-criar-galpao-arbitrario.ts`

- [ ] File: `scripts/wms/cenarios/catalogo/28-vendas-criar-galpao-arbitrario.ts`.
- [ ] Skeleton:
  ```ts
  import type { Cenario } from "../_harness/types";
  import { runStandalone } from "../_harness/standalone";
  import { assertEquals } from "../_harness/asserts";

  const cenario: Cenario = {
    nome: "28 — vendas/criar com galpão arbitrário popula cwb_atende/sp_atende corretamente",
    async setup(ctx) {
      const { staging } = ctx;
      // Cria galpão novo "PR" pra testar não-CWB/SP
      const { data: galPR } = await ctx.sb
        .from("siso_galpoes")
        .insert({ nome: "PR-TEST-28", descricao: "teste cenário 28", ativo: true })
        .select("id, nome")
        .single();
      // Vincula empresa origem
      await ctx.sb.from("siso_empresa_galpoes_preferenciais").insert({
        empresa_id: staging.empresaNetAirId,
        galpao_id: galPR.id,
      });
      // Cria loc picking + saldo no galpão novo
      const { data: locPR } = await ctx.sb
        .from("siso_localizacoes")
        .insert({
          galpao_id: galPR.id,
          codigo: "PR-A-01-01",
          tipo: "picking",
          ativo: true,
        })
        .select("id")
        .single();
      await ctx.http.post("/api/wms/ajuste", {
        tripla: {
          produto_id: staging.produtoAlphaId,
          galpao_id: galPR.id,
          localizacao_id: locPR.id,
        },
        qty: 5,
        direcao: "entrada",
        motivo: "seed cenário 28",
      });
      return { galpaoPRId: galPR.id };
    },
    async run(ctx, data) {
      const resp = await ctx.http.post("/api/wms/vendas/criar", {
        cliente_nome: "Teste 28",
        empresa_origem_id: ctx.staging.empresaNetAirId,
        galpao_id: data.galpaoPRId,
        modo: "baixa_direta",
        items: [{ produto_id: ctx.staging.produtoAlphaId, quantidade: 1 }],
      });
      assertEquals(resp.status, 200);
      const body = await resp.json();
      const { data: item } = await ctx.sb
        .from("siso_pedido_itens")
        .select("cwb_atende, sp_atende")
        .eq("pedido_id", body.pedido_id)
        .single();
      // Galpão="PR-TEST-28" → tanto cwb_atende quanto sp_atende devem ser false
      assertEquals(item?.cwb_atende, false, "cwb_atende deve ser false");
      assertEquals(item?.sp_atende, false, "sp_atende deve ser false");
    },
    async assertEsperado() {},
  };

  if (require.main === module) runStandalone(cenario);
  export default cenario;
  ```
- [ ] Run — confirma que comportamento atual já dá `false/false` (pois `galpaoNome === "CWB"` é false). **Caveat:** se já estiver passando, a finding 6.13 trata da SEMÂNTICA — campos não refletem nada útil. Refactor sugerido abaixo é converter pra populações genéricas.

#### Task B.4.2 — Refactor `vendas/criar/route.ts`

- [ ] File: `src/app/api/wms/vendas/criar/route.ts`.
- [ ] Edit linhas 281-282 — popular dinâmico:
  - Antes:
    ```ts
    cwb_atende: galpaoNome === "CWB",
    sp_atende: galpaoNome === "SP",
    ```
  - Depois:
    ```ts
    // Legacy compat: cwb_atende/sp_atende são mantidos pra queries legadas
    // de painéis. Popula com case-insensitive match no nome do galpão.
    // Pra galpões fora de {CWB, SP}, ambos ficam false (sinaliza "outro").
    cwb_atende: /^cwb\b/i.test(galpaoNome ?? ""),
    sp_atende: /^sp\b/i.test(galpaoNome ?? ""),
    ```
- [ ] Re-run scenario 28 — confirm passes.
- [ ] Commit: `fix(vendas/criar): cwb_atende/sp_atende via regex pra galpões fora do par CWB/SP [#P6-6.13 #P6-7.12]`.

---

### B.5 — Status 'aplicada' devoluções decisão [#P6-6.14]

CHECK constraint inclui status 'aplicada' mas nunca é atingido — após classificar, vai pra 'classificada' e fica lá. O fluxo de "aplicação" gera as movs no momento da classificação (não há etapa separada).

**DECISION REQUIRED:** duas opções:
1. **Drop 'aplicada' do CHECK:** elimina dead status.
2. **Implementar transição:** após classificar com sucesso, transita pra 'aplicada' (== "concluída"). Status 'classificada' vira intermediário (raro — só se mov inserir falhar mid-fluxo).

**RECOMMENDED:** opção 1 (drop). Mais simples, sem mudança de UX. `classificada` já significa "concluída" no fluxo atual.

#### Task B.5.1 — Migration drop 'aplicada' do CHECK

- [ ] File: `supabase/migrations/20260527_devolucoes_pendentes_status_aplicada.sql`.
- [ ] Content:
  ```sql
  -- Remove 'aplicada' do CHECK de siso_devolucoes_pendentes.status — nunca
  -- foi usado no fluxo. 'classificada' é o estado terminal pós-classificação.
  BEGIN;

  -- Sanity: garante que nenhuma linha tem status='aplicada' (caso edge)
  UPDATE siso_devolucoes_pendentes
     SET status = 'classificada'
   WHERE status = 'aplicada';

  -- Recria CHECK sem 'aplicada'
  ALTER TABLE siso_devolucoes_pendentes
    DROP CONSTRAINT IF EXISTS siso_devolucoes_pendentes_status_check;

  ALTER TABLE siso_devolucoes_pendentes
    ADD CONSTRAINT siso_devolucoes_pendentes_status_check
    CHECK (status IN ('aguardando_classificacao', 'classificada', 'cancelada'));

  COMMIT;

  -- DOWN:
  --   ALTER TABLE siso_devolucoes_pendentes DROP CONSTRAINT siso_devolucoes_pendentes_status_check;
  --   ALTER TABLE siso_devolucoes_pendentes ADD CONSTRAINT ... CHECK (status IN ('aguardando_classificacao', 'classificada', 'aplicada', 'cancelada'));
  ```
- [ ] Apply.
- [ ] Update `CLAUDE.md`: na tabela siso_devolucoes_pendentes, remover 'aplicada' da lista.
- [ ] Commit: `fix(supabase): drop status='aplicada' não-usado de siso_devolucoes_pendentes [#P6-6.14]`.

---

### B.6 — Classes A e D devoluções: origem_tipo distinto [#P6-6.15]

`classificacao='integro'` e `classificacao='troca_sku'` usam ambos `origem_tipo='devolucao_cliente_integra'` — apuração misturada. Adicionar valor enum dedicado.

**DECISION REQUIRED:** adicionar `'devolucao_cliente_troca_sku'` ao CHECK de `siso_movimentacoes.origem_tipo`?

**RECOMMENDED:** sim. Reports financeiros precisam separar (troca_sku é receita zero — troca de mercadoria).

#### Task B.6.1 — Migration adicionar origem_tipo `devolucao_cliente_troca_sku`

- [ ] File: `supabase/migrations/20260527_origem_tipo_devolucao_troca_sku.sql`.
- [ ] Content:
  ```sql
  BEGIN;

  -- Adiciona valor 'devolucao_cliente_troca_sku' ao CHECK de origem_tipo
  -- (mantém 'devolucao_cliente_integra' pra Classe A pura).
  ALTER TABLE siso_movimentacoes
    DROP CONSTRAINT IF EXISTS siso_movimentacoes_origem_tipo_check;

  ALTER TABLE siso_movimentacoes
    ADD CONSTRAINT siso_movimentacoes_origem_tipo_check
    CHECK (origem_tipo IN (
      'nf_compra',
      'devolucao_cliente_integra',
      'devolucao_cliente_avariada',
      'devolucao_cliente_troca_sku',  -- NOVO
      'devolucao_fornecedor_recebida',
      'devolucao_fornecedor_enviada',
      'nf_venda',
      'venda_manual',
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

  COMMIT;

  -- DOWN: restaura CHECK sem o valor novo.
  ```
- [ ] Apply migration.

#### Task B.6.2 — Edit `devolucoes.ts` case `troca_sku`

- [ ] File: `src/lib/wms/devolucoes.ts` linha ~226.
- [ ] Troca `origem_tipo: "devolucao_cliente_integra"` por `origem_tipo: "devolucao_cliente_troca_sku"` no case `'troca_sku'`:
  ```ts
  case "troca_sku":
    // Classe D — apenas entra. Troca de SKU vira fluxo separado em
    // separacao (já existe compras-equivalencia). Aqui só reintegra.
    // origem_tipo dedicado pra apurar troca separada de devolução íntegra.
    await inserirMovimentacao({
      tripla,
      tipo: "E",
      qty: input.qty,
      origem_tipo: "devolucao_cliente_troca_sku",
      nota_fiscal_id: d.nota_fiscal_id?.toString() ?? undefined,
      empresa_referencia_id: empresaReferenciaId,
      usuario_id: input.usuario_id,
      motivo: `troca SKU: ${input.observacoes ?? ""}`,
    });
    break;
  ```

#### Task B.6.3 — Update `inserirMovimentacao` allowlist (se houver)

- [ ] Search: `grep -n "devolucao_cliente_integra" /Users/eryk/Documents/ESTOQUE/src/lib/wms/ledger.ts`.
- [ ] Se houver enum/array TS de origem_tipo, adicionar `'devolucao_cliente_troca_sku'`.
- [ ] Update `src/types/index.ts` (se houver type enum local).

#### Task B.6.4 — Scenario para nova classificação

- [ ] File: `scripts/wms/cenarios/catalogo/29-devolucao-troca-sku-origem-distinto.ts`.
- [ ] Skeleton:
  ```ts
  import type { Cenario } from "../_harness/types";
  import { runStandalone } from "../_harness/standalone";
  import { assertEquals } from "../_harness/asserts";

  const cenario: Cenario = {
    nome: "29 — devolucao troca_sku usa origem_tipo distinto",
    async setup(ctx) {
      const { staging } = ctx;
      // Cria devolução pendente com classificacao=troca_sku
      const { data: dev } = await ctx.sb
        .from("siso_devolucoes_pendentes")
        .insert({
          nota_fiscal_id: 9999991,
          empresa_id: staging.empresaNetAirId,
          payload_webhook: { stub: true },
        })
        .select("id")
        .single();
      return { devId: dev.id };
    },
    async run(ctx, data) {
      const resp = await ctx.http.post(
        `/api/wms/devolucoes/${data.devId}/classificar`,
        {
          classificacao: "troca_sku",
          galpao_id: ctx.staging.galpaoCwbId,
          localizacao_id: ctx.staging.locCwbPickingId,
          produto_id: ctx.staging.produtoAlphaId,
          qty: 1,
        },
      );
      assertEquals(resp.status, 200);
    },
    async assertEsperado(ctx, data) {
      const { data: movs } = await ctx.sb
        .from("siso_movimentacoes")
        .select("origem_tipo")
        .eq("produto_id", ctx.staging.produtoAlphaId)
        .order("criado_em", { ascending: false })
        .limit(5);
      const found = (movs as Array<{ origem_tipo: string }>).some(
        (m) => m.origem_tipo === "devolucao_cliente_troca_sku",
      );
      if (!found) throw new Error("mov com origem_tipo=devolucao_cliente_troca_sku ausente");
    },
  };

  if (require.main === module) runStandalone(cenario);
  export default cenario;
  ```
- [ ] Run, confirm fails (origem_tipo ainda é `devolucao_cliente_integra`).
- [ ] Após edit B.6.2 — re-run, passes.
- [ ] Commit: `feat(wms/devolucoes): origem_tipo dedicado pra troca_sku [#P6-6.15]`.

---

### B.7 — Verificar consumidores deprecated `siso_empresas.galpao_id` adicionais [#P6-6.9]

Inventário de consumers (já mapeado na investigação inicial):

- ✅ `src/app/api/wms/admin/galpoes/route.ts` — admin UI, OK ler pra mostrar hierarquia.
- ✅ `src/app/api/wms/admin/empresas/*.ts` — admin UI, OK.
- ✅ `src/app/api/wms/configuracoes/aba-*.ts` — UI, OK.
- ❌ `src/lib/compras-release.ts` — runtime crítico, **resolvido em A.4**.
- ❌ `src/lib/empresa-lookup.ts` — runtime: usa via `siso_galpoes!siso_empresas_galpao_id_fkey!inner` em SELECT pra mostrar nome do galpão preferencial em logs. Aceitável (read-only doc), mas marca pra cleanup futuro.
- ❌ `src/lib/grupo-resolver.ts` — runtime: similar a empresa-lookup. Aceitável.
- ❌ `src/app/api/wms/pedidos/[id]/detalhe/route.ts` linha 72 — **DECIDE**.
- ❌ `src/app/api/wms/pedidos/tracking/route.ts` linha 180 — read-only display.
- ❌ `src/app/api/wms/separacao/encaminhar/route.ts` linha 280 — runtime, lê pra decidir loc destino.
- ❌ `src/app/api/wms/separacao/produto-esgotado/route.ts` linha 130 — runtime.
- ❌ `src/app/api/wms/separacao/checklist-items/route.ts` linha 187 — runtime.
- ❌ `src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts` linhas 80, 99 — em P2 escopo (delete/refactor); coordenar.
- ❌ `src/lib/wms/sugestao-dinamica.ts` linha 99 — RPC consumer, runtime decisão.
- ❌ `src/lib/wms/snapshot-inicial.ts` linha 46 — one-shot admin, OK.
- ❌ `src/app/api/wms/tiny/stock/ajustar/route.ts` linha 68 — runtime, decide deposito Tiny.

#### Task B.7.1 — Document remaining consumers + decision matrix

- [ ] Update `docs/superpowers/plans/2026-05-26-wms-fix-p6-estado-fantasma-cleanups.md` (este arquivo) na seção F com a matriz.
- [ ] Create file `docs/wms-deprecated-galpao-id-consumers.md`:
  ```md
  # Consumers de siso_empresas.galpao_id deprecated

  Last audit: 2026-05-27 (P6 fix).

  ## Categorias

  ### A — OK (admin UI, ler espelho preferencial)
  - admin/galpoes — hierarquia
  - admin/empresas — display
  - configuracoes/aba-*

  ### B — Runtime read-only (display em logs/UI)
  - empresa-lookup
  - grupo-resolver
  - pedidos/tracking, pedidos/[id]/detalhe
  - tiny/connections

  ### C — Runtime crítico — MIGRAR
  - [FIXED P6.A.4] compras-release → separacao_galpao_id
  - [P2 ESCOPO] compras/itens/[id]/equivalente/confirmar → galpaoOrigemId
  - [TODO POST-P6] separacao/encaminhar → usar separacao_galpao_id
  - [TODO POST-P6] separacao/produto-esgotado → idem
  - [TODO POST-P6] separacao/checklist-items → idem
  - [TODO POST-P6] tiny/stock/ajustar → preferencial via N:N
  - [TODO POST-P6] sugestao-dinamica → preferencial via N:N
  ```
- [ ] Commit: `docs(wms): mapa de consumers de siso_empresas.galpao_id deprecated [#P6-6.9]`.

---

## C. Audit Trail

### C.1 — Adicionar `registrarEventos` a 7 endpoints de Compras [#P6-3.5, #P6-6.17]

Para cada endpoint: ler estado pré-mudança, executar lógica existente, ao final invocar `registrarEvento` com evento descritivo + detalhes JSON.

#### Task C.1.1 — Adicionar eventos novos em `historico-service.ts`

- [ ] File: `src/lib/historico-service.ts`.
- [ ] Adiciona ao `EventoPedido` union:
  ```ts
  | "compra_item_comprado"
  | "compra_item_recebido"
  | "compra_item_indisponivel"
  | "compra_item_devolvido"
  | "compra_item_cancelado"
  | "compra_item_equivalente_aplicado"
  | "compra_sku_trocado"
  | "compra_pedido_cancelado"
  | "guarda_pendencia_criada"
  | "guarda_pendencia_confirmada"
  | "guarda_pendencia_cancelada"
  | "inventario_patch_aplicado";
  ```
- [ ] Commit (bundle com C.1.2 abaixo): pulará — combina commit.

#### Task C.1.2 — `compras/comprar` registra `compra_item_comprado` [#P6-6.17 (1/7)]

- [ ] File: `src/app/api/wms/compras/comprar/route.ts`.
- [ ] Leitura inicial: 
  ```bash
  wc -l /Users/eryk/Documents/ESTOQUE/src/app/api/wms/compras/comprar/route.ts
  ```
- [ ] Identifica final do handler (após `return NextResponse.json({...})` de sucesso).
- [ ] Antes do `return`, adicionar:
  ```ts
  import { registrarEventos } from "@/lib/historico-service";
  ```
  (no topo, se não houver).
- [ ] Após a distribuição cross-pedidos ser computada (variável `itensAtualizados` ou equivalente — verificar nome real), antes do `return`:
  ```ts
  // Audit trail: agrupa eventos por pedido_id (1 evento por pedido afetado)
  const eventosPorPedido = new Map<string, { qty: number; skus: string[] }>();
  for (const item of itensAtualizados) {
    const cur = eventosPorPedido.get(item.pedido_id) ?? { qty: 0, skus: [] };
    cur.qty += Number(item.quantidade_comprada);
    cur.skus.push(item.sku);
    eventosPorPedido.set(item.pedido_id, cur);
  }
  await registrarEventos(
    Array.from(eventosPorPedido.entries()).map(([pedidoId, info]) => ({
      pedidoId,
      evento: "compra_item_comprado" as const,
      usuarioId: user.id,
      usuarioNome: user.nome,
      detalhes: {
        qty_total: info.qty,
        skus: info.skus,
        fornecedor: body.fornecedor ?? null,
      },
    })),
  );
  ```
  > **NOTA:** se nome de variável não bater, ajuste sem mudar semântica.

#### Task C.1.3 — Write failing scenario `30-audit-compras-comprar.ts`

- [ ] File: `scripts/wms/cenarios/catalogo/30-audit-compras-comprar.ts`.
- [ ] Skeleton (adapta de cenario 03 OC):
  ```ts
  import type { Cenario } from "../_harness/types";
  import { runStandalone } from "../_harness/standalone";
  import { assertEquals } from "../_harness/asserts";

  const cenario: Cenario = {
    nome: "30 — compras/comprar registra evento compra_item_comprado em pedido_historico",
    async setup(ctx) {
      // Cria pedido OC (sem saldo) → vai pra compras "a comprar"
      const webhookResp = await ctx.http.post("/api/wms/webhook/tiny", {
        type: "pedido",
        empresa_cnpj: "34857388000163",
        pedido_numero: "PEDIDO-AUDIT-30",
        items: [{ sku: ctx.staging.skuAlphaSemEstoque, qty: 3 }],
      });
      assertEquals(webhookResp.status, 200);
      await ctx.sleep(2000);
      const { data: pedido } = await ctx.sb
        .from("siso_pedidos")
        .select("id")
        .eq("numero", "PEDIDO-AUDIT-30")
        .single();
      return { pedido_id: pedido.id };
    },
    async run(ctx) {
      const resp = await ctx.http.post("/api/wms/compras/comprar", {
        sku: ctx.staging.skuAlphaSemEstoque,
        quantidade: 3,
        fornecedor: "TestFornecedor",
      });
      assertEquals(resp.status, 200);
    },
    async assertEsperado(ctx, data) {
      const { data: events } = await ctx.sb
        .from("siso_pedido_historico")
        .select("evento, detalhes")
        .eq("pedido_id", data.pedido_id)
        .eq("evento", "compra_item_comprado");
      if (!events || events.length === 0)
        throw new Error("evento compra_item_comprado ausente em pedido_historico");
      const ev = events[0];
      if (!ev.detalhes?.skus?.includes(ctx.staging.skuAlphaSemEstoque))
        throw new Error("detalhes.skus ausente ou faltando sku");
    },
  };

  if (require.main === module) runStandalone(cenario);
  export default cenario;
  ```
- [ ] Run, confirm fails (nenhum evento gravado).
- [ ] Após edits, re-run — confirm passes.
- [ ] Commit: `feat(compras/comprar): registra evento compra_item_comprado em pedido_historico [#P6-3.5 #P6-6.17]`.

#### Task C.1.4 — `compras/receber` registra `compra_item_recebido` [#P6-6.17 (2/7)]

- [ ] File: `src/app/api/wms/compras/receber/route.ts`.
- [ ] Mesma estrutura — após processar recebimento, agregar por `pedido_id`:
  ```ts
  import { registrarEventos } from "@/lib/historico-service";
  // ...
  const eventosPorPedido = new Map<string, { qty: number; skus: string[]; fornecedor: string | null }>();
  for (const item of itensRecebidos) {
    const cur = eventosPorPedido.get(item.pedido_id) ?? { qty: 0, skus: [], fornecedor: null };
    cur.qty += Number(item.quantidade_recebida ?? item.quantidade);
    cur.skus.push(item.sku);
    cur.fornecedor = item.fornecedor ?? cur.fornecedor;
    eventosPorPedido.set(item.pedido_id, cur);
  }
  await registrarEventos(
    Array.from(eventosPorPedido.entries()).map(([pedidoId, info]) => ({
      pedidoId,
      evento: "compra_item_recebido" as const,
      usuarioId: user.id,
      usuarioNome: user.nome,
      detalhes: { qty_total: info.qty, skus: info.skus, fornecedor: info.fornecedor },
    })),
  );
  ```
- [ ] Scenario cenário 31 análogo (adapta 30).
- [ ] Commit: `feat(compras/receber): registra evento compra_item_recebido [#P6-6.17]`.

#### Task C.1.5 — `compras/itens/[id]/indisponivel` registra `compra_item_indisponivel` [#P6-6.17 (3/7)]

- [ ] File: `src/app/api/wms/compras/itens/[itemId]/indisponivel/route.ts`.
- [ ] No final do handler:
  ```ts
  import { registrarEvento } from "@/lib/historico-service";
  // ...
  await registrarEvento({
    pedidoId: itemRow.pedido_id,
    evento: "compra_item_indisponivel",
    usuarioId: user.id,
    usuarioNome: user.nome,
    detalhes: {
      item_id: itemId,
      sku: itemRow.sku,
      motivo: body.motivo ?? null,
    },
  });
  ```
- [ ] Scenario 32 análogo.
- [ ] Commit: `feat(compras/indisponivel): registra evento [#P6-6.17]`.

#### Task C.1.6 — `compras/itens/[id]/devolver` registra `compra_item_devolvido` [#P6-6.17 (4/7)]

- [ ] File: `src/app/api/wms/compras/itens/[itemId]/devolver/route.ts`.
- [ ] Mesma estrutura:
  ```ts
  await registrarEvento({
    pedidoId: itemRow.pedido_id,
    evento: "compra_item_devolvido",
    usuarioId: user.id,
    usuarioNome: user.nome,
    detalhes: { item_id: itemId, sku: itemRow.sku, qty: body.qty ?? null, motivo: body.motivo ?? null },
  });
  ```
- [ ] Scenario 33.
- [ ] Commit: `feat(compras/devolver): registra evento [#P6-6.17]`.

#### Task C.1.7 — `compras/itens/[id]/cancelamento/confirmar` registra `compra_item_cancelado` [#P6-6.17 (5/7)]

- [ ] File: `src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts`.
- [ ] Mesma estrutura.
- [ ] Scenario 34.
- [ ] Commit: `feat(compras/cancelamento): registra evento [#P6-6.17]`.

#### Task C.1.8 — `compras/itens/[id]/equivalente/confirmar` registra `compra_item_equivalente_aplicado` [#P6-6.17 (6/7)]

- [ ] File: `src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts`.
- [ ] Adicionar registro:
  ```ts
  await registrarEvento({
    pedidoId: itemRow.pedido_id,
    evento: "compra_item_equivalente_aplicado",
    usuarioId: user.id,
    usuarioNome: user.nome,
    detalhes: {
      item_id: itemId,
      sku_original: itemRow.sku,
      sku_equivalente: body.sku_equivalente ?? body.novo_sku,
      qty: body.qty ?? null,
    },
  });
  ```
- [ ] Scenario 35.
- [ ] Commit: `feat(compras/equivalente): registra evento [#P6-6.17]`.

> **Coordinate with P2:** P2 já reescreve parte deste endpoint (equivalente após R órfã). Cuidado pra não conflitar — coordene merge depois de P2.

#### Task C.1.9 — `compras/trocar-sku` registra `compra_sku_trocado` [#P6-6.17 (7/7)]

- [ ] File: `src/app/api/wms/compras/trocar-sku/route.ts`.
- [ ] Mesma estrutura.
- [ ] Scenario 36.
- [ ] Commit: `feat(compras/trocar-sku): registra evento [#P6-6.17]`.

#### Task C.1.10 — `compras/pedidos/[id]/cancelar` registra `compra_pedido_cancelado`

- [ ] File: `src/app/api/wms/compras/pedidos/[pedidoId]/cancelar/route.ts`.
- [ ] No fim:
  ```ts
  await registrarEvento({
    pedidoId: pedidoId,
    evento: "compra_pedido_cancelado",
    usuarioId: user.id,
    usuarioNome: user.nome,
    detalhes: { motivo: body.motivo ?? null },
  });
  ```
- [ ] Scenario 37.
- [ ] Commit: `feat(compras/cancelar): registra evento [#P6-3.5]`.

> **Coordinate with P2:** P2 também modifica este endpoint pra estornar movs de recebimento. Coordine merge.

---

### C.2 — `criarPendencia` carrega `criada_por` + nova coluna [#P6-5.9, #P6-6.18]

#### Task C.2.1 — Migration `pendencias_guarda_criada_por_guardada_por`

- [ ] File: `supabase/migrations/20260527_pendencias_guarda_criada_por_guardada_por.sql`.
- [ ] Content:
  ```sql
  BEGIN;

  ALTER TABLE siso_wms_pendencias_guarda
    ADD COLUMN IF NOT EXISTS criada_por uuid REFERENCES siso_usuarios(id),
    ADD COLUMN IF NOT EXISTS guardada_por uuid REFERENCES siso_usuarios(id);

  CREATE INDEX IF NOT EXISTS idx_pend_guarda_criada_por
    ON siso_wms_pendencias_guarda(criada_por);

  -- Backfill criada_por via mov de entrada (usuario_id da mov original)
  UPDATE siso_wms_pendencias_guarda p
     SET criada_por = m.usuario_id
    FROM siso_movimentacoes m
   WHERE p.criada_por IS NULL
     AND p.mov_entrada_id = m.id
     AND m.usuario_id IS NOT NULL;

  -- Backfill guardada_por via iniciada_por (proxy: quem iniciou costuma ser quem guardou)
  UPDATE siso_wms_pendencias_guarda
     SET guardada_por = iniciada_por
   WHERE guardada_por IS NULL
     AND status = 'guardada'
     AND iniciada_por IS NOT NULL;

  COMMIT;

  -- DOWN:
  --   ALTER TABLE siso_wms_pendencias_guarda DROP COLUMN criada_por, DROP COLUMN guardada_por;
  ```
- [ ] Apply migration.

#### Task C.2.2 — Edit `guarda.ts` `criarPendencia` aceita `criada_por`

- [ ] File: `src/lib/wms/guarda.ts`.
- [ ] Adiciona em `CriarPendenciaInput` (linha 101):
  ```ts
  /** Usuario que registrou o recebimento (cria pendência). Obrigatório pra audit. */
  criada_por: string;
  ```
- [ ] No insert (linha 139-154), adicionar:
  ```ts
  criada_por: input.criada_por,
  ```
- [ ] Adiciona em `ConfirmarGuardaInput` (linha 329) — `usuario_id` já existe; usa o mesmo no update.
- [ ] No `confirmarGuarda` (linha 414, dentro do bloco `if (totalmenteGuardada)`), adicionar:
  ```ts
  update.guardada_por = input.usuario_id;
  ```

#### Task C.2.3 — Edit callers de `criarPendencia`

- [ ] Search:
  ```bash
  grep -rn "criarPendencia\b" /Users/eryk/Documents/ESTOQUE/src --include="*.ts"
  ```
- [ ] Para cada caller (provável: `src/app/api/wms/receber/route.ts` + algum em `lib/wms/movimentacoes.ts`), passar `criada_por: user.id` (ou seu equivalente).
- [ ] Se um caller é um helper interno sem contexto de user (raro), passar `criada_por: usuario_id` do parâmetro.

#### Task C.2.4 — Failing scenario `38-criada-por-guarda.ts`

- [ ] File: `scripts/wms/cenarios/catalogo/38-criada-por-guarda.ts`.
- [ ] Skeleton:
  ```ts
  import type { Cenario } from "../_harness/types";
  import { runStandalone } from "../_harness/standalone";
  import { assertEquals } from "../_harness/asserts";

  const cenario: Cenario = {
    nome: "38 — pendência guarda carrega criada_por e guardada_por",
    async setup() { return {}; },
    async run(ctx) {
      const resp = await ctx.http.post("/api/wms/receber", {
        galpao_id: ctx.staging.galpaoCwbId,
        itens: [{
          produto_id: ctx.staging.produtoAlphaId,
          qty: 2,
          custo_unitario: 5,
          origem_tipo: "nf_compra",
        }],
      });
      const body = await resp.json();
      const pendId = body.pendencias[0].id;
      // Verifica criada_por após criar
      const { data: p1 } = await ctx.sb
        .from("siso_wms_pendencias_guarda")
        .select("criada_por, guardada_por")
        .eq("id", pendId)
        .single();
      if (!p1?.criada_por) throw new Error("criada_por deveria estar populado");
      if (p1.guardada_por) throw new Error("guardada_por deveria ser null ainda");
      // Confirma guarda
      const confResp = await ctx.http.post(`/api/wms/guarda/${pendId}/confirmar`, {
        qty: 2,
        localizacao_destino_id: ctx.staging.locCwbPickingId,
      });
      assertEquals(confResp.status, 200);
      const { data: p2 } = await ctx.sb
        .from("siso_wms_pendencias_guarda")
        .select("guardada_por")
        .eq("id", pendId)
        .single();
      if (!p2?.guardada_por)
        throw new Error("guardada_por deveria estar populado após confirmar");
    },
    async assertEsperado() {},
  };

  if (require.main === module) runStandalone(cenario);
  export default cenario;
  ```
- [ ] Run — confirma fails (criada_por/guardada_por null).
- [ ] Após edits, re-run — passes.
- [ ] Update CLAUDE.md schema reference de `siso_wms_pendencias_guarda` pra incluir `criada_por`+`guardada_por`.
- [ ] Commit: `feat(wms/guarda): criada_por + guardada_por com backfill [#P6-5.9 #P6-5.10 #P6-6.18]`.

---

### C.3 — PATCH inventário loga diff [#P6-6.20, #P6-4.15]

`pickPatchFields` aceita PATCH em sessão (tolerancia, modo, etc) sem logar o que mudou.

#### Task C.3.1 — Edit `lib/wms/inventario.ts` — PATCH sessão grava evento

- [ ] File: `src/lib/wms/inventario.ts`.
- [ ] Localiza função `atualizarSessao(...)` (deve estar próxima a `pickPatchFields`).
- [ ] Antes do `UPDATE`, captura `before`:
  ```ts
  const { data: before } = await sb
    .from("siso_inventario_sessoes")
    .select("modo, tolerancia_pct, tamanho_pool, exige_aprovacao_acima_valor")
    .eq("id", sessaoId)
    .single();
  ```
- [ ] Após UPDATE, computa diff e loga:
  ```ts
  if (before) {
    const diff: Record<string, [unknown, unknown]> = {};
    for (const k of ["modo", "tolerancia_pct", "tamanho_pool", "exige_aprovacao_acima_valor"]) {
      const b = (before as Record<string, unknown>)[k];
      const a = patchData[k];
      if (a !== undefined && a !== b) diff[k] = [b, a];
    }
    if (Object.keys(diff).length > 0) {
      logger.info("wms.inventario.patch", "sessão atualizada", {
        sessao_id: sessaoId,
        diff,
        usuario_id: usuario_id,
      });
    }
  }
  ```
- [ ] Bonus: gravar em `siso_logs` com source `wms.inventario.patch` é suficiente — inventário não tem `siso_pedido_historico` equivalente. (Inventário **não** tem pedido_id; lateral table seria overengineering.)
- [ ] Commit: `feat(wms/inventario): PATCH sessão loga diff dos campos alterados [#P6-6.20 #P6-4.15]`.

> **Coordinate with P3:** P3 também adiciona idempotência ao mesmo arquivo. Edits são em funções DIFERENTES (`atualizarSessao` vs `aplicarSessao`). Sem conflito.

---

### C.4 — Truncate `siso_pedido_historico.detalhes` JSONB > 64KB [#P6-6.21]

#### Task C.4.1 — Edit `historico-service.ts` truncate guard

- [ ] File: `src/lib/historico-service.ts`.
- [ ] Adiciona helper:
  ```ts
  const MAX_DETALHES_BYTES = 64 * 1024; // 64KB hard limit

  function truncateDetalhes(detalhes: Record<string, unknown>): Record<string, unknown> {
    const json = JSON.stringify(detalhes);
    if (json.length <= MAX_DETALHES_BYTES) return detalhes;
    return {
      ...detalhes,
      _truncated: true,
      _original_size_bytes: json.length,
      _max_size_bytes: MAX_DETALHES_BYTES,
      _note: "campos pesados removidos — verificar siso_logs por correlation_id",
    };
  }
  ```
- [ ] Em ambas `registrarEvento` e `registrarEventos`, aplica:
  - `registrarEvento`: substitui `detalhes: params.detalhes ?? {}` por `detalhes: truncateDetalhes(params.detalhes ?? {})`.
  - `registrarEventos`: na map, substitui `detalhes: e.detalhes ?? {}` por `detalhes: truncateDetalhes(e.detalhes ?? {})`.
- [ ] **Strategy:** se truncado, o full payload deve ir pra `siso_logs` via `logger.warn`. Adiciona:
  ```ts
  if (json.length > MAX_DETALHES_BYTES) {
    logger.warn("historico.truncate", "detalhes excedeu 64KB — truncated", {
      pedidoId: params.pedidoId,
      evento: params.evento,
      original_size_bytes: json.length,
    });
  }
  ```
- [ ] Unit test em `src/lib/historico-service.test.ts` (criar se não existir):
  ```ts
  import { describe, it, expect } from "vitest";
  // ... mock supabase + assert detalhes vira com _truncated:true quando > 64KB.
  ```
- [ ] Commit: `feat(historico): truncate detalhes > 64KB com marker [#P6-6.21]`.

---

## D. Categoria Estruturada + Deadcode

### D.1 — Ajuste manual `motivo_categoria` enum [#P6-6.24, #P6-6.25, #P6-8.14]

#### Task D.1.1 — Migration cria enum + coluna em movs

- [ ] File: `supabase/migrations/20260527_ajuste_manual_motivo_categoria.sql`.
- [ ] Content:
  ```sql
  BEGIN;

  -- Cria type enum (postgres CREATE TYPE pra reusabilidade futura)
  DO $$ BEGIN
    CREATE TYPE wms_motivo_categoria_enum AS ENUM (
      'avaria',
      'perda',
      'achado',
      'correcao_inventario',
      'devolucao_sem_fluxo',
      'outro'
    );
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END $$;

  -- Adiciona coluna nullable em movs (só obrigatório quando origem_tipo='ajuste_manual')
  ALTER TABLE siso_movimentacoes
    ADD COLUMN IF NOT EXISTS motivo_categoria wms_motivo_categoria_enum;

  -- CHECK: se origem_tipo='ajuste_manual', motivo_categoria deve estar setado
  -- (em rows futuras; rows antigas ficam NULL → soft enforce via aplicação).
  -- Não força via CHECK constraint pra não quebrar backfill.

  -- Index pra apuração (saídas por categoria)
  CREATE INDEX IF NOT EXISTS idx_movs_motivo_categoria
    ON siso_movimentacoes(motivo_categoria, origem_tipo)
    WHERE motivo_categoria IS NOT NULL;

  COMMIT;

  -- DOWN:
  --   ALTER TABLE siso_movimentacoes DROP COLUMN motivo_categoria;
  --   DROP TYPE wms_motivo_categoria_enum;
  ```
- [ ] Apply.

#### Task D.1.2 — Update RPC `wms_inserir_movimentacao` aceita `p_motivo_categoria`

- [ ] File: `supabase/migrations/20260527_wms_inserir_mov_motivo_categoria.sql`.
- [ ] Content (DROP+CREATE — assinatura nova):
  ```sql
  BEGIN;

  -- Adiciona parâmetro p_motivo_categoria (TEXT, nullable) na função.
  -- Reaproveita lógica de 20260526_custo_medio_ajuste_manual.sql — sem alterar
  -- body cálculos custo/saldo, só adiciona o parâmetro e o grava na linha de mov.

  -- 1. Identifica a assinatura atual (ver 20260520b_rpc_inserir_movimentacao + 20260526_custo_medio_ajuste_manual).
  -- 2. Recria com p_motivo_categoria adicionado (último argumento DEFAULT NULL pra compat).

  CREATE OR REPLACE FUNCTION wms_inserir_movimentacao(
    p_tripla jsonb,
    p_tipo text,
    p_qty numeric,
    p_origem_tipo text,
    p_origem_id text DEFAULT NULL,
    p_origem_detalhes jsonb DEFAULT '{}',
    p_usuario_id uuid DEFAULT NULL,
    p_motivo text DEFAULT NULL,
    p_nota_fiscal_id text DEFAULT NULL,
    p_chave_acesso_nf text DEFAULT NULL,
    p_pedido_id text DEFAULT NULL,
    p_empresa_compradora_id uuid DEFAULT NULL,
    p_empresa_vendedora_id uuid DEFAULT NULL,
    p_empresa_referencia_id uuid DEFAULT NULL,
    p_fornecedor_id uuid DEFAULT NULL,
    p_custo_unitario numeric DEFAULT NULL,
    p_cliente_nome text DEFAULT NULL,
    p_estorno_de uuid DEFAULT NULL,
    p_expira_em timestamptz DEFAULT NULL,
    p_reservado_delta numeric DEFAULT NULL,
    p_motivo_categoria text DEFAULT NULL  -- NOVO
  )
  RETURNS uuid
  LANGUAGE plpgsql
  AS $function$
  DECLARE
    -- ... preserva body original (ver 20260526_custo_medio_ajuste_manual.sql).
    -- Single diff: ao INSERT em siso_movimentacoes, inclui motivo_categoria:
    -- INSERT INTO siso_movimentacoes (..., motivo_categoria) VALUES (..., p_motivo_categoria::wms_motivo_categoria_enum);
  BEGIN
    -- IMPLEMENTAÇÃO COMPLETA EXIGE COPIAR O CORPO DE 20260526_custo_medio_ajuste_manual.sql
    -- E INSERIR `p_motivo_categoria::wms_motivo_categoria_enum` NO INSERT FINAL.
    RAISE EXCEPTION 'STUB — copy from 20260526_custo_medio_ajuste_manual.sql and add motivo_categoria';
  END;
  $function$;

  COMMIT;
  ```
- [ ] **IMPORTANT:** este task exige copiar o corpo completo da RPC atual de `20260526_custo_medio_ajuste_manual.sql` (linhas ~29-130) e adicionar `p_motivo_categoria` ao INSERT. Ler primeiro:
  ```bash
  cat /Users/eryk/Documents/ESTOQUE/supabase/migrations/20260526_custo_medio_ajuste_manual.sql
  ```
  Depois, na nova migration, copia o body do `wms_inserir_movimentacao` existente + insere `motivo_categoria` na cláusula INSERT.
- [ ] Apply migration.

#### Task D.1.3 — Edit TS `inserirMovimentacao` aceita campo

- [ ] File: `src/lib/wms/ledger.ts`.
- [ ] Adiciona em `InserirMovimentacaoInput`:
  ```ts
  /** Categoria estruturada do motivo (obrigatório quando origem_tipo='ajuste_manual'). */
  motivo_categoria?: "avaria" | "perda" | "achado" | "correcao_inventario" | "devolucao_sem_fluxo" | "outro";
  ```
- [ ] No call do RPC, passa:
  ```ts
  p_motivo_categoria: input.motivo_categoria ?? null,
  ```
- [ ] Update types em `src/types/index.ts` se houver type de `Movimentacao` que exponha.

#### Task D.1.4 — Edit `ajuste/route.ts` valida + passa categoria

- [ ] File: `src/app/api/wms/ajuste/route.ts`.
- [ ] Substitui (linhas 50-56):
  ```ts
  const motivo = typeof body.motivo === "string" ? body.motivo.trim() : "";
  if (motivo.length < 3) {
    return NextResponse.json(
      { error: "motivo é obrigatório (≥3 caracteres)" },
      { status: 400 },
    );
  }
  ```
  por:
  ```ts
  const motivo = typeof body.motivo === "string" ? body.motivo.trim() : "";
  if (motivo.length < 3) {
    return NextResponse.json(
      { error: "motivo é obrigatório (≥3 caracteres)" },
      { status: 400 },
    );
  }
  const motivoCategoria = body.motivo_categoria;
  const CATEGORIAS_VALIDAS = [
    "avaria",
    "perda",
    "achado",
    "correcao_inventario",
    "devolucao_sem_fluxo",
    "outro",
  ] as const;
  if (!motivoCategoria || !CATEGORIAS_VALIDAS.includes(motivoCategoria)) {
    return NextResponse.json(
      {
        error: `motivo_categoria é obrigatório e deve ser uma de: ${CATEGORIAS_VALIDAS.join(", ")}`,
      },
      { status: 400 },
    );
  }
  ```
- [ ] No call:
  ```ts
  await ajustarEstoque({
    tripla,
    qty,
    motivo,
    motivo_categoria: motivoCategoria,
    direcao: body.direcao,
    usuario_id: auth.user.id,
  });
  ```
- [ ] Edit `lib/wms/movimentacoes.ts` `ajustarEstoque` pra aceitar + repassar `motivo_categoria`.

#### Task D.1.5 — Failing scenario `39-ajuste-motivo-categoria.ts`

- [ ] File: `scripts/wms/cenarios/catalogo/39-ajuste-motivo-categoria.ts`.
- [ ] Skeleton:
  ```ts
  import type { Cenario } from "../_harness/types";
  import { runStandalone } from "../_harness/standalone";
  import { assertEquals } from "../_harness/asserts";

  const cenario: Cenario = {
    nome: "39 — ajuste manual exige motivo_categoria e grava na mov",
    async setup() { return {}; },
    async run(ctx) {
      // Sem motivo_categoria → erro 400
      const resp1 = await ctx.http.post("/api/wms/ajuste", {
        tripla: {
          produto_id: ctx.staging.produtoAlphaId,
          galpao_id: ctx.staging.galpaoCwbId,
          localizacao_id: ctx.staging.locCwbPickingId,
        },
        qty: 1,
        direcao: "saida",
        motivo: "teste cenário 39",
      });
      assertEquals(resp1.status, 400, "deve falhar sem motivo_categoria");
      // Com categoria válida → OK
      const resp2 = await ctx.http.post("/api/wms/ajuste", {
        tripla: {
          produto_id: ctx.staging.produtoAlphaId,
          galpao_id: ctx.staging.galpaoCwbId,
          localizacao_id: ctx.staging.locCwbPickingId,
        },
        qty: 1,
        direcao: "saida",
        motivo: "perda física",
        motivo_categoria: "perda",
      });
      assertEquals(resp2.status, 200, "deve aceitar categoria válida");
    },
    async assertEsperado(ctx) {
      const { data: movs } = await ctx.sb
        .from("siso_movimentacoes")
        .select("motivo_categoria, origem_tipo")
        .eq("origem_tipo", "ajuste_manual")
        .order("criado_em", { ascending: false })
        .limit(1);
      if (!movs || movs[0]?.motivo_categoria !== "perda")
        throw new Error(`motivo_categoria=${movs?.[0]?.motivo_categoria}, esperado 'perda'`);
    },
  };

  if (require.main === module) runStandalone(cenario);
  export default cenario;
  ```
- [ ] Run — confirma fails antes do edit; passes depois.
- [ ] Commit: `feat(wms/ajuste): motivo_categoria estruturado [#P6-6.24 #P6-6.25 #P6-8.14]`.

#### Task D.1.6 — UI ajuste — select de categoria

- [ ] File: `src/app/wms/ajuste/page.tsx`.
- [ ] Adicionar `<select>` com 6 valores (avaria, perda, achado, correcao_inventario, devolucao_sem_fluxo, outro).
- [ ] Form state: campo `motivoCategoria` controlado (default `"outro"` ou `null`).
- [ ] Validation client-side: bloquear submit se vazio.
- [ ] Submit envia `motivo_categoria` no body do POST.
- [ ] Smoke test manual via dev server.
- [ ] Commit: `feat(wms/ajuste/ui): select de motivo_categoria [#P6-6.24]`.

---

### D.2 — Delete `compras/conferir` endpoint deprecated [#P6-6.26, #P6-3.16]

#### Task D.2.1 — Verifica zero callers

- [ ] `grep -rn "/api/wms/compras/conferir" src scripts docs --include="*.ts" --include="*.tsx" --include="*.md" | grep -v "deprecated\|spec\|plan"`
- [ ] Esperado: 0 resultados (endpoint marcado deprecated em CLAUDE.md).

#### Task D.2.2 — Failing test (404)

- [ ] File: `scripts/wms/cenarios/catalogo/40-compras-conferir-removido.ts`.
- [ ] Skeleton análogo a cenário 26 (POST → expect 404).
- [ ] Run — confirma fails (endpoint atual responde 400/200, não 404).

#### Task D.2.3 — Delete

- [ ] `rm src/app/api/wms/compras/conferir/route.ts && rmdir src/app/api/wms/compras/conferir`.
- [ ] Update CLAUDE.md remover `compras/conferir/route.ts` da estrutura.
- [ ] Update `docs/api-reference-complete.md` remover entry.
- [ ] Re-run cenário 40 — passes.
- [ ] Commit: `feat(wms/compras): remove endpoint deprecated /conferir [#P6-6.26 #P6-3.16]`.

---

### D.3 — Delete `compras/itens/[id]/trocar-fornecedor` deprecated [#P6-6.27, #P6-3.15]

#### Task D.3.1 — Verifica zero callers

- [ ] `grep -rn "trocar-fornecedor" src scripts docs --include="*.ts" --include="*.tsx" --include="*.md" | grep -v "spec\|plan\|deprecated"`
- [ ] Esperado: 0 callers.

#### Task D.3.2 — Failing test

- [ ] File: `scripts/wms/cenarios/catalogo/41-trocar-fornecedor-removido.ts`. Skeleton análogo.

#### Task D.3.3 — Delete

- [ ] `rm src/app/api/wms/compras/itens/[itemId]/trocar-fornecedor/route.ts && rmdir src/app/api/wms/compras/itens/[itemId]/trocar-fornecedor`.
- [ ] Update CLAUDE.md + api-reference-complete.md.
- [ ] Re-run cenário 41 — passes.
- [ ] Commit: `feat(wms/compras): remove endpoint deprecated /trocar-fornecedor [#P6-6.27 #P6-3.15]`.

---

### D.4 — `pedidos/aprovar` "recusar real" [#P6-6.28]

P5 trata o botão UI. Aqui: backend aceita `decisao_final='rejeitado'` (novo valor).

**DECISION REQUIRED:** adicionar 'rejeitado' como `decisao_final` ou como `status_separacao`?

**RECOMMENDED:** novo `decisao_final='rejeitado'`. P5 implementa o botão "Recusar" que POSTa `{decisao: 'rejeitado'}`.

#### Task D.4.1 — Migration adicionar 'rejeitado' ao CHECK de decisao_final

- [ ] First verify current CHECK:
  ```bash
  grep -n "decisao_final" /Users/eryk/Documents/ESTOQUE/supabase/migrations/*.sql | head
  ```
- [ ] File: `supabase/migrations/20260527_decisao_final_rejeitado.sql`.
- [ ] Content (ajustar CHECK existente — conferir lista atual primeiro):
  ```sql
  BEGIN;

  ALTER TABLE siso_pedidos
    DROP CONSTRAINT IF EXISTS siso_pedidos_decisao_final_check;

  ALTER TABLE siso_pedidos
    ADD CONSTRAINT siso_pedidos_decisao_final_check
    CHECK (decisao_final IS NULL OR decisao_final IN (
      'propria', 'transferencia', 'oc', 'rejeitado'
    ));

  COMMIT;

  -- DOWN: remove 'rejeitado'.
  ```
- [ ] Apply.

#### Task D.4.2 — Edit `pedidos/aprovar/route.ts` aceita decisao='rejeitado'

- [ ] File: `src/app/api/wms/pedidos/aprovar/route.ts`.
- [ ] Adicionar branch:
  ```ts
  if (body.decisao === "rejeitado") {
    await supabase
      .from("siso_pedidos")
      .update({
        decisao_final: "rejeitado",
        status: "cancelado",
        status_separacao: null,
        cancelado_em: new Date().toISOString(),
      })
      .eq("id", pedidoId);
    await registrarEvento({
      pedidoId,
      evento: "cancelado",
      usuarioId: user.id,
      usuarioNome: user.nome,
      detalhes: { motivo: body.motivo ?? "recusado pelo operador" },
    });
    return NextResponse.json({ ok: true, decisao: "rejeitado" });
  }
  ```
- [ ] Coordinar com P2 (que reescreve aprovar com reservas) — merge depois de P2.
- [ ] Failing scenario `42-aprovar-rejeitado.ts` análogo.
- [ ] Commit: `feat(wms/aprovar): decisao=rejeitado real (botão Recusar) [#P6-6.28]`.

---

## E. Idempotência + Polish

### E.1 — `comprar` audit aging fornecedor_oc [#P6-6.29, #P6-3.6, #P6-3.11]

`compras/comprar` distribui qty cross-pedidos sem registrar fornecedor escolhido na ordem. Adicionar campo `fornecedor_oc` no body + grava em `siso_pedido_itens.fornecedor_oc` (nullable).

#### Task E.1.1 — Migration coluna `fornecedor_oc` em itens (se não existir)

- [ ] Verify: `grep -n "fornecedor_oc" /Users/eryk/Documents/ESTOQUE/supabase/migrations/*.sql`.
- [ ] Se NÃO existir, criar migration `20260527_pedido_itens_fornecedor_oc.sql`:
  ```sql
  BEGIN;
  ALTER TABLE siso_pedido_itens
    ADD COLUMN IF NOT EXISTS fornecedor_oc text;
  COMMIT;
  -- DOWN: DROP COLUMN.
  ```
- [ ] Se já existir, skip migration.

#### Task E.1.2 — Edit `compras/comprar/route.ts`

- [ ] No body schema: aceita `fornecedor_oc?: string` opcional.
- [ ] No UPDATE de `siso_pedido_itens`, adiciona `fornecedor_oc: body.fornecedor_oc ?? null` quando setado.
- [ ] Adiciona ao evento `compra_item_comprado` em detalhes (já feito em C.1.2).
- [ ] Commit: `feat(compras/comprar): registra fornecedor_oc [#P6-6.29 #P6-3.11]`.

---

### E.2 — `compras-release` idempotência: índice único [#P6-6.30, #P6-3.17]

Hoje pode haver múltiplos jobs `lancar_estoque` pendentes pro mesmo pedido — index único previne.

#### Task E.2.1 — Migration índice único

- [ ] File: `supabase/migrations/20260527_fila_execucao_release_unique.sql`.
- [ ] Content:
  ```sql
  BEGIN;

  -- Garante 1 job lancar_estoque pendente por pedido por vez.
  -- Status pendente = jobs ainda não processados pelo execution-worker.
  -- Se houver duplicados existentes, mantém o mais recente.
  WITH dup AS (
    SELECT id FROM (
      SELECT id, row_number() OVER (PARTITION BY pedido_id, tipo ORDER BY criado_em DESC) AS rn
        FROM siso_fila_execucao
       WHERE tipo = 'lancar_estoque'
         AND status = 'pendente'
    ) sub WHERE rn > 1
  )
  DELETE FROM siso_fila_execucao WHERE id IN (SELECT id FROM dup);

  CREATE UNIQUE INDEX IF NOT EXISTS uq_fila_release_pedido
    ON siso_fila_execucao(pedido_id)
    WHERE tipo = 'lancar_estoque' AND status = 'pendente';

  COMMIT;
  -- DOWN: DROP INDEX uq_fila_release_pedido;
  ```
- [ ] Apply.

#### Task E.2.2 — Edit `compras-release.ts` trata 409 do unique

- [ ] File: `src/lib/compras-release.ts`.
- [ ] Wrap o INSERT (linha 194-202) em try/catch:
  ```ts
  const { error: queueError } = await supabase
    .from("siso_fila_execucao")
    .insert({
      pedido_id: pedidoId,
      tipo: "lancar_estoque",
      empresa_id: empresaExecId,
      decisao,
      payload: { itens_ja_lancados: itensJaLancados },
    });

  if (queueError) {
    // Unique violation = job já enqueued; idempotent skip
    if (queueError.code === "23505") {
      logger.info("compras-release", "Job lancar_estoque já enfileirado (idempotente)", {
        pedidoId,
      });
    } else {
      logger.error("compras-release", "Erro ao enfileirar job de release", {
        pedidoId,
        error: queueError.message,
      });
      continue;
    }
  }
  ```
- [ ] Failing scenario: 2 chamadas consecutivas; 2ª deve ser idempotent.
- [ ] Commit: `feat(compras-release): índice único previne jobs lancar_estoque duplicados [#P6-6.30 #P6-3.17]`.

---

### E.3 — Auto-fix em GET `/compras?tab=receber` removido [#P6-6.31, #P6-3.12]

Hoje GET dispara um auto-fix silencioso (re-sync `compra_status`) — se algo deu errado, ninguém vê. Mover pra endpoint dedicado.

#### Task E.3.1 — Audit current behavior

- [ ] File: `src/app/api/wms/compras/route.ts`.
- [ ] Identifica bloco de auto-fix (procurar comentário "auto-fix" ou updates condicionais em GET).
- [ ] Confirma que é só fire-and-forget side effect.

#### Task E.3.2 — Edit: remove auto-fix, log warning

- [ ] Remove o bloco auto-fix e adiciona um log:
  ```ts
  // Sanity check: detecta inconsistências e loga warning (ao invés de auto-fix silencioso)
  const inconsistencias = items.filter(/* condição existente */);
  if (inconsistencias.length > 0) {
    logger.warn("compras.tab-receber", "inconsistências detectadas em GET — chame /admin/compras/reconciliar", {
      count: inconsistencias.length,
      sample_ids: inconsistencias.slice(0, 5).map((i) => i.id),
    });
  }
  ```
- [ ] **Decision required:** criar `/api/wms/admin/compras/reconciliar` como manual fix? **RECOMMENDED:** sim, fora do P6. Marcar como follow-up.
- [ ] Commit: `fix(compras): substitui auto-fix silencioso em GET por logger.warn [#P6-6.31 #P6-3.12]`.

---

### E.4 — Detecção devolução refatorada (helper) [#P6-6.32]

`webhook/tiny` + `nf-webhook-handler` têm lógica duplicada de detecção `isDevolucao`. Extrai helper.

> **Coordinate with P2:** P2 já mexe em `webhook/tiny/route.ts` e `nf-webhook-handler.ts`. Coordene merge — aplicar P6 DEPOIS de P2 merge nesta sub-task. Ver §11 do spec.

#### Task E.4.1 — Cria `lib/wms/devolucao-detector.ts`

- [ ] File: `src/lib/wms/devolucao-detector.ts`.
- [ ] Content:
  ```ts
  /**
   * Helper único pra detectar se NF webhook representa devolução.
   * Centraliza heurística usada em webhook/tiny + nf-webhook-handler.
   */

  interface NfPayload {
    finalidade?: string | number;
    nf_referenciada?: unknown;
    natureza_operacao?: string;
    cfop?: string;
  }

  export function isDevolucao(payload: NfPayload): boolean {
    // 1. Finalidade Tiny = 4 (devolução)
    if (String(payload.finalidade ?? "") === "4") return true;
    // 2. CFOP devolução
    const cfop = String(payload.cfop ?? "");
    if (/^[15]20[12]$/.test(cfop)) return true;
    // 3. Natureza operação keyword
    if (/devolu[çc][ãa]o/i.test(payload.natureza_operacao ?? "")) return true;
    // 4. NF referenciada presente sugere devolução (último recurso)
    if (payload.nf_referenciada && Object.keys(payload.nf_referenciada).length > 0)
      return true;
    return false;
  }
  ```
- [ ] Unit tests em `src/lib/wms/devolucao-detector.test.ts` (5+ casos).

#### Task E.4.2 — Substituir callers

- [ ] Em `webhook/tiny/route.ts` + `nf-webhook-handler.ts`, importar `isDevolucao` e remover lógica inline.
- [ ] Commit: `refactor(wms): centraliza isDevolucao em helper único [#P6-6.32]`.

---

### E.5 — Dedup webhook combina nota_fiscal_id + chave_acesso_nf [#P6-6.33]

Hoje dedup só usa `dedup_key`. Se webhook chega com payload diferente mas mesma NF, pode duplicar.

#### Task E.5.1 — Migration índice composto

- [ ] File: `supabase/migrations/20260527_webhook_dedup_nf_compound.sql`.
- [ ] Content:
  ```sql
  BEGIN;

  -- Index dedup composto: nota_fiscal_id OU chave_acesso_nf
  CREATE INDEX IF NOT EXISTS idx_webhook_logs_dedup_nf
    ON siso_webhook_logs(nota_fiscal_id)
    WHERE nota_fiscal_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_webhook_logs_dedup_chave
    ON siso_webhook_logs(chave_acesso_nf)
    WHERE chave_acesso_nf IS NOT NULL;

  COMMIT;
  ```
- [ ] Apply.

#### Task E.5.2 — Edit `webhook/tiny/route.ts` dedup adicional

- [ ] Antes do INSERT em `siso_webhook_logs`, lookup adicional:
  ```ts
  if (notaFiscalId || chaveAcessoNf) {
    const { data: prev } = await sb
      .from("siso_webhook_logs")
      .select("id, processado_em")
      .or(
        `nota_fiscal_id.eq.${notaFiscalId ?? "null"},chave_acesso_nf.eq.${chaveAcessoNf ?? ""}`,
      )
      .limit(1)
      .maybeSingle();
    if (prev?.processado_em) {
      logger.info("webhook.tiny.dedup", "NF já processada", {
        nota_fiscal_id: notaFiscalId,
        chave_acesso_nf: chaveAcessoNf,
        previous_log_id: prev.id,
      });
      return NextResponse.json({ ok: true, deduplicated: true });
    }
  }
  ```
- [ ] Commit: `fix(webhook): dedup combina nota_fiscal_id + chave_acesso_nf [#P6-6.33]`.

---

### E.6 — `validar-oc-item` "esgotado" deduz qty_pega parcial [#P6-6.34, #P6-2.18]

Hoje "esgotado" considera qty original; precisa deduzir `quantidade_pega` + realocs picadas.

#### Task E.6.1 — Edit `separacao/validar-oc-item/route.ts`

- [ ] File: `src/app/api/wms/separacao/validar-oc-item/route.ts`.
- [ ] Localiza branch `esgotado:true`.
- [ ] Antes de marcar status, compute:
  ```ts
  // Qty efetiva = pedida - já pegada (parcial) - picadas em realocações
  const qtyJaPega = Number(itemRow.quantidade_pega ?? 0);
  const { data: realocs } = await sb
    .from("siso_pedido_item_realocacoes")
    .select("qty_picada")
    .eq("pedido_item_id", itemRow.id)
    .eq("status", "picado");
  const qtyRealocsPicadas = (realocs ?? []).reduce(
    (acc, r) => acc + Number(r.qty_picada ?? 0),
    0,
  );
  const qtyEfetiva = Math.max(0, Number(itemRow.quantidade_pedida) - qtyJaPega - qtyRealocsPicadas);
  if (qtyEfetiva === 0) {
    // Item totalmente coberto — não dá pra marcar esgotado
    return NextResponse.json(
      { error: "item já totalmente coberto — não pode ser marcado esgotado" },
      { status: 409 },
    );
  }
  // Usa qtyEfetiva pra enviar pra OC
  ```
- [ ] Commit: `fix(separacao/validar-oc-item): esgotado deduz qty_pega + realocs [#P6-6.34 #P6-2.18]`.

---

### E.7 — `cancelar` separação preserva `mov_ajuste_loc_zerou` (doc) [#P6-6.35, #P6-2.11]

Comportamento intencional — só documentar.

#### Task E.7.1 — Add comment in `separacao/cancelar/route.ts`

- [ ] File: `src/app/api/wms/separacao/cancelar/route.ts`.
- [ ] No bloco que reseta campos do item, adicionar comment explicativo:
  ```ts
  // DESIGN: mov_ajuste_loc_zerou_id é preservado deliberadamente.
  // O ajuste de "loc zerou" representa uma realidade física (a loc realmente
  // estava vazia quando o operador chegou) — cancelar a separação NÃO desfaz
  // a constatação física. Se o operador quiser "desfazer" o ajuste, usar
  // /api/wms/separacao/desfazer-parcial (fluxo explícito).
  ```
- [ ] Add anchor in `CLAUDE.md` (seção Separation Flow) explaining the design.
- [ ] Commit: `docs(separacao/cancelar): documenta preservação intencional de mov_ajuste_loc_zerou [#P6-6.35 #P6-2.11]`.

---

### E.8 — `vendas/criar` detecta produto mapeado pra empresa diferente [#P6-6.36, #P6-7.8]

Hoje `vendas/criar` retorna 500 críptico se `tinyId` não encontrado pra `empresa_origem_id`. Mensagem melhor + sugerir.

#### Task E.8.1 — Edit `vendas/criar/route.ts`

- [ ] File: `src/app/api/wms/vendas/criar/route.ts`.
- [ ] Localiza linha 192-196 (atual erro):
  ```ts
  if (!tinyId) {
    throw new Error(
      `Produto ${prod.sku} não está cadastrado na empresa origem — peça pro admin sincronizar via Tiny`,
    );
  }
  ```
- [ ] Substitui por lookup + sugestão:
  ```ts
  if (!tinyId) {
    // Verifica se produto existe em OUTRAS empresas — sugere
    const { data: outrasEmpresas } = await supabase
      .from("siso_produto_empresas")
      .select("empresa_id, siso_empresas!inner(nome)")
      .eq("produto_id", item.produto_id);
    const sugestoes = (outrasEmpresas ?? []).map((e: any) => e.siso_empresas?.nome).filter(Boolean);
    const msg = sugestoes.length > 0
      ? `Produto ${prod.sku} não está cadastrado na empresa origem (${empresa.nome}). Disponível em: ${sugestoes.join(", ")}. Selecione uma dessas ou peça pro admin sincronizar.`
      : `Produto ${prod.sku} não está cadastrado em nenhuma empresa — peça pro admin sincronizar via Tiny`;
    throw new Error(msg);
  }
  ```
- [ ] Commit: `fix(vendas/criar): mensagem sugere outras empresas quando produto não mapeado [#P6-6.36 #P6-7.8]`.

---

### E.9 — `resolverDisponibilidadeVenda` retorna múltiplas locs [#P6-6.37, #P6-7.9]

Hoje retorna 1 loc; baixa direta pode precisar split. Expor lista ordenada.

#### Task E.9.1 — Edit `vendas-disponibilidade.ts`

- [ ] File: `src/lib/wms/vendas-disponibilidade.ts`.
- [ ] Adiciona `sugestoes: DisponibilidadeSugestao[]` (lista ordenada) ao `DisponibilidadeResult`:
  ```ts
  export interface DisponibilidadeResult {
    total_disponivel: number;
    sugestao: DisponibilidadeSugestao | null; // mantém pra compat
    sugestoes: DisponibilidadeSugestao[];     // NEW — lista ordenada
  }
  ```
- [ ] No return, popular `sugestoes`:
  ```ts
  const sugestoes = rows.map((r) => ({
    localizacao_id: r.localizacao_id,
    localizacao_codigo: r.localizacao!.codigo!,
    localizacao_tipo: r.localizacao!.tipo ?? "picking",
    disponivel: Number(r.disponivel),
  }));
  return {
    total_disponivel: total,
    sugestao: sugestoes[0] ?? null,
    sugestoes,
  };
  ```
- [ ] Edit `vendas/criar/route.ts` `baixa_direta` block (linha ~297+): usa `sugestoes[]` pra split em múltiplas movs quando qty pedida não cabe em 1 loc:
  ```ts
  // Distribui qty entre locs até completar
  let restante = item.quantidade;
  for (const sug of item.sugestoes ?? []) {
    if (restante <= 0) break;
    const qtyDestaLoc = Math.min(restante, sug.disponivel);
    // ... insere mov pra esta loc com qtyDestaLoc
    restante -= qtyDestaLoc;
  }
  ```
- [ ] Update `ItemResolvido` interface pra incluir `sugestoes` array.
- [ ] Failing scenario: cria 2 locs picking com saldo 3 cada, vende 5 → split 3+2.
- [ ] Commit: `feat(vendas-disponibilidade): expõe sugestoes[] pra split em múltiplas locs [#P6-6.37 #P6-7.9]`.

---

### E.10 — `vendedor_id` pode ser "em nome de X" [#P6-6.38, #P6-7.10]

Hoje `vendedor_id = user.id` sempre. Aceitar `vendedor_id_alvo` no body (admin/operador pode atribuir a outro vendedor).

#### Task E.10.1 — Edit `vendas/criar/route.ts`

- [ ] Adiciona ao body schema: `vendedor_id_alvo?: string`.
- [ ] Validation:
  ```ts
  let vendedorIdEfetivo = user.id;
  let vendedorNomeEfetivo = user.nome;
  if (body.vendedor_id_alvo && body.vendedor_id_alvo !== user.id) {
    // Só admin/operador pode atribuir a outro
    if (!userCan(user, "vendas.criar_em_nome_de")) {
      return NextResponse.json(
        { erro: "sem permissão pra criar em nome de outro vendedor" },
        { status: 403 },
      );
    }
    const { data: alvo } = await supabase
      .from("siso_usuarios")
      .select("id, nome, cargo")
      .eq("id", body.vendedor_id_alvo)
      .single();
    if (!alvo) {
      return NextResponse.json({ erro: "vendedor_id_alvo inválido" }, { status: 400 });
    }
    vendedorIdEfetivo = alvo.id;
    vendedorNomeEfetivo = alvo.nome;
  }
  ```
- [ ] Substitui `vendedor_id: user.id` por `vendedor_id: vendedorIdEfetivo` (e nome também).
- [ ] **DECISION:** adicionar permissão nova `vendas.criar_em_nome_de`? **RECOMMENDED:** sim — registry em `src/lib/permissions.ts`.

#### Task E.10.2 — Adiciona permissão `vendas.criar_em_nome_de`

- [ ] File: `src/lib/permissions.ts`.
- [ ] Adiciona ao registry. Default: admin, operador_cwb, operador_sp (não vendedor).
- [ ] Apply via migration de roles (similar a 20260521_roles_permissoes).
- [ ] Commit: `feat(vendas): vendedor_id_alvo + perm vendas.criar_em_nome_de [#P6-6.38 #P6-7.10]`.

---

### E.11 — Pedidos ML/Shopee auto-atribuídos populam `vendedor_id` [#P6-6.39, #P6-7.5]

Hoje `webhook-processor.ts:373` seta `vendedor_nome` mas não `vendedor_id`.

#### Task E.11.1 — Edit `lib/webhook-processor.ts`

- [ ] File: `src/lib/webhook-processor.ts`.
- [ ] Linha ~373: já seta `vendedor_nome = '{nome_ecommerce} {empresa_nome}'`.
- [ ] Adicionar lookup de usuário "system" ou criar marker:
  ```ts
  // Auto-atribuição: usa usuário system (criado em migration) para marketplaces
  const { data: sysUser } = await sb
    .from("siso_usuarios")
    .select("id")
    .eq("nome", "system-marketplace")
    .maybeSingle();
  const vendedorIdAuto = sysUser?.id ?? null;
  // ...
  vendedor_id: vendedorIdAuto,
  vendedor_nome: nomeAuto,
  ```
- [ ] Migration cria user "system-marketplace":
  ```sql
  -- supabase/migrations/20260527_user_system_marketplace.sql
  BEGIN;
  INSERT INTO siso_usuarios (nome, pin, cargo, ativo)
    VALUES ('system-marketplace', '0000', 'admin', false)
    ON CONFLICT (nome) DO NOTHING;
  COMMIT;
  ```
- [ ] Apply migration.
- [ ] Commit: `feat(webhook): vendedor_id system pra pedidos ML/Shopee [#P6-6.39 #P6-7.5]`.

---

### E.12 — `pedidos/tracking` paginação [#P6-6.40, #P6-7.16 (related)]

#### Task E.12.1 — Edit `pedidos/tracking/route.ts`

- [ ] File: `src/app/api/wms/pedidos/tracking/route.ts`.
- [ ] Adiciona query params `?cursor=<criado_em>&limit=<N (default 50, max 200)>`.
- [ ] Substitui `LIMIT 500` por `LIMIT validatedLimit`.
- [ ] Order by `criado_em DESC, id DESC`.
- [ ] Return `{ items, next_cursor: items.length === limit ? items[last].criado_em : null }`.
- [ ] Commit: `feat(pedidos/tracking): paginação cursor-based [#P6-6.40]`.

---

### E.13 — Tab "Histórico" compras paginação [#P6-6.41, #P6-3.13]

- [ ] File: `src/app/wms/compras/page.tsx`.
- [ ] Tab "Histórico" usa endpoint compras com `?status=concluida`. Adiciona `cursor/limit`.
- [ ] Cliente: "Carregar mais" button.
- [ ] Commit: `feat(wms/compras): paginação aba Histórico [#P6-6.41 #P6-3.13]`.

---

### E.14 — `getCompraQuantidadeRestante` over-receive [#P6-6.42, #P6-3.14]

#### Task E.14.1 — Edit `compras-utils.ts`

- [ ] File: `src/lib/compras-utils.ts`.
- [ ] Função `getCompraQuantidadeRestante` (procurar):
  ```ts
  export function getCompraQuantidadeRestante(item: ItemRow): number {
    const restante = (item.quantidade_comprada ?? 0) - (item.quantidade_recebida ?? 0);
    // Antes: Math.max(0, restante) — ignora over-receive.
    // Agora: retorna negativo pra UI sinalizar over-receive.
    return restante;
  }
  ```
- [ ] Update callers que assumiam ≥0: tratar negativo como "alerta".
- [ ] Commit: `fix(compras-utils): expõe over-receive como restante negativo [#P6-6.42 #P6-3.14]`.

---

### E.15 — `vendas/payload_original.idempotency_key` índice [#P6-6.43, #P6-7.16]

#### Task E.15.1 — Migration índice JSONB

- [ ] File: `supabase/migrations/20260527_idempotency_key_index.sql`.
- [ ] Content:
  ```sql
  BEGIN;

  -- Index parcial sobre payload_original->>'idempotency_key' pra lookup rápido
  CREATE INDEX IF NOT EXISTS idx_pedidos_idempotency_key
    ON siso_pedidos((payload_original->>'idempotency_key'))
    WHERE payload_original ? 'idempotency_key';

  COMMIT;

  -- DOWN: DROP INDEX idx_pedidos_idempotency_key;
  ```
- [ ] Apply.
- [ ] Commit: `feat(pedidos): index pra payload_original->>idempotency_key [#P6-6.43 #P6-7.16]`.

---

### E.16 — `retry-etiqueta` restaura embalado→separado [#P6-6.44, #P6-2.19]

- [ ] File: `src/app/api/wms/separacao/retry-etiqueta/route.ts`.
- [ ] Procurar bloco que faz `status_separacao = 'separado'` durante retry.
- [ ] Substituir por restore ao status original capturado no início (não rebaixar sempre):
  ```ts
  const { data: pedidoBefore } = await sb
    .from("siso_pedidos")
    .select("status_separacao")
    .eq("id", pedidoId)
    .single();
  // ... lógica retry impressão ...
  // No catch (falha), restaura o status original em vez de assumir 'separado'.
  ```
- [ ] Commit: `fix(separacao/retry-etiqueta): preserva status original em falha [#P6-6.44 #P6-2.19]`.

---

### E.17 — `iniciar` separação rejeita `pendente_realocacao` [#P6-6.45, #P6-2.20]

- [ ] File: `src/app/api/wms/separacao/iniciar/route.ts`.
- [ ] Procurar whitelist de status aceitos (deve incluir `pendente_realocacao`).
- [ ] Remover `pendente_realocacao` do whitelist — só transitar `aguardando_separacao → em_separacao` (separação não foi iniciada) e `em_separacao → em_separacao` (idempotente).
- [ ] Adicionar branch:
  ```ts
  if (currentStatus === "pendente_realocacao") {
    return NextResponse.json(
      { error: "pedido em pendente_realocacao — resolver realocações antes de iniciar" },
      { status: 409 },
    );
  }
  ```
- [ ] Commit: `fix(separacao/iniciar): rejeita pendente_realocacao [#P6-6.45 #P6-2.20]`.

---

### E.18 — `siso_pedido_itens.produto_id` é tiny_produto_id (doc) [#P6-6.46, #P6-7.11]

Comportamento legado intencional — só documentar.

- [ ] Add comment em `src/types/index.ts` (ou type `PedidoItem`):
  ```ts
  // produto_id em siso_pedido_itens é tiny_produto_id (bigint), NÃO o uuid de
  // siso_produtos. Legado herdado do schema pré-WMS. Pra resolver pro uuid WMS,
  // fazer JOIN: siso_pedido_itens.produto_id → siso_produto_empresas.tiny_produto_id
  // (filtrar por empresa_id correta) → produto_id (uuid WMS).
  ```
- [ ] Add entry em CLAUDE.md "Coding Conventions > Notas legados".
- [ ] Commit: `docs: documenta semântica de siso_pedido_itens.produto_id = tiny_produto_id [#P6-6.46 #P6-7.11]`.

---

### E.19 — Venda manual popula `pedido_id` no ledger [#P6-6.47, #P6-7.14]

- [ ] File: `src/app/api/wms/vendas/criar/route.ts`.
- [ ] No bloco `baixa_direta` (linha ~301+, dentro do for de itens), na chamada `inserirMovimentacao`, adiciona:
  ```ts
  pedido_id: pedidoId, // MAN-...-text (siso_movimentacoes.pedido_id é text)
  ```
- [ ] Commit: `fix(vendas/criar): popula pedido_id no ledger das movs de venda manual [#P6-6.47 #P6-7.14]`.

---

### E.20 — `resolverLocRecebimento` feedback [#P6-5.14]

`resolverLocRecebimento` cria loc RECEBIMENTO como side-effect sem retornar flag.

- [ ] File: `src/lib/wms/guarda.ts`.
- [ ] Refactor função pra retornar `{ id: string; created: boolean }`:
  ```ts
  export async function resolverLocRecebimento(
    galpaoId: string,
  ): Promise<{ id: string; created: boolean }> {
    // ...
    if (existente && existente.length > 0) return { id: existente[0].id, created: false };
    // ...
    return { id: nova.id, created: true };
  }
  ```
- [ ] Update callers — onde `created=true`, logar warning.
- [ ] Commit: `refactor(wms/guarda): resolverLocRecebimento retorna flag created [#P6-5.14]`.

---

### E.21 — Feedback persistente de impressões falhadas [#P6-5.16]

`etiqueta-produto-service.ts` é fire-and-forget. Adicionar log persistente em falha + endpoint pra listar.

- [ ] File: `src/lib/wms/etiqueta-produto-service.ts`.
- [ ] No catch da impressão, persistir em `siso_logs` com source dedicado e tag `falha_impressao_produto`. Já feito via `logger.error`? Confirma; se sim, é suficiente.
- [ ] Add filtro UI em `/wms/configuracoes/impressoras` (P5 escopo) — apenas marca task closed via doc.
- [ ] Commit: `docs: confirmação de logging em falhas de impressão [#P6-5.16]`.

---

### E.22 — `computarDivergencias` re-execução duplicate lock cleanup [#P6-4.13]

> **Coordinate with P3:** P3 reescreve `computarDivergencias`. Após P3 merge, validar com cenário.

- [ ] Skip implementation; criar cenário 43 que roda `computarDivergencias` 2x consecutivas e valida idempotência.
- [ ] File: `scripts/wms/cenarios/catalogo/43-computar-divergencias-idempotente.ts`.
- [ ] Run após P3 merge.
- [ ] Commit (post-P3): `test(inventario): valida idempotência computarDivergencias [#P6-4.13]`.

---

### E.23 — `entrarParty` auto-inicia sessão sem perm supervisor [#P6-4.14]

- [ ] File: `src/app/api/wms/inventario/[id]/party/route.ts`.
- [ ] Antes de auto-iniciar sessão, checar perm:
  ```ts
  if (sessao.status === "planejada") {
    if (!userCan(user, "inventario.iniciar_sessao")) {
      return NextResponse.json(
        { error: "apenas supervisor pode iniciar sessão — peça que inicie antes de entrar" },
        { status: 403 },
      );
    }
    // ... auto-inicia
  }
  ```
- [ ] **DECISION:** adicionar perm `inventario.iniciar_sessao`? **RECOMMENDED:** sim. Default: admin + supervisor (cargo).
- [ ] Add perm em `src/lib/permissions.ts`.
- [ ] Migration de roles (alinha com 20260521_roles_permissoes).
- [ ] Commit: `feat(inventario): entrarParty exige perm pra auto-iniciar sessão planejada [#P6-4.14]`.

---

### E.24 — `delta_pct` null quando saldo_esperado=0 [#P6-4.19]

UI mostra "—". Documentar como design decision (não há "%" matemático quando esperado=0).

- [ ] File: `src/app/wms/inventario/[id]/divergencias/page.tsx` (ou onde renderiza).
- [ ] Renderiza:
  - Se `delta_pct` null E `saldo_esperado === 0` E `qty_contada > 0`: mostra "⚠ achado" (não "—")
  - Se `delta_pct` null E ambos 0: mostra "✓"
- [ ] Commit (P5 escopo overlap; só adiciona doc em P6): `docs(inventario): delta_pct null = achado quando esperado=0 [#P6-4.19]`.

---

### E.25 — 2 ops bipando mesma tripla (doc) [#P6-4.20]

Comportamento documentado em §17 spec — apenas adicionar comment.

- [ ] File: `src/lib/wms/inventario.ts` (procurar `inserirContagem` ou similar).
- [ ] Add comment:
  ```ts
  // DESIGN: 2 ops podem bipar a mesma tripla em paralelo (caso edge: sair-party
  // mid-loc). `computarDivergencias` soma todas as contagens da tripla via
  // reconciliação temporal — divergência final reflete soma. Ver
  // 2026-05-18-estoque-online-fluxo.html.
  ```
- [ ] Commit: `docs(inventario): documenta semântica de 2 ops mesma tripla [#P6-4.20]`.

---

### E.26 — `cancelar` separação `movs_estornadas` JSONB sem limite [#P6-2.22]

- [ ] File: `src/app/api/wms/separacao/cancelar/route.ts`.
- [ ] Procurar bloco que monta JSONB `movs_estornadas` em detalhes.
- [ ] Aplicar truncate via helper já criado em C.4 (`truncateDetalhes`):
  ```ts
  await registrarEvento({
    pedidoId,
    evento: "separacao_cancelada",
    usuarioId: user.id,
    detalhes: { movs_estornadas: ids, /* etc */ }, // truncateDetalhes aplicado dentro do registrarEvento
  });
  ```
- [ ] Sanity: confirmar que `truncateDetalhes` em C.4 já cobre — sim. Marca closed via reuso.
- [ ] Commit (já coberto por C.4): pulará — closed via task C.4.

---

### E.27 — `desfazer-parcial` UI mensagem corrigida [#P6-2.17]

- [ ] File: `src/app/api/wms/separacao/desfazer-parcial/route.ts`.
- [ ] Atualiza mensagem de erro/sucesso pra apontar UI existente (não inexistente).
- [ ] Commit: `fix(separacao/desfazer-parcial): mensagem aponta UI existente [#P6-2.17]`.

---

### E.28 — `use-realtime-separacao` query extra por evento [#P6-2.21]

- [ ] File: `src/hooks/use-realtime-separacao.ts`.
- [ ] Identifica refetch automático em cada evento → adicionar debounce 500ms via `requestAnimationFrame` ou `setTimeout`.
- [ ] Substitui `queryClient.invalidateQueries(...)` por debounced version.
- [ ] Commit: `perf(use-realtime-separacao): debounce refetch (500ms) [#P6-2.21]`.

---

### E.29 — `/expedir` é órfã [#P6-2.15]

Status `expedido` é forward-state mas endpoint `/expedir` pode ser órfão.

- [ ] Audit:
  ```bash
  grep -rn "/api/wms/separacao/expedir" src --include="*.ts" --include="*.tsx" | grep -v "route.ts"
  ```
- [ ] Se 0 callers, deletar como D.2/D.3.
- [ ] Se houver callers, mantém + adiciona registrarEvento `expedido`.
- [ ] Commit: depende — `feat` ou `delete`.

---

### E.30 — `/wms/replenishment` botão delega ao shell [#P6-8.13]

- [ ] File: `src/app/wms/replenishment/page.tsx`.
- [ ] Audit: identifica botão que delega ao shell sem ação real.
- [ ] **DECISION:** implementar ação no clique (abrir modal de nova replenishment) ou remover botão e marcar página como readonly?
- [ ] **RECOMMENDED:** marcar página como readonly + adicionar link "Use Ajuste pra criar replenishment manual" pra evitar promessa quebrada.
- [ ] Commit: `fix(wms/replenishment): página readonly + link orientativo [#P6-8.13]`.

---

### E.31 — Sugestão recomputada vs persistida flicker [#P6-1.15]

`pedidos/route.ts` `recomputarSugestaoBatch` causa flicker.

- [ ] File: `src/app/api/wms/pedidos/route.ts`.
- [ ] Identifica `recomputarSugestaoBatch`. Compara com `pedido.sugestao_persisted` antes de mostrar.
- [ ] Se valor recomputado é diferente, log warning + persiste apenas em UPDATE explícito (não em GET).
- [ ] GET retorna `sugestao` sempre da coluna persistida; recomputação fica em endpoint dedicado.
- [ ] Commit: `fix(pedidos): GET retorna sugestao persistida; recompute em endpoint dedicado [#P6-1.15]`.

---

### E.32 — `siso_pedido_item_estoques` semantic tag-vs-coord cleanup [#P6-1.12]

`webhook-processor-wms.ts:597` continua escrevendo na tabela legacy mesmo após cutover.

- [ ] File: `src/lib/webhook-processor-wms.ts` linha 597.
- [ ] Audit current usage. Como CLAUDE.md aponta `siso_pedido_item_estoques` segue escrita por inércia, **não remover** o write — apenas adicionar comment + log warning indicando deprecação:
  ```ts
  // DEPRECATED: write to siso_pedido_item_estoques (only retained for legacy
  // consumers in /pedidos/tracking + painel). Future removal blocked on
  // migration of those consumers to read from siso_estoque + ledger.
  // See `docs/wms-deprecated-galpao-id-consumers.md` and follow-up issue.
  logger.info("webhook.legacy-write", "pedido_item_estoques row written (legacy)", {
    pedido_id: pedidoId,
    rows: linhas.length,
  });
  ```
- [ ] Commit: `docs(webhook-wms): marca pedido_item_estoques write como legacy [#P6-1.12]`.

---

### E.33 — Reconciliação temporal cutoff→aplicada (doc) [#P6-4.8]

> **Coordinate with P3:** P3 já mexe em `computarDivergencias`. Aqui só adicionar doc em comment + README inventário.

- [ ] File: `src/lib/wms/inventario.ts` (em `computarDivergencias`).
- [ ] Add comment explicativo:
  ```ts
  // LIMITAÇÃO CONHECIDA: reconciliação temporal usa cutoff_em (=contado_em).
  // Movs entre cutoff_em e aprovado_em ainda alteram saldo "esperado" no
  // ledger, mas a divergência foi calculada com snapshot cutoff_em.
  // Pra reduzir janela: aprovar rapidamente após contagem. Ver design doc:
  // docs/superpowers/specs/2026-05-18-estoque-online-fluxo.html
  ```
- [ ] Commit: `docs(inventario): documenta janela cutoff→aplicada [#P6-4.8]`.

---

### E.34 — `empresa_referencia_id` resolve null com dado disponível [#P6-6.14 devolucoes]

- [ ] File: `src/lib/wms/devolucoes.ts`.
- [ ] Em `classificarDevolucao`, antes de chamar `inserirMovimentacao`, adicionar fallback de busca via `chave_acesso_nf` ou `nota_fiscal_id` no `siso_pedidos` se `empresa_referencia_id` ainda null:
  ```ts
  if (!empresaReferenciaId) {
    if (d.nota_fiscal_id) {
      const { data: ped } = await sb
        .from("siso_pedidos")
        .select("empresa_origem_id")
        .eq("nota_fiscal_id", d.nota_fiscal_id)
        .maybeSingle();
      empresaReferenciaId = (ped as { empresa_origem_id: string } | null)?.empresa_origem_id ?? null;
    }
  }
  ```
- [ ] Commit: `fix(devolucoes): fallback empresa_referencia via siso_pedidos.nota_fiscal_id [#P6-6.14]`.

---

### E.35 — `pedido_origem_mov_id` resolve via chave_acesso [#P6-6.15 devolucoes]

- [ ] File: `src/lib/wms/devolucoes.ts` `registrarDevolucaoPendente`.
- [ ] Atual lookup só via `nota_fiscal_id`. Adicionar fallback `chave_acesso_nf`:
  ```ts
  if (!pedidoOrigemMovId && input.chave_acesso_nf) {
    const { data: mov } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("chave_acesso_nf", input.chave_acesso_nf)
      .eq("tipo", "S")
      .maybeSingle();
    pedidoOrigemMovId = (mov as { id: string } | null)?.id ?? null;
  }
  ```
- [ ] Commit: `fix(devolucoes): resolve pedido_origem_mov via chave_acesso fallback [#P6-6.15]`.

---

### E.36 — Ledger não compartilha origem_id entre movs B/C [#P6-6.17 ledger]

Devoluções Classe B (avariada → quarentena: par S+E) e C (garantia: E+S fornecedor) usam `origem_id` random — não dá pra agrupar.

- [ ] File: `src/lib/wms/devolucoes.ts`.
- [ ] No início do `classificarDevolucao` gerar `origemCompartilhado = crypto.randomUUID()` e passar em todas as movs do mesmo classify:
  ```ts
  const origemCompartilhado = crypto.randomUUID();
  // ... em cada inserirMovimentacao:
  origem_id: origemCompartilhado,
  ```
- [ ] Commit: `fix(devolucoes): origem_id compartilhado entre movs do mesmo classify [#P6-6.17]`.

---

### E.37 — Modo blind vs aberto inventário PATCH guard [#P6-6.16]

> **Coordinate with P3:** P3 já adiciona guard em `pickPatchFields`. Aqui só validar.

- [ ] Adicionar cenário 44 — modo PATCH em sessão `em_andamento` deve falhar 409.
- [ ] Run após P3 merge.
- [ ] Commit (post-P3): `test(inventario): valida guard modo blind/aberto [#P6-6.16]`.

---

## F. Final Verification

### Task F.1 — Run all P6 scenarios

- [ ] Rebuild dev server fresh (kill + restart).
- [ ] Run all P6-added scenarios (22-44):
  ```bash
  npm run scenarios -- --only 22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44
  ```
- [ ] All must pass.

### Task F.2 — Run full scenarios suite (regression)

- [ ] Run baseline + P6:
  ```bash
  npm run scenarios
  ```
- [ ] All 21 baseline + 23 novos = 44 scenarios devem passar.

### Task F.3 — Validate §10.5 acceptance criteria

- [ ] Cenário 22 (transferência > 7d auto-cancelada): `PASS` confirmado via run F.1.
- [ ] Cenário 24 (operador zumbi liberado 30min): `PASS` confirmado via F.1.
- [ ] Cenário 27 (loc quarentena não aparece em sugerir): `PASS` confirmado via F.1.
- [ ] `siso_pedido_historico` tem eventos compras (verificar):
  ```sql
  SELECT evento, count(*) FROM siso_pedido_historico
   WHERE evento LIKE 'compra_%'
   GROUP BY evento;
  ```
  Esperado: ao menos 1 por evento (compra_item_comprado, compra_item_recebido, ...).
- [ ] Migration `motivo_categoria` aplicada + UI usa:
  ```sql
  SELECT column_name, data_type FROM information_schema.columns
   WHERE table_name='siso_movimentacoes' AND column_name='motivo_categoria';
  ```
  Esperado: `motivo_categoria | USER-DEFINED`.
- [ ] `/api/wms/transferir-galpao` não existe:
  ```bash
  curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/wms/transferir-galpao -X POST
  ```
  Esperado: `404`.
- [ ] `webhook/tiny` dedup detecta retries com `chave_acesso_nf` populado mid-flight: cenário existente coberto + observabilidade via `siso_logs` source `webhook.tiny.dedup`.

### Task F.4 — Final sanity counts

- [ ] Compare `siso_pedido_historico` count vs baseline (esperar incremento substancial):
  ```bash
  psql "$DATABASE_URL_STAGING" -c "SELECT count(*) FROM siso_pedido_historico;"
  diff /tmp/p6-baseline-historico.txt <(psql ...)
  ```
- [ ] Confirma incremento ≥ 7 eventos novos × 23 scenarios = ≥161 novos rows.

### Task F.5 — Run lint + typecheck

- [ ] `npm run lint` — 0 erros.
- [ ] `npx tsc --noEmit` — 0 erros.

### Task F.6 — Open PR

- [ ] Push branch:
  ```bash
  git push -u origin wms-fix-p6
  ```
- [ ] Open PR via `gh pr create` (não auto-create — deixar User aprovar):
  ```bash
  gh pr create --base develop --title "fix(wms): P6 — Estado Fantasma + Cleanups + Polish (48 findings)" --body "$(cat <<'EOF'
  ## Summary

  Implements WMS Fix P6 covering 48 findings across:
  - **Estado fantasma:** transferências expira_em + cron, saldo recebimento órfão endpoint, cleanup operadores zumbi
  - **Hardcoded/schema:** compras-release migrated off siso_empresas.galpao_id deprecated, vendas/criar cwb_atende dinâmico, wms_inventario_sugerir exclui quarentena, devoluções loc quarentena determinística
  - **Audit trail:** 7 endpoints compras + criar/confirmar guarda + PATCH inventário ganham registrarEventos
  - **Categoria estruturada:** ajuste_manual.motivo_categoria enum (6 valores)
  - **Deadcode:** 3 endpoints deletados (transferir-galpao, compras/conferir, compras/trocar-fornecedor)
  - **Polish:** 19 fixes menores (idempotência, paginação, índices, helpers)

  See `docs/superpowers/plans/2026-05-26-wms-fix-p6-estado-fantasma-cleanups.md`.

  ## Test plan

  - [ ] Run `npm run scenarios` — 44 cenários passam (21 baseline + 23 novos P6)
  - [ ] Run `npm run lint && npx tsc --noEmit` — 0 erros
  - [ ] Smoke staging: criar venda manual com motivo_categoria, confirmar guarda, validar audit trail em /wms/pedidos/[id]/historico
  - [ ] Verificar cron transferências (aguardar próximo run às 0/6/12/18h)
  - [ ] Verificar cron cleanup operadores zumbi (worker secret invocado a cada 30min via P1 cron)

  ## Coordination notes

  - Deve ser mergeado em paralelo com P3 (overlap leve em lib/wms/inventario.ts — diferentes funções).
  - Equivalente endpoint audit trail (task C.1.8) merge DEPOIS de P2 nesse arquivo específico.
  - decisao_final='rejeitado' (task D.4) merge DEPOIS de P2 (que reescreve aprovar).

  EOF
  )"
  ```

---

## Checklist final pré-merge

- [ ] Todos os 48 findings têm task ID acima
- [ ] Todas as 9 migrations novas aplicadas em staging
- [ ] 23 cenários novos passam isolados
- [ ] 21 cenários baseline ainda passam (zero regressão)
- [ ] `siso_pedido_historico` contém eventos compras
- [ ] `compras-release.ts` não importa nem chama `resolveEmpresaGalpaoId` (renomeada/removida)
- [ ] `vendas-disponibilidade.ts` 0 ocorrências de string "CWB"/"SP"
- [ ] `wms_inventario_sugerir` retorna 0 locs tipo='quarentena' em smoke
- [ ] 3 endpoints deletados retornam 404
- [ ] CLAUDE.md + docs/api-reference-complete.md + docs/database-schema.md atualizados

---

## Coordination summary (post-merge ordering)

1. **P1 merge** — habilita crons (cron P6 cleanup transferências depende do mesmo `app.base_url`).
2. **P3 merge** — desbloqueia P6 tasks E.22, E.37 (post-P3 validation).
3. **P2 merge** — desbloqueia P6 tasks C.1.8 (equivalente audit), C.1.10 (cancelar audit), D.4 (rejeitado), E.4 (devolucao-detector caller updates).
4. **P6 merge** — base final.
5. **P5 merge** — depende de A.2 (saldo-recebimento-orfao endpoint) + A.1 (transferência cron).
6. **P4 merge** — último (auth padronização sobre tudo já estável).
