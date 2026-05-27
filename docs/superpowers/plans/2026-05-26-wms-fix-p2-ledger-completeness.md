# WMS Fix · P2 · Ledger Completeness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore principle PR-1 (ledger is source of truth) and PR-6 (custo médio recalculates on all entries with custo_unitario). Every operational action that changes stock now writes to `siso_movimentacoes` via `wms_inserir_movimentacao`. Fixes 22 findings across compras/separação/vendas/inventário/devoluções/ajustes that silently skipped the ledger.

**Architecture:** Surgical edits in ~20 endpoints + 5 lib files. Each endpoint that mutates stock-state must call `wms_inserir_movimentacao` (or `liberarReserva` for R reversals). One shared helper in `src/lib/wms/separacao/pick-mov.ts` centralizes the par S+L pattern used by both `marcar-item` and `bipar-checklist`. Backfill script for OCs already received pre-fix.

**Tech Stack:** TypeScript, Next.js App Router route handlers, Supabase JS client, existing `wms_inserir_movimentacao` RPC, existing test harness in `scripts/wms/cenarios/`.

**Worktree:** `.claude/worktrees/wms-fix-p2/`. Branch: `wms-fix-p2`. Diverges from `origin/develop`.

**Staging only:** Tests run against Supabase project `ehbxpbeijofxtsbezwxd`. `TINY_DISABLED=true` for E2E.

**Dependency note:** P2 can run parallel to P1/P3/P6. P4 (auth) should merge AFTER P2 to avoid conflict on handler tops.

---

## 0. Setup

### Task 0.1 — Create worktree, install deps, baseline test run

- [ ] Create the worktree:
  ```bash
  git worktree add /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p2 -b wms-fix-p2 origin/develop
  ```
- [ ] Switch into worktree:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p2
  ```
- [ ] Install deps (the worktree shares `node_modules` with origin via npm workspaces, but force reinstall to be safe):
  ```bash
  npm install
  ```
- [ ] Verify `.env.test.local` exists (copied from main worktree if needed):
  ```bash
  test -f .env.test.local || echo "MISSING — copy from main worktree before running scenarios"
  ```
- [ ] Run the baseline scenario suite — must pass 21/21 (cenários 01..21) BEFORE making any change:
  ```bash
  npm run scenarios 2>&1 | tee /tmp/baseline-p2.log
  grep -E "PASS|FAIL|TOTAL" /tmp/baseline-p2.log | tail -20
  ```
- [ ] If any baseline scenario FAILS, STOP — investigate and fix before continuing. The plan assumes a clean baseline.

### Task 0.2 — Confirm Supabase project + WMS_AS_SOURCE state

- [ ] Print current env to confirm staging:
  ```bash
  grep NEXT_PUBLIC_SUPABASE_URL .env.local || grep NEXT_PUBLIC_SUPABASE_URL .env.test
  ```
  Must contain `ehbxpbeijofxtsbezwxd`. If not, STOP.
- [ ] Confirm flags:
  ```bash
  grep WMS_AS_SOURCE .env.local .env.test 2>/dev/null
  ```
  Default behavior post-cutover is `true`. Tests assume `wmsAsSource() === true`.

### Task 0.3 — Commit baseline marker

- [ ] Create empty commit to mark P2 starting point:
  ```bash
  git commit --allow-empty -m "chore(wms-fix-p2): baseline marker — 21/21 cenários verdes pré-P2"
  ```

---

## 1. Pre-req · investigate `siso_movimentacoes.nota_fiscal_id` type (R5)

### Task 1.1 — Query schema, decide fate of finding 6.18 / 2.25

- [ ] Run schema check via Supabase MCP:
  ```sql
  SELECT column_name, data_type, udt_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'siso_movimentacoes'
    AND column_name IN ('nota_fiscal_id', 'chave_acesso_nf');
  ```
- [ ] Capture output in a temporary file `/tmp/p2-r5-result.txt` for later reference.
- [ ] Branch on result:
  - **If `data_type = 'uuid'`** → escalate finding 6.18 to **ALTO runtime bug**. Tasks 8.1..8.3 (devoluções uuid handling) are MANDATORY and FIRST priority after compras.
  - **If `data_type = 'text'`** → finding 6.18 is **descartado**. The Zod validation in `ledger.ts:123` (`assertUuidLike(input.nota_fiscal_id, ...)`) must be REMOVED (it rejects valid bigint-stringified IDs that devoluções pass legitimately). Tasks 8.2 (uuid lookup) becomes "remove validation" only.
- [ ] Record the decision at the top of `docs/superpowers/plans/2026-05-26-wms-fix-p2-ledger-completeness.md` (this file) under a new section "## R5 Decision Log" with the date and chosen branch.
- [ ] Commit:
  ```bash
  git add docs/superpowers/plans/2026-05-26-wms-fix-p2-ledger-completeness.md
  git commit -m "chore(wms-fix-p2): R5 nota_fiscal_id schema decision logged"
  ```

---

## 2. Helper extraction · `src/lib/wms/separacao/pick-mov.ts` (BEFORE bipar-checklist fix)

### Task 2.1 — Write unit test for `pickMovPicking` helper

- [ ] Create `/Users/eryk/Documents/ESTOQUE/src/lib/wms/separacao/pick-mov.test.ts` with the following test (testing pure logic with injected deps, no Supabase):
  ```typescript
  import { describe, it, expect, vi } from "vitest";
  import { pickMovPicking, type PickMovDeps } from "./pick-mov";

  function fakeDeps(overrides: Partial<PickMovDeps> = {}): PickMovDeps {
    return {
      resolverProdutoWms: vi.fn().mockResolvedValue("prod-uuid"),
      resolverLocalizacaoWms: vi.fn().mockResolvedValue("loc-uuid"),
      buscarLocComMaiorSaldoNoGalpao: vi.fn().mockResolvedValue("live-loc-uuid"),
      buscarSnapshotLoc: vi.fn().mockResolvedValue(null),
      buscarReservaPendente: vi.fn().mockResolvedValue(null),
      liberarReservaPicking: vi.fn().mockResolvedValue({ id: "L-mov-id" }),
      inserirMov: vi.fn().mockResolvedValue({ id: "S-mov-id" }),
      registrarLinks: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  describe("pickMovPicking", () => {
    it("returns null when empresa or galpão missing", async () => {
      const deps = fakeDeps();
      const result = await pickMovPicking(
        { empresa_origem_id: null, galpao_id: "g", pedido_id: "p", pedido_numero: "n", item_id: 1, produto_id_tiny: "t", sku: "s", qty: 1, usuario_id: "u" },
        deps,
      );
      expect(result).toBeNull();
      expect(deps.inserirMov).not.toHaveBeenCalled();
    });

    it("uses snapshot loc when present", async () => {
      const deps = fakeDeps({
        buscarSnapshotLoc: vi.fn().mockResolvedValue("A-01-01"),
      });
      const result = await pickMovPicking(
        { empresa_origem_id: "e", galpao_id: "g", pedido_id: "p", pedido_numero: "n", item_id: 1, produto_id_tiny: "t", sku: "s", qty: 3, usuario_id: "u" },
        deps,
      );
      expect(result?.movSaidaId).toBe("S-mov-id");
      expect(deps.resolverLocalizacaoWms).toHaveBeenCalledWith("g", "A-01-01");
    });

    it("falls back to live loc when snapshot empty", async () => {
      const deps = fakeDeps();
      const result = await pickMovPicking(
        { empresa_origem_id: "e", galpao_id: "g", pedido_id: "p", pedido_numero: "n", item_id: 1, produto_id_tiny: "t", sku: "s", qty: 3, usuario_id: "u" },
        deps,
      );
      expect(deps.buscarLocComMaiorSaldoNoGalpao).toHaveBeenCalled();
      expect(result?.movSaidaId).toBe("S-mov-id");
    });

    it("liberates R reservation when present (par L+S)", async () => {
      const deps = fakeDeps({
        buscarReservaPendente: vi.fn().mockResolvedValue({ id: "R-mov-id", quantidade: 5 }),
      });
      const result = await pickMovPicking(
        { empresa_origem_id: "e", galpao_id: "g", pedido_id: "p", pedido_numero: "n", item_id: 1, produto_id_tiny: "t", sku: "s", qty: 3, usuario_id: "u" },
        deps,
      );
      expect(deps.liberarReservaPicking).toHaveBeenCalled();
      expect(result?.movLiberacaoId).toBe("L-mov-id");
      expect(result?.movSaidaId).toBe("S-mov-id");
    });

    it("registers links for both L and S when both created", async () => {
      const deps = fakeDeps({
        buscarReservaPendente: vi.fn().mockResolvedValue({ id: "R-mov-id", quantidade: 5 }),
      });
      await pickMovPicking(
        { empresa_origem_id: "e", galpao_id: "g", pedido_id: "p", pedido_numero: "n", item_id: 1, produto_id_tiny: "t", sku: "s", qty: 3, usuario_id: "u" },
        deps,
      );
      expect(deps.registrarLinks).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ tipo_link: "liberacao_reserva" }),
          expect.objectContaining({ tipo_link: "saida" }),
        ]),
      );
    });
  });
  ```
- [ ] Run test, must FAIL with "Cannot find module './pick-mov'":
  ```bash
  npx vitest run src/lib/wms/separacao/pick-mov.test.ts 2>&1 | tail -15
  ```

### Task 2.2 — Create the helper module `pick-mov.ts`

- [ ] Create `/Users/eryk/Documents/ESTOQUE/src/lib/wms/separacao/pick-mov.ts` with:
  ```typescript
  import { createServiceClient } from "@/lib/supabase-server";
  import { logger } from "@/lib/logger";
  import { inserirMovimentacao } from "@/lib/wms/ledger";
  import {
    buscarReservaPendente,
    liberarReservaPicking,
  } from "@/lib/wms/reservas-picking";
  import {
    resolverProdutoWms,
    resolverLocalizacaoWms,
    buscarLocComMaiorSaldoNoGalpao,
  } from "@/lib/separacao/wms-mapping";

  /**
   * Centraliza o par (L?+S) gerado quando um item é "picado" — seja via
   * checkbox (marcar-item), bipe individual (bipar), ou bipe agregado de
   * checklist (bipar-checklist). Sem este helper, o caminho do checklist
   * pula o ledger inteiramente — bug ALTO #2.5 (dupla baixa pós-cutover).
   *
   * O caller passa contexto do item (pedido, sku, qty, usuario) e o helper:
   * 1. Resolve produto WMS via empresa+tinyProdutoId
   * 2. Resolve loc destino (snapshot → live → DEFAULT-PICKING)
   * 3. Procura R pendente daquela tripla pro pedido
   * 4. Se R existe: emite L (liberacao_reserva) + S pareados
   *    Se não: emite só S (com warn log — caminho legado/órfão)
   * 5. Registra ambos em siso_pedido_item_mov_links pra estorno simétrico
   *
   * Retorna { movSaidaId, movLiberacaoId } ou null se contexto incompleto
   * (sem empresa_origem ou sem galpão — ainda em modo legacy).
   */

  export interface PickMovInput {
    empresa_origem_id: string | null;
    galpao_id: string | null;
    pedido_id: string;
    pedido_numero: string;
    item_id: number;
    produto_id_tiny: string;
    sku: string;
    qty: number;
    usuario_id: string;
    /** Contexto descritivo pro origem_detalhes (ex: "checkbox", "bipe", "checklist"). */
    contexto?: string;
  }

  export interface PickMovResult {
    movSaidaId: string;
    movLiberacaoId: string | null;
    tripla: { produto_id: string; galpao_id: string; localizacao_id: string };
  }

  export interface PickMovDeps {
    resolverProdutoWms: (empresaId: string, tinyId: string) => Promise<string>;
    resolverLocalizacaoWms: (galpaoId: string, codigo: string | null) => Promise<string>;
    buscarLocComMaiorSaldoNoGalpao: (galpaoId: string, produtoUuid: string) => Promise<string | null>;
    buscarSnapshotLoc: (pedidoId: string, produtoIdTiny: string, empresaId: string) => Promise<string | null>;
    buscarReservaPendente: (args: { pedido_id: string; tripla: { produto_id: string; galpao_id: string; localizacao_id: string } }) => Promise<{ id: string; quantidade: number } | null>;
    liberarReservaPicking: (args: {
      reserva: { id: string; quantidade: number };
      qty: number;
      pedido_id: string;
      motivo: string;
      usuario_id: string;
      origem_detalhes: Record<string, unknown>;
    }) => Promise<{ id: string }>;
    inserirMov: typeof inserirMovimentacao;
    registrarLinks: (links: Array<{ pedido_item_id: number; realocacao_id: null; mov_id: string; qty: number; tipo_link: "saida" | "liberacao_reserva" }>) => Promise<void>;
  }

  function defaultDeps(): PickMovDeps {
    const sb = createServiceClient();
    return {
      resolverProdutoWms,
      resolverLocalizacaoWms,
      buscarLocComMaiorSaldoNoGalpao,
      buscarSnapshotLoc: async (pedidoId, produtoIdTiny, empresaId) => {
        const { data } = await sb
          .from("siso_pedido_item_estoques")
          .select("localizacao")
          .eq("pedido_id", pedidoId)
          .eq("produto_id", produtoIdTiny)
          .eq("empresa_id", empresaId)
          .maybeSingle();
        return (data?.localizacao as string | null | undefined) ?? null;
      },
      buscarReservaPendente,
      liberarReservaPicking,
      inserirMov: inserirMovimentacao,
      registrarLinks: async (links) => {
        if (links.length === 0) return;
        const { error } = await sb.from("siso_pedido_item_mov_links").insert(links);
        if (error) {
          logger.warn("pick-mov", "falhou criar links (continua)", { error: error.message });
        }
      },
    };
  }

  export async function pickMovPicking(
    input: PickMovInput,
    deps: PickMovDeps = defaultDeps(),
  ): Promise<PickMovResult | null> {
    if (!input.empresa_origem_id || !input.galpao_id || input.qty <= 0) {
      return null;
    }

    const produtoWmsId = await deps.resolverProdutoWms(
      input.empresa_origem_id,
      input.produto_id_tiny,
    );

    const snapshotLoc = await deps.buscarSnapshotLoc(
      input.pedido_id,
      input.produto_id_tiny,
      input.empresa_origem_id,
    );

    let locId: string;
    if (snapshotLoc) {
      locId = await deps.resolverLocalizacaoWms(input.galpao_id, snapshotLoc);
    } else {
      const liveLocId = await deps.buscarLocComMaiorSaldoNoGalpao(input.galpao_id, produtoWmsId);
      locId = liveLocId ?? (await deps.resolverLocalizacaoWms(input.galpao_id, null));
    }

    const tripla = {
      produto_id: produtoWmsId,
      galpao_id: input.galpao_id,
      localizacao_id: locId,
    };

    let movLiberacaoId: string | null = null;
    const reserva = await deps.buscarReservaPendente({ pedido_id: input.pedido_id, tripla });
    if (reserva) {
      const movL = await deps.liberarReservaPicking({
        reserva,
        qty: input.qty,
        pedido_id: input.pedido_id,
        motivo: `Picking pedido #${input.pedido_numero} — libera reserva (${input.contexto ?? "pick"})`,
        usuario_id: input.usuario_id,
        origem_detalhes: {
          pedido_numero: input.pedido_numero,
          pedido_item_id: input.item_id,
          sku: input.sku,
          contexto: input.contexto ?? "pick",
        },
      });
      movLiberacaoId = movL.id;
    } else {
      logger.warn("pick-mov", "R não encontrada — S sem L par", {
        pedido_id: input.pedido_id,
        item_id: input.item_id,
        tripla,
      });
    }

    const movS = await deps.inserirMov({
      tripla,
      tipo: "S",
      qty: input.qty,
      origem_tipo: "nf_venda",
      origem_detalhes: {
        pedido_id_tiny: input.pedido_id,
        pedido_numero: input.pedido_numero,
        pedido_item_id: input.item_id,
        sku: input.sku,
        contexto: input.contexto ?? "pick",
        reserva_origem: reserva?.id ?? null,
      },
      empresa_vendedora_id: input.empresa_origem_id,
      motivo: `Picking pedido #${input.pedido_numero} — ${input.contexto ?? "pick"}`,
      usuario_id: input.usuario_id,
    });

    const links: Array<{
      pedido_item_id: number;
      realocacao_id: null;
      mov_id: string;
      qty: number;
      tipo_link: "saida" | "liberacao_reserva";
    }> = [];
    if (movLiberacaoId) {
      links.push({
        pedido_item_id: input.item_id,
        realocacao_id: null,
        mov_id: movLiberacaoId,
        qty: input.qty,
        tipo_link: "liberacao_reserva",
      });
    }
    links.push({
      pedido_item_id: input.item_id,
      realocacao_id: null,
      mov_id: movS.id,
      qty: input.qty,
      tipo_link: "saida",
    });
    await deps.registrarLinks(links);

    return {
      movSaidaId: movS.id,
      movLiberacaoId,
      tripla,
    };
  }
  ```
- [ ] Run test, must PASS:
  ```bash
  npx vitest run src/lib/wms/separacao/pick-mov.test.ts 2>&1 | tail -10
  ```
- [ ] Commit:
  ```bash
  git add src/lib/wms/separacao/pick-mov.ts src/lib/wms/separacao/pick-mov.test.ts
  git commit -m "feat(wms/separacao): extrai helper pickMovPicking compartilhado por marcar-item/bipar-checklist (#2.5)"
  ```

---

## 3. Compras (findings 3.1, 3.2, 3.4, 3.7) — biggest scope, unblocks cutover

### Task 3.1 — Scenario 22: receber compra grava mov E `nf_compra`

- [ ] Create `/Users/eryk/Documents/ESTOQUE/scripts/wms/cenarios/catalogo/22-receber-compra-grava-mov.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "22 — Receber compra grava mov E nf_compra (ledger)",
    descricao:
      "OC criada via produto-esgotado → comprar → receber. Receber deve " +
      "gerar mov E (nf_compra) com custo_unitario, atualizando siso_estoque " +
      "e siso_custo_medio. Bloqueio crítico pós-cutover.",
    tags: ["compras", "receber", "ledger", "custo-medio", "wms-as-source"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("22");
      await ctx.criarProduto({ sku, descricao: "Compra 22" });
      // sem semear saldo — webhook vai pra OC
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const pedido = await ctx.webhook({
        empresa: ctx.staging.empresas.netair.cnpj,
        items: [{ sku, qty: 4 }],
      });
      await ctx.aguardarStatus(pedido.id, "pendente");
      await ctx.aprovar(pedido.id, "oc");

      // Compra fluxo
      const ordem = await ctx.comprar({ sku, qty: 4, pedido_id: pedido.id });
      await ctx.receberCompra({
        ordem_id: ordem.ordem_id,
        items: [{ sku, qty: 4 }],
      });
    },

    assertEsperado: async (ctx, { sku }) => {
      // Saldo entrou em CWB (galpão da empresa NetAir) numa loc de
      // RECEBIMENTO ou na loc default da OC.
      const { data: estoques } = await ctx.sb
        .from("siso_estoque")
        .select("saldo, localizacao_id, siso_localizacoes!inner(codigo)")
        .eq("galpao_id", ctx.staging.galpoes.cwb.id)
        .gt("saldo", 0);
      const total = (estoques ?? []).reduce(
        (s, e) => s + Number(e.saldo),
        0,
      );
      if (total < 4) {
        throw new Error(
          `saldo total esperado >=4, recebido ${total}. Provavelmente mov E nf_compra não foi gravada.`,
        );
      }

      // Custo médio deve ter sido atualizado (siso_custo_medio populado pra produto)
      const { data: produto } = await ctx.sb
        .from("siso_produtos")
        .select("id")
        .eq("sku", sku)
        .single();
      const { data: cm } = await ctx.sb
        .from("siso_custo_medio")
        .select("custo_medio")
        .eq("produto_id", produto!.id)
        .maybeSingle();
      // Custo só atualiza se receber-compra passou custo_unitario.
      // Cenário valida só presença — recalculo aritmético em cenário 24.
      if (!cm) {
        throw new Error("siso_custo_medio sem entrada — recálculo não disparou");
      }
    },
  } satisfies Cenario<{ sku: string }>;

  import { runStandalone } from "../_harness/standalone";
  const _isMain = (() => {
    try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
    catch { return false; }
  })();
  if (_isMain) {
    void (async () => {
      const mod = await import(import.meta.url);
      await runStandalone(mod.default);
    })();
  }
  ```
- [ ] Note: this cenário requires harness support for `receberCompra` with `custo_unitario`. If `Ctx.receberCompra` signature doesn't accept it, default to `0` for now — the assertion still works because it only checks `siso_custo_medio` presence.
- [ ] Run cenário, MUST FAIL because `receber` doesn't write the ledger:
  ```bash
  npx tsx scripts/wms/cenarios/catalogo/22-receber-compra-grava-mov.ts 2>&1 | tail -20
  ```
- [ ] Expected failure message will mention `saldo total esperado >=4, recebido 0`.

### Task 3.2 — Implement fix in `compras/receber` (finding 3.1)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/compras/receber/route.ts:1-153` (full file).
- [ ] Replace the entire file with a version that:
  1. Accepts optional `custo_unitario` and `localizacao_destino_codigo` per item in body.
  2. For each `(sku, quantidade_recebida)`, after updating `compra_quantidade_recebida` on items, calls `wms_inserir_movimentacao` (tipo `E`, origem_tipo `nf_compra`) once per pedido aged-allocation chunk, into the **RECEBIMENTO** location of the pedido's galpão.
  3. Resolves galpão via `pedido.empresa_origem_id → empresa.preferred galpao` OR `pedido.separacao_galpao_id` (prefer the latter).
  4. Looks up `produto_id` (uuid WMS) via `siso_produto_empresas` JOIN on `(empresa_id=empresa_origem_id, tiny_produto_id=item.produto_id)`.
  5. Resolves RECEBIMENTO loc via `siso_localizacoes WHERE galpao_id=X AND tipo='recebimento'` (first match) — DO NOT auto-create.
  6. Tags mov with `empresa_compradora_id = pedido.empresa_origem_id`, `fornecedor_id` if available via `item.fornecedor_oc` lookup in `siso_fornecedores`, `nota_fiscal_id` if available.
  7. On per-item mov failure, logs ALTO + sets `compra_estoque_lancado_alerta=true` on pedido + does NOT break the loop (other items may succeed).
- [ ] Full replacement code:
  ```typescript
  import { NextRequest, NextResponse } from "next/server";
  import { createServiceClient } from "@/lib/supabase-server";
  import { logger } from "@/lib/logger";
  import { getSessionUser } from "@/lib/session";
  import { checkAndReleasePedidos } from "@/lib/compras-release";
  import { userCan } from "@/lib/permissions";
  import { inserirMovimentacao } from "@/lib/wms/ledger";
  import { wmsAsSource } from "@/lib/wms/flags";

  /**
   * POST /api/wms/compras/receber
   *
   * Confirms receiving of purchased items. Supports partial receiving.
   * Allocates received qty to orders by aging (oldest first).
   * Identifies and releases orders where all purchase items are now received.
   *
   * Body: {
   *   itens: Array<{
   *     sku: string,
   *     quantidade_recebida: number,
   *     observacao?: string,
   *     custo_unitario?: number,
   *     nota_fiscal_id?: string | null,
   *   }>
   * }
   */
  export async function POST(request: NextRequest) {
    const session = await getSessionUser(request);
    if (!session) {
      return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
    }
    if (!userCan(session, "compras.executar")) {
      return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
    }

    const body = await request.json();
    const itens = body.itens as
      | Array<{
          sku: string;
          quantidade_recebida: number;
          observacao?: string;
          custo_unitario?: number;
          nota_fiscal_id?: string | null;
        }>
      | undefined;

    if (!itens || !Array.isArray(itens) || itens.length === 0) {
      return NextResponse.json(
        { error: "Envie { itens: [{ sku, quantidade_recebida }] }" },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();
    const allAffectedItemIds: string[] = [];
    const recebimentoLog: Array<{
      sku: string;
      itens_atualizados: number;
      quantidade_alocada: number;
      movs_geradas: number;
      movs_falhas: number;
    }> = [];

    try {
      for (const { sku, quantidade_recebida, observacao, custo_unitario, nota_fiscal_id } of itens) {
        if (!sku || quantidade_recebida <= 0) continue;

        const { data: orderItems, error: fetchErr } = await supabase
          .from("siso_pedido_itens")
          .select(
            "id, pedido_id, produto_id, compra_quantidade_solicitada, compra_quantidade_recebida, compra_quantidade_comprada, quantidade_pedida, fornecedor_oc, siso_pedidos(criado_em, empresa_origem_id, separacao_galpao_id, nota_fiscal_id)",
          )
          .eq("sku", sku)
          .eq("compra_status", "comprado");

        if (fetchErr || !orderItems || orderItems.length === 0) continue;

        const sorted = [...orderItems].sort((a, b) => {
          const dateA = (a.siso_pedidos as { criado_em?: string } | null)?.criado_em ?? "";
          const dateB = (b.siso_pedidos as { criado_em?: string } | null)?.criado_em ?? "";
          return dateA.localeCompare(dateB);
        });

        let remaining = quantidade_recebida;
        let atualizados = 0;
        let alocado = 0;
        let movsGeradas = 0;
        let movsFalhas = 0;

        for (const item of sorted) {
          if (remaining <= 0) break;

          const qtySolicitada =
            Number(item.compra_quantidade_solicitada ?? 0) ||
            Number(item.quantidade_pedida ?? 0);
          const jaRecebido = Number(item.compra_quantidade_recebida ?? 0);
          const faltante = Math.max(qtySolicitada - jaRecebido, 0);

          if (faltante <= 0) continue;

          const qtyParaEsteItem = Math.min(remaining, faltante);
          const novoRecebido = jaRecebido + qtyParaEsteItem;
          const todosRecebidos = novoRecebido >= qtySolicitada;

          const updateData: Record<string, unknown> = {
            compra_quantidade_recebida: novoRecebido,
          };
          if (todosRecebidos) updateData.compra_status = "recebido";
          if (observacao) updateData.compra_equivalente_observacao = observacao;

          const { error: updateErr } = await supabase
            .from("siso_pedido_itens")
            .update(updateData)
            .eq("id", item.id);

          if (updateErr) {
            logger.error("compras-receber", `Erro ao atualizar item ${item.id}`, {
              error: updateErr.message,
            });
            continue;
          }

          allAffectedItemIds.push(String(item.id));
          remaining -= qtyParaEsteItem;
          atualizados++;
          alocado += qtyParaEsteItem;

          // ───────── Ledger write (PR-1 restore) ─────────
          if (wmsAsSource()) {
            try {
              const ok = await gravarMovEntradaCompra({
                supabase,
                item: {
                  id: String(item.id),
                  produto_id_tiny: String(item.produto_id),
                  sku,
                  pedido_id: item.pedido_id as string,
                  fornecedor_oc: (item.fornecedor_oc as string | null) ?? null,
                  empresa_origem_id:
                    (item.siso_pedidos as { empresa_origem_id?: string } | null)?.empresa_origem_id ?? null,
                  separacao_galpao_id:
                    (item.siso_pedidos as { separacao_galpao_id?: string } | null)?.separacao_galpao_id ?? null,
                  pedido_nota_fiscal_id:
                    (item.siso_pedidos as { nota_fiscal_id?: string | null } | null)?.nota_fiscal_id ?? null,
                },
                qty: qtyParaEsteItem,
                custo_unitario,
                nota_fiscal_id,
                usuario_id: session.id,
              });
              if (ok) movsGeradas++; else movsFalhas++;
            } catch (movErr) {
              movsFalhas++;
              logger.error("compras-receber", "mov E nf_compra falhou", {
                item_id: item.id,
                sku,
                error: movErr instanceof Error ? movErr.message : String(movErr),
              });
              // Marca alerta no pedido pra operador investigar
              await supabase
                .from("siso_pedidos")
                .update({ compra_estoque_lancado_alerta: true })
                .eq("id", item.pedido_id);
            }
          }
        }

        recebimentoLog.push({
          sku,
          itens_atualizados: atualizados,
          quantidade_alocada: alocado,
          movs_geradas: movsGeradas,
          movs_falhas: movsFalhas,
        });
      }

      const pedidosDesbloqueados = await checkAndReleasePedidos(allAffectedItemIds);

      logger.info("compras-receber", "Recebimento confirmado", {
        usuario: session.nome,
        total_skus: recebimentoLog.length,
        total_itens: recebimentoLog.reduce((s, r) => s + r.itens_atualizados, 0),
        total_movs: recebimentoLog.reduce((s, r) => s + r.movs_geradas, 0),
        pedidos_desbloqueados: pedidosDesbloqueados.length,
      });

      return NextResponse.json({
        ok: true,
        recebimento: recebimentoLog,
        pedidos_desbloqueados: pedidosDesbloqueados,
      });
    } catch (err) {
      logger.error("compras-receber", "Erro ao processar recebimento", {
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { error: "Erro interno ao processar recebimento" },
        { status: 500 },
      );
    }
  }

  /**
   * Grava mov E (nf_compra) na loc RECEBIMENTO do galpão da OC.
   * Resolve produto_id WMS via siso_produto_empresas.
   * Tags: empresa_compradora_id, fornecedor_id (best-effort), nota_fiscal_id, custo_unitario.
   * Retorna true se mov gravada com sucesso, false se pré-condição faltou
   * (sem empresa, sem galpão, sem mapeamento de produto, sem loc RECEBIMENTO).
   */
  async function gravarMovEntradaCompra(args: {
    supabase: ReturnType<typeof createServiceClient>;
    item: {
      id: string;
      produto_id_tiny: string;
      sku: string;
      pedido_id: string;
      fornecedor_oc: string | null;
      empresa_origem_id: string | null;
      separacao_galpao_id: string | null;
      pedido_nota_fiscal_id: string | null;
    };
    qty: number;
    custo_unitario?: number;
    nota_fiscal_id?: string | null;
    usuario_id: string;
  }): Promise<boolean> {
    const { supabase, item, qty, custo_unitario, nota_fiscal_id, usuario_id } = args;

    if (!item.empresa_origem_id) {
      logger.warn("compras-receber.mov", "sem empresa_origem_id — skip", { item_id: item.id });
      return false;
    }

    // Galpão: usa separacao_galpao_id se definido, senão preferred da empresa
    let galpaoId = item.separacao_galpao_id;
    if (!galpaoId) {
      const { data: pref } = await supabase
        .from("siso_empresa_galpoes_preferenciais")
        .select("galpao_id")
        .eq("empresa_id", item.empresa_origem_id)
        .limit(1)
        .maybeSingle();
      galpaoId = (pref?.galpao_id as string | null) ?? null;
    }
    if (!galpaoId) {
      logger.warn("compras-receber.mov", "sem galpão resolvido", { item_id: item.id });
      return false;
    }

    // produto WMS uuid
    const { data: map } = await supabase
      .from("siso_produto_empresas")
      .select("produto_id")
      .eq("empresa_id", item.empresa_origem_id)
      .eq("tiny_produto_id", Number(item.produto_id_tiny))
      .maybeSingle();
    const produtoWmsId = map?.produto_id as string | undefined;
    if (!produtoWmsId) {
      logger.warn("compras-receber.mov", "produto não mapeado em siso_produto_empresas", {
        item_id: item.id,
        empresa_id: item.empresa_origem_id,
        tiny_produto_id: item.produto_id_tiny,
      });
      return false;
    }

    // Loc RECEBIMENTO
    const { data: loc } = await supabase
      .from("siso_localizacoes")
      .select("id")
      .eq("galpao_id", galpaoId)
      .eq("tipo", "recebimento")
      .eq("ativo", true)
      .limit(1)
      .maybeSingle();
    const locRecebimentoId = loc?.id as string | undefined;
    if (!locRecebimentoId) {
      logger.warn("compras-receber.mov", "sem loc RECEBIMENTO no galpão — skip", { galpao_id: galpaoId });
      return false;
    }

    // Fornecedor uuid (best-effort)
    let fornecedorId: string | null = null;
    if (item.fornecedor_oc) {
      const { data: forn } = await supabase
        .from("siso_fornecedores")
        .select("id")
        .eq("nome", item.fornecedor_oc)
        .eq("ativo", true)
        .maybeSingle();
      fornecedorId = (forn?.id as string | null) ?? null;
    }

    await inserirMovimentacao({
      tripla: {
        produto_id: produtoWmsId,
        galpao_id: galpaoId,
        localizacao_id: locRecebimentoId,
      },
      tipo: "E",
      qty,
      origem_tipo: "nf_compra",
      origem_id: item.pedido_id,
      origem_detalhes: {
        sku: item.sku,
        pedido_item_id: item.id,
        fornecedor_nome: item.fornecedor_oc,
      },
      empresa_compradora_id: item.empresa_origem_id,
      fornecedor_id: fornecedorId,
      pedido_id: item.pedido_id,
      nota_fiscal_id: nota_fiscal_id ?? item.pedido_nota_fiscal_id ?? null,
      custo_unitario,
      usuario_id,
      motivo: `Recebimento OC pedido ${item.pedido_id} — SKU ${item.sku} x${qty}`,
    });

    return true;
  }
  ```
- [ ] **CRITICAL** — `inserirMovimentacao` validates `pedido_id` as UUID. Real pedido IDs from Tiny are bigint strings (e.g. `"123456789"`), NOT uuid. The `pedido_id` field must be REMOVED from the call (it's text in DB but validator rejects non-UUID). Replace `pedido_id: item.pedido_id,` line above with: omit the field entirely AND keep `origem_id: item.pedido_id,` plus `origem_detalhes.pedido_id` already present.
- [ ] Apply the correction by editing the inserted block: remove the `pedido_id: item.pedido_id,` line and add `pedido_id_tiny: item.pedido_id` inside `origem_detalhes`.
- [ ] Re-run cenário 22, must now PASS:
  ```bash
  npx tsx scripts/wms/cenarios/catalogo/22-receber-compra-grava-mov.ts 2>&1 | tail -20
  ```
- [ ] Commit:
  ```bash
  git add src/app/api/wms/compras/receber/route.ts scripts/wms/cenarios/catalogo/22-receber-compra-grava-mov.ts
  git commit -m "fix(wms/compras): receber grava mov E nf_compra no ledger (#3.1)"
  ```

### Task 3.3 — Scenario 23: comprar cria OC

- [ ] Create `/Users/eryk/Documents/ESTOQUE/scripts/wms/cenarios/catalogo/23-comprar-cria-oc.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "23 — comprar cria siso_ordens_compra (release não falha)",
    descricao:
      "Marca itens como comprado via /compras/comprar. Deve INSERT em " +
      "siso_ordens_compra e setar ordem_compra_id nos itens — senão compras-release " +
      "nunca encontra a OC e o pedido fica preso.",
    tags: ["compras", "comprar", "ordens-compra"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("23");
      await ctx.criarProduto({ sku, descricao: "Comprar 23" });
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const pedido = await ctx.webhook({
        empresa: ctx.staging.empresas.netair.cnpj,
        items: [{ sku, qty: 2 }],
      });
      await ctx.aguardarStatus(pedido.id, "pendente");
      await ctx.aprovar(pedido.id, "oc");
      await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_compra");

      const { data: itensPre } = await ctx.sb
        .from("siso_pedido_itens")
        .select("id, ordem_compra_id, compra_status")
        .eq("pedido_id", pedido.id);
      if ((itensPre ?? []).some((i) => i.ordem_compra_id)) {
        throw new Error("setup: itens já têm ordem_compra_id antes de comprar — inválido");
      }

      const ordem = await ctx.comprar({ sku, qty: 2 });

      const { data: itensPos } = await ctx.sb
        .from("siso_pedido_itens")
        .select("id, ordem_compra_id, compra_status")
        .eq("pedido_id", pedido.id);
      const todosComOC = (itensPos ?? []).every(
        (i) => i.ordem_compra_id && i.compra_status === "comprado",
      );
      if (!todosComOC) {
        throw new Error(
          `comprar não vinculou ordem_compra_id: ${JSON.stringify(itensPos)}`,
        );
      }

      const { data: oc } = await ctx.sb
        .from("siso_ordens_compra")
        .select("id, status")
        .eq("id", ordem.ordem_id)
        .maybeSingle();
      if (!oc) {
        throw new Error("OC retornada pelo /comprar não existe no banco");
      }
    },

    assertEsperado: async (ctx, { sku }) => {
      const { data: ocs } = await ctx.sb
        .from("siso_ordens_compra")
        .select("id, fornecedor, status");
      if ((ocs ?? []).length === 0) {
        throw new Error("Nenhuma OC criada após comprar — bug #3.2");
      }
    },
  } satisfies Cenario<{ sku: string }>;

  import { runStandalone } from "../_harness/standalone";
  const _isMain = (() => {
    try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
    catch { return false; }
  })();
  if (_isMain) {
    void (async () => {
      const mod = await import(import.meta.url);
      await runStandalone(mod.default);
    })();
  }
  ```
- [ ] Run cenário, MUST FAIL because `comprar` doesn't create OC today:
  ```bash
  npx tsx scripts/wms/cenarios/catalogo/23-comprar-cria-oc.ts 2>&1 | tail -20
  ```

### Task 3.4 — Implement fix in `compras/comprar` (finding 3.2)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/compras/comprar/route.ts:88-130` (the inner loop area).
- [ ] After the existing `update().eq("id", item.id)` block (around line 107), add OC find-or-create + linking logic. The full replacement of the inner loop body becomes:
  ```typescript
        for (const item of sorted) {
          if (remaining <= 0) break;

          const qtySolicitada =
            Number(item.compra_quantidade_solicitada ?? 0) ||
            Number(item.quantidade_pedida ?? 0);
          const qtyParaEsteItem = Math.min(remaining, qtySolicitada);

          // Resolve fornecedor + galpao_id pra find-or-create da OC
          const fornecedor =
            (item.fornecedor_oc as string | null) ??
            getFornecedorBySku(sku).fornecedor;
          const pedidoData = item.siso_pedidos as {
            empresa_origem_id?: string;
            separacao_galpao_id?: string | null;
          } | null;
          const empresaOrigemId = pedidoData?.empresa_origem_id ?? null;
          let galpaoId = pedidoData?.separacao_galpao_id ?? null;
          if (!galpaoId && empresaOrigemId) {
            const { data: pref } = await supabase
              .from("siso_empresa_galpoes_preferenciais")
              .select("galpao_id")
              .eq("empresa_id", empresaOrigemId)
              .limit(1)
              .maybeSingle();
            galpaoId = (pref?.galpao_id as string | null) ?? null;
          }

          const ocId = await findOrCreateOC(supabase, {
            fornecedor,
            galpaoId,
            empresaId: empresaOrigemId,
            sku,
          });

          const updatePayload: Record<string, unknown> = {
            compra_status: "comprado",
            compra_quantidade_comprada: qtyParaEsteItem,
            comprado_em: now,
            comprado_por: session.id,
            comprado_por_nome: session.nome,
          };
          if (ocId) updatePayload.ordem_compra_id = ocId;

          const { error: updateErr } = await supabase
            .from("siso_pedido_itens")
            .update(updatePayload)
            .eq("id", item.id);

          if (updateErr) {
            logger.error(
              "compras-comprar",
              `Erro ao marcar item ${item.id} como comprado`,
              { error: updateErr.message },
            );
            continue;
          }

          remaining -= qtyParaEsteItem;
          marcados++;
          alocado += qtyParaEsteItem;
        }
  ```
- [ ] Add the helper `findOrCreateOC` and import `getFornecedorBySku` near the top:
  ```typescript
  import { getFornecedorBySku } from "@/lib/sku-fornecedor";
  ```
  And at the bottom of the file (after the `POST` handler):
  ```typescript
  async function findOrCreateOC(
    supabase: ReturnType<typeof createServiceClient>,
    args: { fornecedor: string; galpaoId: string | null; empresaId: string | null; sku: string },
  ): Promise<string | null> {
    const { fornecedor, galpaoId, empresaId, sku } = args;
    if (!fornecedor) return null;

    let query = supabase
      .from("siso_ordens_compra")
      .select("id")
      .eq("fornecedor", fornecedor)
      .eq("status", "aguardando_compra")
      .limit(1);
    if (galpaoId) query = query.eq("galpao_id", galpaoId);
    else if (empresaId) query = query.eq("empresa_id", empresaId);

    const { data: existing } = await query.maybeSingle();
    if (existing) return existing.id as string;

    const { data: created, error } = await supabase
      .from("siso_ordens_compra")
      .insert({
        fornecedor,
        galpao_id: galpaoId,
        empresa_id: empresaId,
        status: "aguardando_compra",
        observacao: `Criada por /compras/comprar — SKU ${sku}`,
      })
      .select("id")
      .single();
    if (error) {
      logger.warn("compras-comprar", "Erro criando OC", {
        error: error.message,
        fornecedor,
      });
      return null;
    }
    return created.id as string;
  }
  ```
- [ ] Update the response of POST to return `{ ok: true, resultados, ordem_id: <first OC id created or found> }` so the harness can use it. Track `ocId` in the first iteration and surface it:
  ```typescript
  let firstOcId: string | null = null;
  // inside loop after findOrCreateOC: if (!firstOcId && ocId) firstOcId = ocId;
  // in final return:
  return NextResponse.json({ ok: true, resultados, ordem_id: firstOcId });
  ```
- [ ] Re-run cenário 23, must PASS:
  ```bash
  npx tsx scripts/wms/cenarios/catalogo/23-comprar-cria-oc.ts 2>&1 | tail -15
  ```
- [ ] Commit:
  ```bash
  git add src/app/api/wms/compras/comprar/route.ts scripts/wms/cenarios/catalogo/23-comprar-cria-oc.ts
  git commit -m "fix(wms/compras): comprar cria/encontra OC e vincula itens (#3.2)"
  ```

### Task 3.5 — Scenario 24: cancelar pedido com OC recebida estorna saldo

- [ ] Create `/Users/eryk/Documents/ESTOQUE/scripts/wms/cenarios/catalogo/24-cancelar-pedido-oc-recebida.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "24 — Cancelar pedido com OC recebida estorna saldo no ledger",
    descricao:
      "Pedido OC, comprar, receber. Saldo entra no WMS. Cancelar pedido " +
      "agora deve gerar mov S estorno (origem_tipo='estorno', estorno_de=mov_E) — " +
      "senão saldo fica fantasma no galpão sem dono lógico.",
    tags: ["compras", "cancelar", "estorno", "ledger"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("24");
      await ctx.criarProduto({ sku, descricao: "Cancelar OC 24" });
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const pedido = await ctx.webhook({
        empresa: ctx.staging.empresas.netair.cnpj,
        items: [{ sku, qty: 3 }],
      });
      await ctx.aguardarStatus(pedido.id, "pendente");
      await ctx.aprovar(pedido.id, "oc");
      const ordem = await ctx.comprar({ sku, qty: 3 });
      await ctx.receberCompra({ ordem_id: ordem.ordem_id, items: [{ sku, qty: 3 }] });

      // Saldo deve estar +3 antes de cancelar
      const { data: estoqueAntes } = await ctx.sb
        .from("siso_estoque")
        .select("saldo")
        .eq("galpao_id", ctx.staging.galpoes.cwb.id);
      const totalAntes = (estoqueAntes ?? []).reduce((s, e) => s + Number(e.saldo), 0);
      if (totalAntes < 3) throw new Error(`setup: esperava saldo>=3, recebido ${totalAntes}`);

      // Cancela pedido
      await ctx.http.post(`/api/wms/compras/pedidos/${pedido.id}/cancelar`);
    },

    assertEsperado: async (ctx, { sku }) => {
      const { data: produto } = await ctx.sb
        .from("siso_produtos").select("id").eq("sku", sku).single();
      const { data: movs } = await ctx.sb
        .from("siso_movimentacoes")
        .select("tipo, origem_tipo, estorno_de, quantidade")
        .eq("produto_id", produto!.id);

      const movE = (movs ?? []).find((m) => m.tipo === "E" && m.origem_tipo === "nf_compra");
      const movS = (movs ?? []).find(
        (m) => m.tipo === "S" && m.origem_tipo === "estorno" && m.estorno_de === movE?.["id" as keyof typeof m],
      );
      if (!movE) throw new Error("mov E nf_compra ausente");
      if (!movS) throw new Error("mov S estorno ausente — cancelar não estornou (#3.4)");
    },
  } satisfies Cenario<{ sku: string }>;

  import { runStandalone } from "../_harness/standalone";
  const _isMain = (() => {
    try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
    catch { return false; }
  })();
  if (_isMain) {
    void (async () => {
      const mod = await import(import.meta.url);
      await runStandalone(mod.default);
    })();
  }
  ```
- [ ] Run cenário, MUST FAIL:
  ```bash
  npx tsx scripts/wms/cenarios/catalogo/24-cancelar-pedido-oc-recebida.ts 2>&1 | tail -20
  ```

### Task 3.6 — Implement fix in `compras/pedidos/[id]/cancelar` (finding 3.4)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/compras/pedidos/[pedidoId]/cancelar/route.ts:1-120`.
- [ ] Add import at top:
  ```typescript
  import { estornarMovimentacao } from "@/lib/wms/ledger";
  ```
- [ ] Locate the existing code that detects `hadStockEntrada` (around line 69-72). REPLACE it with:
  ```typescript
      const hadStockEntrada = (compraItems ?? []).some(
        (item) => (item.compra_quantidade_recebida ?? 0) > 0,
      );

      // Estorna movs E nf_compra associadas aos itens recebidos (PR-1/PR-2).
      // Sem isso, saldo fica "fantasma" no galpão após cancelar.
      let movsEstornadas = 0;
      const itensComEstoque = (compraItems ?? []).filter(
        (i) => (i.compra_quantidade_recebida ?? 0) > 0,
      );
      if (itensComEstoque.length > 0) {
        for (const item of itensComEstoque) {
          // Carrega TODAS as movs E nf_compra que essa OC/item gerou no ledger
          // (origem_id = pedido_id, origem_detalhes.pedido_item_id = item.id)
          const { data: movsE } = await supabase
            .from("siso_movimentacoes")
            .select("id, estorno_de, origem_detalhes")
            .eq("origem_tipo", "nf_compra")
            .eq("origem_id", pedidoId);
          for (const mov of movsE ?? []) {
            // Pula movs que já têm estorno OU que são elas mesmas estornos
            if (mov.estorno_de) continue;
            const detalhes = (mov.origem_detalhes ?? {}) as { pedido_item_id?: string | number };
            if (String(detalhes.pedido_item_id ?? "") !== String(item.id)) continue;

            try {
              await estornarMovimentacao({
                mov_id: mov.id as string,
                usuario_id: session.id,
                motivo: `Cancelamento pedido ${pedidoId} — estorno de OC recebida`,
              });
              movsEstornadas++;
            } catch (estErr) {
              const msg = estErr instanceof Error ? estErr.message : String(estErr);
              if (/já\s+(é\s+um\s+estorno|foi\s+estornada)/i.test(msg)) {
                continue;
              }
              logger.error("compras-cancelar-pedido", "falha estornando mov", {
                pedidoId,
                mov_id: mov.id,
                error: msg,
              });
            }
          }
        }
        logger.info("compras-cancelar-pedido", "movs E estornadas no cancelamento", {
          pedidoId,
          movs_estornadas: movsEstornadas,
          itens_com_estoque: itensComEstoque.length,
        });
      }
  ```
- [ ] Run cenário 24, must PASS:
  ```bash
  npx tsx scripts/wms/cenarios/catalogo/24-cancelar-pedido-oc-recebida.ts 2>&1 | tail -15
  ```
- [ ] Commit:
  ```bash
  git add src/app/api/wms/compras/pedidos/[pedidoId]/cancelar/route.ts scripts/wms/cenarios/catalogo/24-cancelar-pedido-oc-recebida.ts
  git commit -m "fix(wms/compras): cancelar pedido com OC recebida estorna mov E no ledger (#3.4)"
  ```

### Task 3.7 — Fix `equivalente/confirmar` órfã R (finding 3.7)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts` to understand the flow.
- [ ] Before any state change in the confirm handler, call `liberarReserva` for the original item's R (if existing) — the equivalente becomes a new product and the old R must be released to avoid orphan reservation.
- [ ] Add import:
  ```typescript
  import { liberarReserva } from "@/lib/wms/reservas";
  import { wmsAsSource } from "@/lib/wms/flags";
  ```
- [ ] After fetching `pedido` (or `item.pedido_id`), and BEFORE the SKU/produto swap, add:
  ```typescript
  if (wmsAsSource()) {
    try {
      const liberadas = await liberarReserva({
        pedido_id: String(item.pedido_id),
        motivo: "cancelamento", // equivalente conta como cancelamento da R original
        usuario_id: session.id,
      });
      logger.info("compras-equivalente-confirmar", "Rs liberadas pré-swap", {
        pedido_id: item.pedido_id,
        item_id: item.id,
        liberadas,
      });
    } catch (e) {
      logger.warn("compras-equivalente-confirmar", "falha liberando R (segue)", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  ```
- [ ] No new cenário here (covered by invariante I4 "sem reservas órfãs"). Re-run any scenario that touches equivalente OR just run a manual smoke via `npm run scenarios -- --only equivalente` if such a scenario exists.
- [ ] Commit:
  ```bash
  git add src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts
  git commit -m "fix(wms/compras): equivalente/confirmar libera R original antes do swap (#3.7)"
  ```

---

## 4. Separação (findings 2.1-2.6, 2.8, 2.9, 2.12, 2.14)

### Task 4.1 — Scenario 25: bipar-checklist gera par S+L (não duplica)

- [ ] Create `/Users/eryk/Documents/ESTOQUE/scripts/wms/cenarios/catalogo/25-bipar-checklist-gera-mov.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "25 — bipar-checklist gera par S+L (sem dupla baixa)",
    descricao:
      "Wave-picking via bipar-checklist deve gerar par L+S igual ao marcar-item. " +
      "Sem isso, cutover R→S no concluir duplica a baixa.",
    tags: ["separacao", "bipar-checklist", "ledger"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("25");
      await ctx.criarProduto({ sku, descricao: "Bip checklist 25" });
      await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-25", qty: 8 });
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const pedido = await ctx.webhook({
        empresa: ctx.staging.empresas.netair.cnpj,
        items: [{ sku, qty: 2 }],
      });
      await ctx.aguardarStatus(pedido.id, "concluido");
      await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
      await ctx.iniciarSeparacao(pedido.id);

      // Usa /bipar-checklist (não /bipar do item)
      await ctx.http.post("/api/wms/separacao/bipar-checklist", {
        sku,
        pedido_ids: [pedido.id],
      });

      await ctx.concluirSeparacao(pedido.id);
      await ctx.aguardarStatusSeparacao(pedido.id, "separado");
    },

    assertEsperado: async (ctx, { sku }) => {
      // Saldo: seed 8 - 2 = 6
      await ctx.assertSaldo(sku, "CWB", "A-01-25", 6);
      // Movs: 1 E (seed) + 1 R (aprovar) + 1 L (bipar-checklist) + 1 S (bipar-checklist) = 4
      await ctx.assertMovsCount(sku, 4);
    },
  } satisfies Cenario<{ sku: string }>;

  import { runStandalone } from "../_harness/standalone";
  const _isMain = (() => {
    try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
    catch { return false; }
  })();
  if (_isMain) {
    void (async () => {
      const mod = await import(import.meta.url);
      await runStandalone(mod.default);
    })();
  }
  ```
- [ ] Run cenário, MUST FAIL (expect 2 movs E+R, no L+S):
  ```bash
  npx tsx scripts/wms/cenarios/catalogo/25-bipar-checklist-gera-mov.ts 2>&1 | tail -20
  ```

### Task 4.2 — Implement fix in `bipar-checklist` using `pickMovPicking` (finding 2.5)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/separacao/bipar-checklist/route.ts:1-112` (full file).
- [ ] Add `getSessionUser` + `pickMovPicking` imports:
  ```typescript
  import { getSessionUser } from "@/lib/session";
  import { pickMovPicking } from "@/lib/wms/separacao/pick-mov";
  ```
- [ ] At the start of the handler add session check; before the existing `update().in("id", itemIds)` block (line 79), call `pickMovPicking` for each `item`. Replace the block from line 75 onwards with:
  ```typescript
      const itemIds = items.map((i) => i.id);
      const now = new Date().toISOString();

      // Carrega contexto adicional dos pedidos (empresa, galpao, numero)
      const pedidoIdsAfetados = [...new Set(items.map((i) => i.pedido_id as string))];
      const { data: pedidosCtx } = await supabase
        .from("siso_pedidos")
        .select("id, numero, empresa_origem_id, separacao_galpao_id")
        .in("id", pedidoIdsAfetados);
      const ctxMap = new Map<string, { numero: string; empresa: string | null; galpao: string | null }>(
        (pedidosCtx ?? []).map((p) => [
          p.id as string,
          {
            numero: (p.numero as string) ?? "",
            empresa: (p.empresa_origem_id as string | null) ?? null,
            galpao: (p.separacao_galpao_id as string | null) ?? null,
          },
        ]),
      );

      // Carrega produto_id (tiny bigint) + quantidade_pedida por item pra mov
      const { data: itemsFull } = await supabase
        .from("siso_pedido_itens")
        .select("id, pedido_id, produto_id, sku, quantidade_pedida, quantidade_pega, separacao_parcial")
        .in("id", itemIds);

      // Por item: emite par S+L via pickMovPicking (idempotente — se já marcado, skip)
      let movsGeradas = 0;
      const movSaidaIds: Record<string, string> = {};
      for (const item of itemsFull ?? []) {
        if (item.separacao_parcial) continue; // parcial usa fluxo separado
        const ctx = ctxMap.get(item.pedido_id as string);
        if (!ctx) continue;
        const qtyJaPega = Number(item.quantidade_pega ?? 0);
        const qtyADescontar = Number(item.quantidade_pedida ?? 0) - qtyJaPega;
        if (qtyADescontar <= 0) continue;

        const result = await pickMovPicking({
          empresa_origem_id: ctx.empresa,
          galpao_id: ctx.galpao,
          pedido_id: String(item.pedido_id),
          pedido_numero: ctx.numero,
          item_id: Number(item.id),
          produto_id_tiny: String(item.produto_id),
          sku: String(item.sku),
          qty: qtyADescontar,
          usuario_id: session.id,
          contexto: "checklist",
        });
        if (result) {
          movsGeradas++;
          movSaidaIds[String(item.id)] = result.movSaidaId;
        }
      }

      // Marca todos os itens (atualiza separacao_marcado, qty_pega, mov_saida_id)
      for (const item of itemsFull ?? []) {
        const updates: Record<string, unknown> = {
          separacao_marcado: true,
          separacao_marcado_em: now,
          quantidade_pega: item.quantidade_pedida,
        };
        const movId = movSaidaIds[String(item.id)];
        if (movId) updates.mov_saida_id = movId;
        await supabase.from("siso_pedido_itens").update(updates).eq("id", item.id);
      }

      const { data: updated } = await supabase
        .from("siso_pedido_itens")
        .select()
        .in("id", itemIds);
  ```
- [ ] Also add session check at handler entry (before body parse):
  ```typescript
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  ```
- [ ] Run cenário 25, must PASS:
  ```bash
  npx tsx scripts/wms/cenarios/catalogo/25-bipar-checklist-gera-mov.ts 2>&1 | tail -15
  ```
- [ ] Commit:
  ```bash
  git add src/app/api/wms/separacao/bipar-checklist/route.ts scripts/wms/cenarios/catalogo/25-bipar-checklist-gera-mov.ts
  git commit -m "fix(wms/separacao): bipar-checklist gera par S+L via pickMovPicking (#2.5)"
  ```

### Task 4.3 — Scenario 26: validar-oc-item "encontrei" gera par S+L

- [ ] Create `/Users/eryk/Documents/ESTOQUE/scripts/wms/cenarios/catalogo/26-validar-oc-encontrei-mov.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "26 — validar-oc-item 'encontrei' gera par S+L",
    descricao:
      "Pedido OC, depois op encontra fisicamente o item — deve gerar par S+L " +
      "como qualquer pick normal, senão a baixa nunca ocorre no ledger.",
    tags: ["separacao", "validar-oc-item", "encontrei", "ledger"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("26");
      await ctx.criarProduto({ sku, descricao: "Encontrei 26" });
      // Sem saldo → vai pra OC
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const pedido = await ctx.webhook({
        empresa: ctx.staging.empresas.netair.cnpj,
        items: [{ sku, qty: 1 }],
      });
      await ctx.aguardarStatus(pedido.id, "pendente");
      await ctx.aprovar(pedido.id, "oc");
      await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_compra");

      // Agora "encontra" — pre-condição: precisa ter saldo agora (ajuste pra setup do estoque)
      await ctx.ajusteManual({
        sku, galpao: "CWB", loc: "DEFAULT-PICKING", delta: 1,
        motivo: "Achado físico antes da OC chegar",
      });

      // Fetch item id
      const { data: item } = await ctx.sb
        .from("siso_pedido_itens")
        .select("id").eq("pedido_id", pedido.id).single();

      await ctx.http.post("/api/wms/separacao/validar-oc-item", {
        item_ids: [item!.id],
        acao: "encontrei",
      });
    },

    assertEsperado: async (ctx, { sku }) => {
      // Saldo: ajuste +1 - encontrei -1 = 0
      await ctx.assertSaldo(sku, "CWB", "DEFAULT-PICKING", 0);
      const { data: produto } = await ctx.sb
        .from("siso_produtos").select("id").eq("sku", sku).single();
      const { data: movs } = await ctx.sb
        .from("siso_movimentacoes")
        .select("tipo, origem_tipo")
        .eq("produto_id", produto!.id);
      const movsS = (movs ?? []).filter((m) => m.tipo === "S" && m.origem_tipo === "nf_venda");
      if (movsS.length === 0) {
        throw new Error("encontrei não gerou mov S nf_venda — bug #2.6");
      }
    },
  } satisfies Cenario<{ sku: string }>;

  import { runStandalone } from "../_harness/standalone";
  const _isMain = (() => {
    try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
    catch { return false; }
  })();
  if (_isMain) {
    void (async () => {
      const mod = await import(import.meta.url);
      await runStandalone(mod.default);
    })();
  }
  ```
- [ ] Run, MUST FAIL.

### Task 4.4 — Implement fix in `validar-oc-item` acao=encontrei (finding 2.6)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/separacao/validar-oc-item/route.ts:84-119` (the `encontrei` branch).
- [ ] Add import:
  ```typescript
  import { pickMovPicking } from "@/lib/wms/separacao/pick-mov";
  ```
- [ ] Replace the loop `if (acao === "encontrei") { for (const item of items) { ... } }` with a version that calls `pickMovPicking` BEFORE the row update:
  ```typescript
      if (acao === "encontrei") {
        // Pre-fetch pedido contexto pra cada item (empresa + galpão + numero)
        const pedidoIds = [...new Set(items.map((i) => i.pedido_id as string))];
        const { data: pedidosCtx } = await supabase
          .from("siso_pedidos")
          .select("id, numero, empresa_origem_id, separacao_galpao_id")
          .in("id", pedidoIds);
        const ctxMap = new Map<string, { numero: string; empresa: string | null; galpao: string | null }>(
          (pedidosCtx ?? []).map((p) => [
            p.id as string,
            {
              numero: (p.numero as string) ?? "",
              empresa: (p.empresa_origem_id as string | null) ?? null,
              galpao: (p.separacao_galpao_id as string | null) ?? null,
            },
          ]),
        );

        // Re-fetch items pra ter produto_id (Tiny bigint)
        const { data: itensFull } = await supabase
          .from("siso_pedido_itens")
          .select("id, pedido_id, produto_id, sku, quantidade_pedida")
          .in("id", items.map((i) => i.id));

        for (const item of itensFull ?? []) {
          const ctx = ctxMap.get(item.pedido_id as string);
          let movSaidaId: string | null = null;
          if (ctx) {
            try {
              const result = await pickMovPicking({
                empresa_origem_id: ctx.empresa,
                galpao_id: ctx.galpao,
                pedido_id: String(item.pedido_id),
                pedido_numero: ctx.numero,
                item_id: Number(item.id),
                produto_id_tiny: String(item.produto_id),
                sku: String(item.sku),
                qty: Number(item.quantidade_pedida ?? 0),
                usuario_id: user.id,
                contexto: "encontrei_oc",
              });
              movSaidaId = result?.movSaidaId ?? null;
            } catch (movErr) {
              logger.warn("validar-oc-item", "pickMovPicking falhou em encontrei", {
                item_id: item.id,
                error: movErr instanceof Error ? movErr.message : String(movErr),
              });
            }
          }

          const updates: Record<string, unknown> = {
            compra_status: null,
            fornecedor_oc: null,
            compra_quantidade_solicitada: null,
            compra_solicitada_em: null,
            ordem_compra_id: null,
            separacao_marcado: true,
            bipado_completo: true,
            quantidade_bipada: Number(item.quantidade_pedida ?? 0),
            quantidade_pega: Number(item.quantidade_pedida ?? 0),
          };
          if (movSaidaId) updates.mov_saida_id = movSaidaId;

          const { error: updErr } = await supabase
            .from("siso_pedido_itens")
            .update(updates)
            .eq("id", item.id);
          if (updErr) {
            logger.logError({
              error: updErr,
              source: "validar-oc-item",
              message: `Erro ao atualizar item ${item.id} (encontrei)`,
              category: "database",
            });
            continue;
          }
          itensAtualizados++;

          registrarEvento({
            pedidoId: item.pedido_id,
            evento: "oc_item_encontrado",
            usuarioId: user.id,
            usuarioNome: user.nome,
            detalhes: { sku: item.sku, item_id: item.id, mov_saida_id: movSaidaId },
          });
        }
      } else if (acao === "desfazer_encontrei") {
  ```
- [ ] Run cenário 26, must PASS:
  ```bash
  npx tsx scripts/wms/cenarios/catalogo/26-validar-oc-encontrei-mov.ts 2>&1 | tail -15
  ```
- [ ] Commit:
  ```bash
  git add src/app/api/wms/separacao/validar-oc-item/route.ts scripts/wms/cenarios/catalogo/26-validar-oc-encontrei-mov.ts
  git commit -m "fix(wms/separacao): validar-oc-item 'encontrei' gera par S+L (#2.6)"
  ```

### Task 4.5 — Scenario 27: separacao/encaminhar libera R + estorna WMS

- [ ] Create `/Users/eryk/Documents/ESTOQUE/scripts/wms/cenarios/catalogo/27-encaminhar-libera-reserva.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "27 — encaminhar libera reserva WMS",
    descricao:
      "Pedido aprovado (R criada). Encaminhar pra outro galpão deve liberar " +
      "a R (via liberarReserva), senão fica órfã. Invariante I4 valida.",
    tags: ["separacao", "encaminhar", "reserva", "ledger"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("27");
      await ctx.criarProduto({ sku, descricao: "Encaminhar 27" });
      await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-27", qty: 5 });
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const pedido = await ctx.webhook({
        empresa: ctx.staging.empresas.netair.cnpj,
        items: [{ sku, qty: 2 }],
      });
      await ctx.aguardarStatus(pedido.id, "concluido");
      await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
      await ctx.iniciarSeparacao(pedido.id);

      await ctx.http.post("/api/wms/separacao/encaminhar", {
        pedido_ids: [pedido.id],
        galpao_destino_id: ctx.staging.galpoes.sp.id,
      });
    },

    assertEsperado: async (ctx, { sku }) => {
      // Reservado deve voltar a 0
      await ctx.assertReservado(sku, "CWB", "A-01-27", 0);
      await ctx.assertSemReservasOrfas();
    },
  } satisfies Cenario<{ sku: string }>;

  import { runStandalone } from "../_harness/standalone";
  const _isMain = (() => {
    try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
    catch { return false; }
  })();
  if (_isMain) {
    void (async () => {
      const mod = await import(import.meta.url);
      await runStandalone(mod.default);
    })();
  }
  ```
- [ ] Run, MUST FAIL on `assertReservado` (reserva orfã).

### Task 4.6 — Implement fix in `separacao/encaminhar` (finding 2.9)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/separacao/encaminhar/route.ts:309-339` (reverseStockExecution).
- [ ] Add import:
  ```typescript
  import { liberarReserva } from "@/lib/wms/reservas";
  import { wmsAsSource } from "@/lib/wms/flags";
  ```
- [ ] In `reverseStockExecution`, at the very top (before any return), add:
  ```typescript
    // PR-1: libera R do pedido no WMS antes de qualquer reversa Tiny.
    // Sem isso, R fica zumbi e re-aprovação no destino falha por reservado>saldo.
    if (wmsAsSource()) {
      try {
        const liberadas = await liberarReserva({
          pedido_id: String(pedido.id),
          motivo: "cancelamento",
        });
        logger.info(LOG_SOURCE, `Rs liberadas no encaminhar: ${liberadas}`, {
          pedidoId: pedido.id,
        });
      } catch (e) {
        logger.warn(LOG_SOURCE, "falha liberando Rs (segue com reverse)", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  ```
- [ ] Also handle the case where `estoque_lancado=false` but reservas existed — move the `if (!pedido.estoque_lancado) return;` check to AFTER the `liberarReserva` call.
- [ ] Run cenário 27, must PASS:
  ```bash
  npx tsx scripts/wms/cenarios/catalogo/27-encaminhar-libera-reserva.ts 2>&1 | tail -15
  ```
- [ ] Commit:
  ```bash
  git add src/app/api/wms/separacao/encaminhar/route.ts scripts/wms/cenarios/catalogo/27-encaminhar-libera-reserva.ts
  git commit -m "fix(wms/separacao): encaminhar libera R do pedido antes de reverse Tiny (#2.9)"
  ```

### Task 4.7 — Scenario 28: DELETE realocação libera R cascade

- [ ] Create `/Users/eryk/Documents/ESTOQUE/scripts/wms/cenarios/catalogo/28-delete-realocacao-libera-r.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "28 — DELETE realocação cancelada libera R cascade",
    descricao:
      "Quando uma realocação aguardando_picking é cancelada, qualquer R " +
      "criada pra ela deve ser liberada via liberarReserva. Hoje só muda " +
      "status — R fica órfã.",
    tags: ["separacao", "realocacao", "reserva", "cascade"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("28");
      await ctx.criarProduto({ sku, descricao: "Realoc 28" });
      await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-28", qty: 3 });
      await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "B-01-28", qty: 5 });
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const pedido = await ctx.webhook({
        empresa: ctx.staging.empresas.netair.cnpj,
        items: [{ sku, qty: 3 }],
      });
      await ctx.aguardarStatus(pedido.id, "concluido");
      await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");
      await ctx.iniciarSeparacao(pedido.id);

      // Faz parcial qty=1 + loc_zerou → cria realocação cascade pra B-01-28
      await ctx.parcial({ pedido: pedido.id, item: sku, qty: 1, loc_zerou: true });
      await ctx.aguardarRealocacao(pedido.id, sku, "B-01-28");

      const { data: realoc } = await ctx.sb
        .from("siso_pedido_item_realocacoes")
        .select("id")
        .eq("status", "aguardando_picking")
        .limit(1)
        .single();

      // DELETE realocação
      await ctx.http.delete(`/api/wms/separacao/realocacao/${realoc!.id}`);
    },

    assertEsperado: async (ctx, { sku }) => {
      await ctx.assertSemReservasOrfas();
    },
  } satisfies Cenario<{ sku: string }>;

  import { runStandalone } from "../_harness/standalone";
  const _isMain = (() => {
    try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
    catch { return false; }
  })();
  if (_isMain) {
    void (async () => {
      const mod = await import(import.meta.url);
      await runStandalone(mod.default);
    })();
  }
  ```
- [ ] Run, MUST FAIL with órfãs.

### Task 4.8 — Implement fix in `realocacao/[id]` DELETE (finding 2.10 in spec / 2.5 in P2)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/separacao/realocacao/[id]/route.ts:1-133` (full).
- [ ] Add imports:
  ```typescript
  import { liberarReserva } from "@/lib/wms/reservas";
  import { wmsAsSource } from "@/lib/wms/flags";
  ```
- [ ] After successfully marking `cancelado` (after the `updErr` check), and BEFORE the response, add:
  ```typescript
      // PR-1: libera R associadas à realocação cancelada (cascade)
      if (wmsAsSource() && item) {
        try {
          const liberadas = await liberarReserva({
            pedido_id: String(item.pedido_id),
            motivo: "cancelamento",
            usuario_id: session.id,
          });
          logger.info("separacao-realocacao-cancel", "Rs liberadas no cancel da chain", {
            pedido_id: item.pedido_id,
            realoc_root: realocId,
            chain_size: todos.length,
            liberadas,
          });
        } catch (e) {
          logger.warn("separacao-realocacao-cancel", "falha liberando Rs (segue)", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
  ```
- [ ] Note: `liberarReserva` libera TODAS as R do pedido. Isso é seguro porque DELETE realocação implica que o item perdeu sua cobertura — qualquer R associada perdeu sentido. Se o cenário precisar de granularidade finer-grained, refinar pra `estornarReservaIndividual` por reserva_id.
- [ ] Run cenário 28, must PASS.
- [ ] Commit:
  ```bash
  git add src/app/api/wms/separacao/realocacao/[id]/route.ts scripts/wms/cenarios/catalogo/28-delete-realocacao-libera-r.ts
  git commit -m "fix(wms/separacao): DELETE realocação libera R cascade (#2.10)"
  ```

### Task 4.9 — Scenario 29: produto-esgotado/encaminhar estorna S+L

- [ ] Create `/Users/eryk/Documents/ESTOQUE/scripts/wms/cenarios/catalogo/29-produto-esgotado-encaminhar-estorna.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "29 — produto-esgotado encaminhar estorna S+L emitidas",
    descricao:
      "Op faz pick parcial → emite S+L → SKU acaba → escolhe encaminhar. " +
      "Movs S+L emitidas devem ser ESTORNADAS antes de trocar galpão. " +
      "Hoje só reseta flags — saldo fica fantasma no galpão antigo.",
    tags: ["separacao", "produto-esgotado", "encaminhar", "estorno"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("29");
      await ctx.criarProduto({ sku, descricao: "Esgotado-Enc 29" });
      await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-29", qty: 1 });
      await ctx.semearSaldo({ produto: sku, galpao: "SP", loc: "X-01-29", qty: 5 });
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const pedido = await ctx.webhook({
        empresa: ctx.staging.empresas.netair.cnpj,
        items: [{ sku, qty: 1 }],
      });
      await ctx.aguardarStatus(pedido.id, "concluido");
      await ctx.iniciarSeparacao(pedido.id);
      await ctx.bipar({ pedido: pedido.id, item: sku, qty: 1 });

      // Sem desfazer parcial — apenas marca esgotado pro SKU geral
      await ctx.http.post("/api/wms/separacao/produto-esgotado", {
        sku,
        acao: "encaminhar",
        galpao_destino_id: ctx.staging.galpoes.sp.id,
      });
    },

    assertEsperado: async (ctx, { sku }) => {
      // Saldo CWB volta a 1 (estorno do pick)
      await ctx.assertSaldo(sku, "CWB", "A-01-29", 1);
    },
  } satisfies Cenario<{ sku: string }>;

  import { runStandalone } from "../_harness/standalone";
  const _isMain = (() => {
    try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
    catch { return false; }
  })();
  if (_isMain) {
    void (async () => {
      const mod = await import(import.meta.url);
      await runStandalone(mod.default);
    })();
  }
  ```
- [ ] Run, MUST FAIL — saldo CWB ainda em 0.

### Task 4.10 — Implement fix in `produto-esgotado` encaminhar branch (finding 2.8)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/separacao/produto-esgotado/route.ts:184-250` (encaminhar mode).
- [ ] Add import at top:
  ```typescript
  import { resetarEstadoSeparacaoItens } from "@/lib/separacao/reset-state";
  ```
- [ ] REPLACE the existing `// Reset separation state on ALL items of affected pedidos` block (the `supabase.from("siso_pedido_itens").update({ separacao_marcado: false, ...}).in(...)`) with a call to the canonical helper that ALSO estornates movs:
  ```typescript
        // Fetch ALL item ids of the affected pedidos pra reset completo (estorna S+L)
        const { data: todosItens } = await supabase
          .from("siso_pedido_itens")
          .select("id")
          .in("pedido_id", affectedPedidoIds);
        const todosItemIds = (todosItens ?? []).map((i) => Number(i.id));

        try {
          await resetarEstadoSeparacaoItens({
            supabase,
            itemIds: todosItemIds,
            usuarioId: session.id,
            motivo: "produto_esgotado_encaminhar",
          });
        } catch (resetErr) {
          logger.error("produto-esgotado", "Reset com estorno falhou", {
            error: resetErr instanceof Error ? resetErr.message : String(resetErr),
            affectedPedidoIds,
          });
          return NextResponse.json(
            { error: "Erro ao estornar movs antes de encaminhar" },
            { status: 500 },
          );
        }
  ```
- [ ] Apply the SAME replacement in the OC mode reset block (around line 345-360) — the `if (resetItemsErr) { ... }` block becomes the same `resetarEstadoSeparacaoItens` call with `motivo: "produto_esgotado_oc"`.
- [ ] **Caveat for 2.14 (finding):** `produto-esgotado` mode OC resets ALL items of affected pedidos, not just the esgotado item. With `resetarEstadoSeparacaoItens(todosItemIds)` this is preserved. The spec calls this out as a bug — the FIX is to scope to only items matching `sku`. Modify the call to `itemIds: itemIds` (the matchingItems IDs, not `todosItemIds`) in the OC branch:
  ```typescript
  // OC branch: só reseta itens do SKU esgotado, não pedido inteiro (#2.14)
  await resetarEstadoSeparacaoItens({
    supabase,
    itemIds: itemIds.map((id) => Number(id)),
    usuarioId: session.id,
    motivo: "produto_esgotado_oc",
  });
  ```
- [ ] Run cenário 29, must PASS:
  ```bash
  npx tsx scripts/wms/cenarios/catalogo/29-produto-esgotado-encaminhar-estorna.ts 2>&1 | tail -15
  ```
- [ ] Commit:
  ```bash
  git add src/app/api/wms/separacao/produto-esgotado/route.ts scripts/wms/cenarios/catalogo/29-produto-esgotado-encaminhar-estorna.ts
  git commit -m "fix(wms/separacao): produto-esgotado encaminhar/oc estorna S+L via resetarEstado (#2.8, #2.14)"
  ```

### Task 4.11 — Fix `separacao/localizacao` para escrever WMS (finding 2.7)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/separacao/localizacao/route.ts:1-85` (full file).
- [ ] The current implementation updates Tiny + `siso_pedido_item_estoques` legacy snapshot. **Goal:** ADDITIONALLY (não substituir) escrever em `siso_estoque.localizacao_id` via mov par S+E (`origem_tipo='transferencia_localizacao'`) quando o produto já tem saldo em uma loc do galpão.
- [ ] This is a transferência intra-galpão: from old_loc to new_loc. We need:
  1. The galpão (currently not passed in the body — must be added). Add `galpao_id` to required body fields.
  2. Resolve produto WMS via `siso_produto_empresas`.
  3. Resolve new loc via `siso_localizacoes` (create if not exists, picking tipo).
  4. Find existing rows in `siso_estoque WHERE produto_id=X AND galpao_id=Y AND saldo>0` — those are the sources to migrate.
  5. For each source: emit `S` from source loc + `E` to destination loc, sharing `origem_id` (one uuid per migration).
- [ ] Full replacement code:
  ```typescript
  import { NextRequest, NextResponse } from "next/server";
  import { createServiceClient } from "@/lib/supabase-server";
  import { logger } from "@/lib/logger";
  import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
  import { atualizarLocalizacaoProduto } from "@/lib/tiny-api";
  import { runWithEmpresa } from "@/lib/tiny-queue";
  import { getSessionUser } from "@/lib/session";
  import { inserirMovimentacao } from "@/lib/wms/ledger";
  import { wmsAsSource } from "@/lib/wms/flags";
  import { resolverLocalizacaoWms } from "@/lib/separacao/wms-mapping";

  /**
   * POST /api/separacao/localizacao
   *
   * Updates a product's warehouse location (localização) in Tiny ERP, in the
   * local DB snapshot, AND in siso_estoque (3D) via mov par S+E
   * (origem_tipo='transferencia_localizacao').
   *
   * Body: {
   *   produto_id: number (Tiny bigint),
   *   localizacao: string (new loc code),
   *   empresa_id: string,
   *   galpao_id?: string (preferred; resolved from empresa if absent)
   * }
   */
  export async function POST(request: NextRequest) {
    const session = await getSessionUser(request);
    if (!session) {
      return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const produtoId = body?.produto_id;
    const localizacao = body?.localizacao;
    const empresaId = body?.empresa_id;
    let galpaoId: string | null = body?.galpao_id ?? null;

    if (!produtoId || typeof produtoId !== "number") {
      return NextResponse.json({ error: "Campo 'produto_id' (number) obrigatorio" }, { status: 400 });
    }
    if (typeof localizacao !== "string") {
      return NextResponse.json({ error: "Campo 'localizacao' (string) obrigatorio" }, { status: 400 });
    }
    if (!empresaId || typeof empresaId !== "string") {
      return NextResponse.json({ error: "Campo 'empresa_id' (string) obrigatorio" }, { status: 400 });
    }

    const supabase = createServiceClient();
    const trimmed = localizacao.trim();

    try {
      // 1. Tiny update
      const { token } = await getValidTokenByEmpresa(empresaId);
      await runWithEmpresa(empresaId, () =>
        atualizarLocalizacaoProduto(token, produtoId, trimmed),
      );

      // 2. Snapshot legado
      await supabase
        .from("siso_pedido_item_estoques")
        .update({ localizacao: trimmed || null })
        .eq("produto_id", produtoId)
        .eq("empresa_id", empresaId);

      // 3. WMS — transferir saldos pra nova loc
      let transferencias = 0;
      if (wmsAsSource() && trimmed) {
        if (!galpaoId) {
          const { data: pref } = await supabase
            .from("siso_empresa_galpoes_preferenciais")
            .select("galpao_id")
            .eq("empresa_id", empresaId)
            .limit(1)
            .maybeSingle();
          galpaoId = (pref?.galpao_id as string | null) ?? null;
        }
        if (galpaoId) {
          const { data: map } = await supabase
            .from("siso_produto_empresas")
            .select("produto_id")
            .eq("empresa_id", empresaId)
            .eq("tiny_produto_id", Number(produtoId))
            .maybeSingle();
          const produtoWmsId = map?.produto_id as string | undefined;
          if (produtoWmsId) {
            const novaLocId = await resolverLocalizacaoWms(galpaoId, trimmed);
            const { data: sources } = await supabase
              .from("siso_estoque")
              .select("localizacao_id, saldo, reservado")
              .eq("produto_id", produtoWmsId)
              .eq("galpao_id", galpaoId)
              .gt("saldo", 0);
            for (const src of sources ?? []) {
              if (src.localizacao_id === novaLocId) continue;
              const qty = Number(src.saldo);
              const origemId = crypto.randomUUID();
              try {
                await inserirMovimentacao({
                  tripla: { produto_id: produtoWmsId, galpao_id: galpaoId, localizacao_id: src.localizacao_id as string },
                  tipo: "S",
                  qty,
                  origem_tipo: "transferencia_localizacao",
                  origem_id: origemId,
                  origem_detalhes: { contexto: "atualizar_localizacao_produto", destino_loc_id: novaLocId },
                  usuario_id: session.id,
                  motivo: `Mudança de loc — produto ${produtoId} pra ${trimmed}`,
                });
                await inserirMovimentacao({
                  tripla: { produto_id: produtoWmsId, galpao_id: galpaoId, localizacao_id: novaLocId },
                  tipo: "E",
                  qty,
                  origem_tipo: "transferencia_localizacao",
                  origem_id: origemId,
                  origem_detalhes: { contexto: "atualizar_localizacao_produto", origem_loc_id: src.localizacao_id },
                  usuario_id: session.id,
                });
                transferencias++;
              } catch (transferErr) {
                logger.error("localizacao", "transferencia_localizacao falhou", {
                  produtoId,
                  galpaoId,
                  error: transferErr instanceof Error ? transferErr.message : String(transferErr),
                });
              }
            }
          }
        }
      }

      logger.info("localizacao", "Localizacao atualizada", {
        produtoId,
        empresaId,
        localizacao: trimmed,
        transferencias,
      });

      return NextResponse.json({ ok: true, transferencias });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("localizacao", "Erro ao atualizar localizacao", {
        produtoId,
        empresaId,
        error: msg,
      });
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }
  ```
- [ ] No new dedicated cenário; this is exercised indirectly when separação flows call it. Manual smoke optional.
- [ ] Commit:
  ```bash
  git add src/app/api/wms/separacao/localizacao/route.ts
  git commit -m "fix(wms/separacao): localizacao escreve mov par S+E em siso_estoque (#2.7)"
  ```

### Task 4.12 — Fix `concluir` cobertura OC misto (finding 2.11)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/separacao/concluir/route.ts:117-145` (the cobertura check area).
- [ ] In the existing check that decides whether to allow `status_separacao='separado'`, add a stricter validation: for OC items that should have been picked-after-receive, verify EVERY non-cancelled item has `separacao_marcado=true` OR `compra_quantidade_recebida >= quantidade_pedida`.
- [ ] Add the guard:
  ```typescript
  // PR-1 safety: bloqueia conclusão se algum item OC ainda não foi totalmente
  // coberto pelo recebimento (qty_recebida < qty_pedida) — evita 'separado' mentir.
  const itensIncompletosOC = (itens ?? []).filter((i) => {
    if (i.compra_status === "cancelado") return false;
    if (i.compra_status === null) return false; // item normal — outras validações cuidam
    const recebido = Number(i.compra_quantidade_recebida ?? 0);
    const pedido = Number(i.quantidade_pedida ?? 0);
    return recebido < pedido;
  });
  if (itensIncompletosOC.length > 0) {
    return NextResponse.json(
      {
        error: "cobertura_oc_insuficiente",
        detalhe: "Há itens OC não totalmente recebidos — não pode concluir.",
        itens: itensIncompletosOC.map((i) => ({
          sku: i.sku,
          recebido: Number(i.compra_quantidade_recebida ?? 0),
          pedido: Number(i.quantidade_pedida ?? 0),
        })),
      },
      { status: 409 },
    );
  }
  ```
- [ ] Place this AFTER the existing item fetch (`const { data: itens } = await supabase.from("siso_pedido_itens")...`) and BEFORE the `update({ status_separacao: 'separado' })` call.
- [ ] No new cenário (covered by cenário 22+ via fallout).
- [ ] Commit:
  ```bash
  git add src/app/api/wms/separacao/concluir/route.ts
  git commit -m "fix(wms/separacao): concluir bloqueia se itens OC com cobertura parcial (#2.11)"
  ```

### Task 4.13 — Fix `bipar-embalagem` cutover prematuro (finding 2.12)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/separacao/bipar-embalagem/route.ts` (full).
- [ ] Locate the "cutover" trigger — usually a call to convert R→L+S (or `executarCutoverWms`) when `pedido_completo === true` or similar RPC return value.
- [ ] Wrap the trigger with a guard:
  ```typescript
  // Só dispara cutover quando NF está emitida E todos os itens estão picados.
  // Sem essa dupla checagem, RPC `pedido_completo=true` pode disparar mesmo
  // quando algum item OC veio sem qty_pedida cumprida.
  const { data: pedidoComp } = await supabase
    .from("siso_pedidos")
    .select("nota_fiscal_id, chave_acesso_nf, status_separacao")
    .eq("id", pedidoId)
    .single();
  const nfPresente = !!(pedidoComp?.nota_fiscal_id && pedidoComp?.chave_acesso_nf);
  const { data: faltantes } = await supabase
    .from("siso_pedido_itens")
    .select("id, separacao_marcado, compra_status, quantidade_pedida, quantidade_pega")
    .eq("pedido_id", pedidoId)
    .neq("compra_status", "cancelado")
    .or("separacao_marcado.eq.false,quantidade_pega.is.null");
  const allPicked = (faltantes ?? []).length === 0;
  if (pedidoCompleto && nfPresente && allPicked) {
    // ... (existing cutover trigger)
  }
  ```
- [ ] If file structure differs from above (RPC abstraction varies), preserve existing logic but add the `nfPresente && allPicked` checks before the cutover branch.
- [ ] No dedicated cenário (would require very specific OC mid-flight setup).
- [ ] Commit:
  ```bash
  git add src/app/api/wms/separacao/bipar-embalagem/route.ts
  git commit -m "fix(wms/separacao): bipar-embalagem exige NF+all-picked antes do cutover (#2.12)"
  ```

### Task 4.14 — Fix `confirmar-item-embalagem` OC direta sem NF (finding 2.13/2.9 spec)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/separacao/confirmar-item-embalagem/route.ts`.
- [ ] Apply the same NF-presence guard before any cutover RPC call:
  ```typescript
  const { data: pedidoCheck } = await supabase
    .from("siso_pedidos")
    .select("nota_fiscal_id")
    .eq("id", pedidoId)
    .single();
  if (!pedidoCheck?.nota_fiscal_id) {
    logger.warn("confirmar-item-embalagem", "cutover skipped — NF ausente", { pedidoId });
    // skip cutover branch — apenas marca o item como embalado
  } else {
    // ... (cutover existing)
  }
  ```
- [ ] Commit:
  ```bash
  git add src/app/api/wms/separacao/confirmar-item-embalagem/route.ts
  git commit -m "fix(wms/separacao): confirmar-item-embalagem só faz cutover se NF presente (#2.13)"
  ```

### Task 4.15 — Fix `concluir-oc` dupla baixa janela (finding 2.15)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/separacao/concluir-oc/route.ts`.
- [ ] The bug: enqueues `lancar_estoque` legacy job AND triggers cutover, causing momentary double deduction window.
- [ ] Fix: when `wmsAsSource()` returns `true`, DO NOT enqueue legacy job — only do cutover (or rely on the standard `concluir` flow that handles cutover atomically).
- [ ] Wrap the legacy `siso_fila_execucao` insert with a `wmsAsSource()` check:
  ```typescript
  if (!wmsAsSource()) {
    // Caminho legacy: enfileira job
    await supabase.from("siso_fila_execucao").insert({ /* ... existing ... */ });
  }
  ```
- [ ] Add the flag import at top:
  ```typescript
  import { wmsAsSource } from "@/lib/wms/flags";
  ```
- [ ] Commit:
  ```bash
  git add src/app/api/wms/separacao/concluir-oc/route.ts
  git commit -m "fix(wms/separacao): concluir-oc evita enqueue legacy quando WMS_AS_SOURCE (#2.15)"
  ```

---

## 5. Vendas / Webhook (findings 1.1 spec / 7.2 / 6.12)

### Task 5.1 — Scenario 30: webhook cancelamento libera R do pedido

- [ ] Create `/Users/eryk/Documents/ESTOQUE/scripts/wms/cenarios/catalogo/30-webhook-cancel-libera-r.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "30 — Webhook cancelamento libera R do pedido",
    descricao:
      "Pedido auto-aprovado (R criada). Tiny envia webhook 'cancelado'. " +
      "Deve liberar R via liberarReserva, senão I4 quebra e próximo pedido " +
      "no mesmo SKU degrada pra OC sem motivo.",
    tags: ["webhook", "cancelamento", "reserva", "ledger"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("30");
      await ctx.criarProduto({ sku, descricao: "Webhook-Cancel 30" });
      await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-30", qty: 5 });
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const pedido = await ctx.webhook({
        empresa: ctx.staging.empresas.netair.cnpj,
        items: [{ sku, qty: 2 }],
      });
      await ctx.aguardarStatus(pedido.id, "concluido");
      await ctx.assertReservado(sku, "CWB", "A-01-30", 2);

      // Tiny webhook cancelamento (mesmo pedidoId, situacao=cancelado)
      await ctx.webhook({
        empresa: ctx.staging.empresas.netair.cnpj,
        items: [{ sku, qty: 2 }],
        pedidoFakeId: Number(String(pedido.id).replace(/\D/g, "")) || undefined,
        // harness deve suportar override de situacao via parâmetro adicional;
        // se não, faz POST direto:
      });

      // Workaround: força status cancelado via webhook direto (fallback)
      await ctx.http.post("/api/wms/webhook/tiny", {
        tipo: "pedido",
        dados: { id: pedido.id, situacao: { codigo: "cancelado" } },
      });
    },

    assertEsperado: async (ctx, { sku }) => {
      await ctx.assertReservado(sku, "CWB", "A-01-30", 0);
      await ctx.assertSemReservasOrfas();
    },
  } satisfies Cenario<{ sku: string }>;

  import { runStandalone } from "../_harness/standalone";
  const _isMain = (() => {
    try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
    catch { return false; }
  })();
  if (_isMain) {
    void (async () => {
      const mod = await import(import.meta.url);
      await runStandalone(mod.default);
    })();
  }
  ```
- [ ] Run, MUST FAIL.

### Task 5.2 — Implement fix in webhook cancelamento (finding 1.1)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/webhook/tiny/route.ts:183-317` (cancellation block).
- [ ] Add import:
  ```typescript
  import { liberarReserva } from "@/lib/wms/reservas";
  import { wmsAsSource } from "@/lib/wms/flags";
  ```
- [ ] After the `existingOrder` is fetched (line 191) and BEFORE the `cancelUpdate` is sent, add the reservation release:
  ```typescript
      if (existingOrder) {
        // PR-1: libera R do pedido cancelado.
        // Sem isso, R fica zumbi consumindo "reservado" no siso_estoque até o
        // cron de cleanup (expira_em). Próximo pedido pro mesmo SKU degrada
        // pra OC erroneamente.
        if (wmsAsSource()) {
          try {
            const liberadas = await liberarReserva({
              pedido_id: String(pedidoId),
              motivo: "cancelamento",
            });
            logger.info("webhook", "Rs liberadas no cancelamento", { pedidoId, liberadas });
          } catch (e) {
            logger.warn("webhook", "falha liberando Rs no cancel (segue)", {
              pedidoId,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        const cancelUpdate: Record<string, unknown> = {
          // ... (existing logic continues unchanged)
  ```
- [ ] Run cenário 30, must PASS:
  ```bash
  npx tsx scripts/wms/cenarios/catalogo/30-webhook-cancel-libera-r.ts 2>&1 | tail -15
  ```
- [ ] Commit:
  ```bash
  git add src/app/api/wms/webhook/tiny/route.ts scripts/wms/cenarios/catalogo/30-webhook-cancel-libera-r.ts
  git commit -m "fix(wms/webhook): cancelamento libera R do pedido (#1.1)"
  ```

### Task 5.3 — Scenario 31: venda modo separação cria R

- [ ] Create `/Users/eryk/Documents/ESTOQUE/scripts/wms/cenarios/catalogo/31-venda-separacao-cria-r.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "31 — Venda modo separação cria R (não corre risco vs marketplace)",
    descricao:
      "Vendedor cria venda modo=separacao. Deve criar R no ledger pra cada item " +
      "(WMS_AS_SOURCE). Senão marketplace concorrente pode pegar saldo e baixa " +
      "do vendedor falha.",
    tags: ["vendas", "separacao", "reserva", "ledger"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("31");
      await ctx.criarProduto({ sku, descricao: "Venda-Sep 31" });
      await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-31", qty: 4 });
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const v = await ctx.criarVendaDireta({
        galpao: "CWB",
        empresa: "netair",
        items: [{ sku, qty: 2 }],
        modo: "separacao",
      });
      // não deve ter degradado (tem saldo)
      if (v.degradado) {
        throw new Error(`venda degradou inesperadamente: ${v.motivo_degradacao}`);
      }
    },

    assertEsperado: async (ctx, { sku }) => {
      // Saldo intacto (R não baixa saldo)
      await ctx.assertSaldo(sku, "CWB", "A-01-31", 4);
      // Reservado = 2 (R foi criada pelo vendas/criar modo separacao)
      await ctx.assertReservado(sku, "CWB", "A-01-31", 2);
    },
  } satisfies Cenario<{ sku: string }>;

  import { runStandalone } from "../_harness/standalone";
  const _isMain = (() => {
    try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
    catch { return false; }
  })();
  if (_isMain) {
    void (async () => {
      const mod = await import(import.meta.url);
      await runStandalone(mod.default);
    })();
  }
  ```
- [ ] Run, MUST FAIL (reservado=0).

### Task 5.4 — Implement fix in `vendas/criar` modo separação (finding 7.2)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/vendas/criar/route.ts:260-294` (the modo separacao path right before items insert).
- [ ] Add imports:
  ```typescript
  import { reservarAtomico, estornarReservaIndividual } from "@/lib/wms/reservas";
  import { wmsAsSource } from "@/lib/wms/flags";
  ```
- [ ] AFTER the `itensRows` insert (around line 285) but BEFORE the baixa_direta branch, add a reservation block (only for modo `separacao`):
  ```typescript
    // 2b. Modo separacao + WMS_AS_SOURCE: cria R atomicamente.
    // Sem isso, marketplace concorrente pode pegar saldo entre a venda manual
    // e o picking, e a baixa do vendedor falha por reservado>saldo.
    const reservasCriadas: string[] = [];
    if (modoEfetivo === "separacao" && wmsAsSource()) {
      try {
        for (const item of itensResolvidos) {
          if (!item.localizacao_id) continue; // sem saldo — segue como pedido sem reserva
          const reservaId = await reservarAtomico({
            tripla: {
              produto_id: item.produto_id,
              galpao_id: galpao_id,
              localizacao_id: item.localizacao_id,
            },
            qty: item.quantidade,
            pedido_id: pedidoId,
            ttl_horas: 24 * 30,
            usuario_id: user.id,
          });
          reservasCriadas.push(reservaId);
        }
      } catch (rErr) {
        // Rollback: estorna parciais + apaga pedido+itens
        for (const rid of reservasCriadas) {
          try {
            await estornarReservaIndividual({ reserva_id: rid, motivo: "rollback_aprovacao", usuario_id: user.id });
          } catch {}
        }
        await supabase.from("siso_pedido_itens").delete().eq("pedido_id", pedidoId);
        await supabase.from("siso_pedidos").delete().eq("id", pedidoId);
        const msg = rErr instanceof Error ? rErr.message : String(rErr);
        return NextResponse.json(
          { erro: `Falha criando reservas: ${msg}`, reservas_estornadas: reservasCriadas.length },
          { status: 409 },
        );
      }
    }
  ```
- [ ] Run cenário 31, must PASS.
- [ ] Commit:
  ```bash
  git add src/app/api/wms/vendas/criar/route.ts scripts/wms/cenarios/catalogo/31-venda-separacao-cria-r.ts
  git commit -m "fix(wms/vendas): vendas/criar modo separacao cria R atomicamente (#7.2)"
  ```

### Task 5.5 — Webhook detecção devolução `tipo='devolucao' OR tipoOperacao='E'` (finding 6.12 spec, 2.12 P2)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/webhook/tiny/route.ts` searching for `handleNfWebhook` (likely imported from `src/lib/nf-webhook-handler.ts`).
- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/lib/nf-webhook-handler.ts` and locate the branch that decides "this NF is a devolução".
- [ ] Centralize the detection into a helper `isDevolucao`:
  ```typescript
  // Em src/lib/nf-webhook-handler.ts, adicione no topo:
  export function isDevolucao(nf: {
    tipo?: string;
    tipoOperacao?: string;
    finalidade?: string;
  }): boolean {
    if (nf.tipo && nf.tipo.toLowerCase() === "devolucao") return true;
    if (nf.tipoOperacao === "E") return true;
    if (nf.finalidade && /devol/i.test(nf.finalidade)) return true;
    return false;
  }
  ```
- [ ] Replace ALL ad-hoc devolução detection in `handleNfWebhook` with `isDevolucao(nfPayload)`. This ensures every branch (with/without pedido linked, with/without chave_acesso) reaches the devolução handler when appropriate.
- [ ] Commit:
  ```bash
  git add src/lib/nf-webhook-handler.ts src/app/api/wms/webhook/tiny/route.ts
  git commit -m "fix(wms/webhook): unifica detecção devolução em isDevolucao helper (#6.12)"
  ```

---

## 6. Aprovar / Loc-search (findings 1.5, 1.6 / 2.2, 2.3 P2)

### Task 6.1 — Fix `buscarLocComMaiorSaldoNoGalpao` para usar `disponivel>0` (finding 2.3)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/lib/separacao/wms-mapping.ts:64-79` (the function).
- [ ] Replace `.gt("saldo", 0)` with `.gt("disponivel", 0)` and `.order("saldo", ...)` with `.order("disponivel", ...)`:
  ```typescript
  export async function buscarLocComMaiorSaldoNoGalpao(
    galpaoId: string,
    produtoUuid: string,
  ): Promise<string | null> {
    const supabase = createServiceClient();
    const { data } = await supabase
      .from("siso_estoque")
      .select("localizacao_id")
      .eq("galpao_id", galpaoId)
      .eq("produto_id", produtoUuid)
      .gt("disponivel", 0)
      .order("disponivel", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.localizacao_id as string | null | undefined) ?? null;
  }
  ```
- [ ] No new cenário — existing cenários (especially 18, 25) cover the path.
- [ ] Run regression: `npx tsx scripts/wms/cenarios/catalogo/18-aprovar-cria-reserva.ts` must still pass.
- [ ] Commit:
  ```bash
  git add src/lib/separacao/wms-mapping.ts
  git commit -m "fix(wms/separacao): buscarLocComMaiorSaldoNoGalpao usa disponivel>0 (#2.3)"
  ```

### Task 6.2 — Scenario 32: aprovar transferência usa rotearPedidoDoBanco

- [ ] Create `/Users/eryk/Documents/ESTOQUE/scripts/wms/cenarios/catalogo/32-aprovar-transferencia-roteamento.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "32 — Aprovar transferência usa rotearPedidoDoBanco (saldo real)",
    descricao:
      "NetAir recebe pedido sem saldo em CWB; NetParts (SP) tem saldo. " +
      "Aprovar como transferência deve escolher SP via rotearPedidoDoBanco " +
      "(geo-priority + saldo real), não via getEmpresasDoGrupo legacy.",
    tags: ["pedidos", "aprovar", "transferencia", "roteamento"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("32");
      await ctx.criarProduto({ sku, descricao: "Transf 32" });
      await ctx.semearSaldo({ produto: sku, galpao: "SP", loc: "X-01-32", qty: 5 });
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const pedido = await ctx.webhook({
        empresa: ctx.staging.empresas.netair.cnpj,
        items: [{ sku, qty: 2 }],
      });
      await ctx.aguardarStatus(pedido.id, "pendente");
      await ctx.aprovar(pedido.id, "transferencia");
      await ctx.aguardarStatus(pedido.id, "executando");
    },

    assertEsperado: async (ctx, { sku }) => {
      const { data: pedidos } = await ctx.sb
        .from("siso_pedidos")
        .select("id, separacao_galpao_id")
        .eq("decisao_final", "transferencia")
        .limit(1);
      const galpaoSep = (pedidos ?? [])[0]?.separacao_galpao_id;
      if (galpaoSep !== ctx.staging.galpoes.sp.id) {
        throw new Error(
          `esperava separacao_galpao_id = SP (${ctx.staging.galpoes.sp.id}), recebido ${galpaoSep}`,
        );
      }
      // R reservada em SP (não CWB)
      await ctx.assertReservado(sku, "SP", "X-01-32", 2);
    },
  } satisfies Cenario<{ sku: string }>;

  import { runStandalone } from "../_harness/standalone";
  const _isMain = (() => {
    try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
    catch { return false; }
  })();
  if (_isMain) {
    void (async () => {
      const mod = await import(import.meta.url);
      await runStandalone(mod.default);
    })();
  }
  ```
- [ ] Run — should already PASS for the SP case (the existing code uses `getEmpresasDoGrupo` which picks `empresa.galpaoId !== empresaOrigem.galpaoId` — SP is the only other option). But the regression is when **multiple support empresas** exist and the existing code picks one without checking saldo. Cenário pode passar hoje — keep as regression sentinel.

### Task 6.3 — Refactor `aprovar` transferência pra usar `rotearPedidoDoBanco` (finding 2.2)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/pedidos/aprovar/route.ts:107-131` (the `transferencia` branch).
- [ ] Add import at top:
  ```typescript
  import { rotearPedidoDoBanco } from "@/lib/wms/roteamento";
  ```
- [ ] Replace the `transferencia` branch (lines 107-131) with:
  ```typescript
    } else {
      // transferencia: usa rotearPedidoDoBanco (geo-priority + saldo real WMS).
      // Substitui o getEmpresasDoGrupo legacy que ignora saldo.

      // Carrega itens pra alimentar roteamento (precisa quantidade)
      const { data: itensParaRotear } = await supabase
        .from("siso_pedido_itens")
        .select("produto_id, quantidade_pedida")
        .eq("pedido_id", pedidoId);

      // Map Tiny produto_id → WMS uuid via empresa origem
      const itens: Array<{ produto_id: string; qty: number }> = [];
      for (const it of itensParaRotear ?? []) {
        const { data: map } = await supabase
          .from("siso_produto_empresas")
          .select("produto_id")
          .eq("empresa_id", pedido.empresa_origem_id)
          .eq("tiny_produto_id", Number(it.produto_id))
          .maybeSingle();
        if (map?.produto_id) {
          itens.push({
            produto_id: map.produto_id as string,
            qty: Number(it.quantidade_pedida ?? 0),
          });
        }
      }

      const rota = await rotearPedidoDoBanco(pedido.empresa_origem_id, itens);

      if (rota.decisao === "transferencia" && rota.galpao_id) {
        // Encontra galpão escolhido
        const { data: galpaoEsc } = await supabase
          .from("siso_galpoes")
          .select("id, nome")
          .eq("id", rota.galpao_id)
          .single();
        // Encontra empresa que tem este galpão como preferred (pra tag)
        const { data: empresaSuporte } = await supabase
          .from("siso_empresa_galpoes_preferenciais")
          .select("empresa_id, siso_empresas!inner(id, nome)")
          .eq("galpao_id", rota.galpao_id)
          .limit(1)
          .maybeSingle();

        empresaExecucaoId = (empresaSuporte?.empresa_id as string | null) ?? pedido.empresa_origem_id;
        filialExecucao = galpaoEsc?.nome ?? filialOrigem;
        separacaoGalpaoId = rota.galpao_id;
      } else {
        // sem cobertura: fallback origem (degrada pra reserva-orphan ou falha em criarReservasPedido)
        empresaExecucaoId = pedido.empresa_origem_id;
        filialExecucao = filialOrigem;
        separacaoGalpaoId = empresaOrigem.galpaoId;
        logger.warn("aprovar", "Roteamento sem cobertura — fallback origem", {
          pedidoId,
          rota_decisao: rota.decisao,
          rota_motivo: (rota as { motivo?: string }).motivo,
        });
      }
    }
  ```
- [ ] Run cenário 32, must PASS.
- [ ] Commit:
  ```bash
  git add src/app/api/wms/pedidos/aprovar/route.ts scripts/wms/cenarios/catalogo/32-aprovar-transferencia-roteamento.ts
  git commit -m "fix(wms/aprovar): transferencia usa rotearPedidoDoBanco (saldo real) (#2.2)"
  ```

---

## 7. Ajuste / Retroativo / Inventário (findings 4.11, 8.4, 8.7)

### Task 7.1 — Scenario 33: aplicar inventário ganho atualiza custo médio

- [ ] Create `/Users/eryk/Documents/ESTOQUE/scripts/wms/cenarios/catalogo/33-inventario-ganho-custo-medio.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "33 — Aplicar inventário com divergência positiva propaga custo médio",
    descricao:
      "Cenário inicial: saldo 0 sem custo médio. Ajusta +10 com custo 5.0 " +
      "(custo médio fica 5.0). Inventário acha 12 (+2 ganho). Aplicar deve " +
      "passar custo_unitario=5.0 (último entrante) pra que o ganho preserve " +
      "custo médio em vez de diluir pra 4.17.",
    tags: ["inventario", "custo-medio", "ledger"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("33");
      await ctx.criarProduto({ sku, descricao: "Inv-Custo 33" });
      await ctx.ajusteManual({
        sku, galpao: "CWB", loc: "A-01-33", delta: 10,
        motivo: "Setup custo 33",
      });
      // Setup direto via SQL: ajuste manual não passa custo_unitario, então
      // pra esse cenário injetamos custo via UPSERT direto em siso_custo_medio.
      const { data: produto } = await ctx.sb
        .from("siso_produtos").select("id").eq("sku", sku).single();
      await ctx.sb.from("siso_custo_medio").upsert({
        produto_id: produto!.id,
        custo_medio: 5.0,
        atualizado_em: new Date().toISOString(),
      });
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const sessao = await ctx.criarSessaoInventario({
        galpao: "CWB", locs: ["A-01-33"], modo: "aberto",
      });
      await ctx.entrarParty(sessao.id);
      await ctx.proximaLoc(sessao.id);
      await ctx.bipeInventario({ sessao_id: sessao.id, sku, loc: "A-01-33", qty: 12 });
      await ctx.finalizarLocInventario({ sessao_id: sessao.id, loc: "A-01-33" });
      await ctx.aprovarInventario(sessao.id);
      await ctx.aplicarInventario(sessao.id);
    },

    assertEsperado: async (ctx, { sku }) => {
      await ctx.assertSaldo(sku, "CWB", "A-01-33", 12);
      // Custo médio deve permanecer 5.0 (ganho com custo_unitario do último entrante)
      await ctx.assertCustoMedio(sku, 5.0, 0.01);
    },
  } satisfies Cenario<{ sku: string }>;

  import { runStandalone } from "../_harness/standalone";
  const _isMain = (() => {
    try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
    catch { return false; }
  })();
  if (_isMain) {
    void (async () => {
      const mod = await import(import.meta.url);
      await runStandalone(mod.default);
    })();
  }
  ```
- [ ] Run, MUST FAIL — custo médio fica errado.

### Task 7.2 — Implement fix in `inventario.ts aplicarSessao` (finding 4.11)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/lib/wms/inventario.ts:805-882` (the `aplicarSessao` function).
- [ ] For each divergência with `tipo === "E"` (ganho), look up the current custo médio in `siso_custo_medio` for that produto and pass it as `custo_unitario` to `inserirMovimentacao` (so the RPC re-computes and stamps `custo_medio_anterior/posterior`).
- [ ] Replace the inner `inserirMovimentacao` call:
  ```typescript
    for (const d of (divergencias ?? []) as DivRow[]) {
      if (Number(d.delta) === 0) continue;
      const tipo: TipoMov = Number(d.delta) > 0 ? "E" : "S";
      const qty = Math.abs(Number(d.delta));

      // PR-6: ganho de inventário precisa carregar custo médio atual pra
      // não diluir. Perda não precisa (S não move custo).
      let custoUnitario: number | undefined;
      if (tipo === "E") {
        const { data: cm } = await sb
          .from("siso_custo_medio")
          .select("custo_medio")
          .eq("produto_id", d.produto_id)
          .maybeSingle();
        if (cm?.custo_medio !== undefined && cm?.custo_medio !== null) {
          custoUnitario = Number(cm.custo_medio);
        }
      }

      const mov = await inserirMovimentacao({
        tripla: {
          produto_id: d.produto_id,
          galpao_id: s.galpao_id,
          localizacao_id: d.localizacao_id,
        },
        tipo,
        qty,
        origem_tipo: tipo === "E" ? "inventario_ganho" : "inventario_perda",
        origem_id: sessaoId,
        origem_detalhes: { divergencia_id: d.id, delta_pct: d.delta_pct },
        custo_unitario: custoUnitario,
        usuario_id: usuarioId,
        motivo: `inventário sessão ${sessaoId}`,
      });
      await sb
        .from("siso_inventario_divergencias")
        .update({ status: "aplicada", mov_aplicada_id: mov.id })
        .eq("id", d.id);
      movsGeradas++;
    }
  ```
- [ ] Run cenário 33, must PASS.
- [ ] Commit:
  ```bash
  git add src/lib/wms/inventario.ts scripts/wms/cenarios/catalogo/33-inventario-ganho-custo-medio.ts
  git commit -m "fix(wms/inventario): aplicarSessao passa custo_unitario em ganhos (#4.11)"
  ```

### Task 7.3 — Fix ajuste manual entrada aceita custo_unitario (finding 8.4)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/ajuste/route.ts:1-76` (full).
- [ ] Add custo_unitario validation + pass-through:
  ```typescript
    const custoUnitario =
      body.custo_unitario !== undefined && body.custo_unitario !== null
        ? Number(body.custo_unitario)
        : undefined;
    if (custoUnitario !== undefined && (!Number.isFinite(custoUnitario) || custoUnitario < 0)) {
      return NextResponse.json(
        { error: "custo_unitario inválido (≥ 0)" },
        { status: 400 },
      );
    }
    try {
      await ajustarEstoque({
        tripla,
        qty,
        motivo,
        direcao: body.direcao,
        custo_unitario: body.direcao === "entrada" ? custoUnitario : undefined,
        usuario_id: auth.user.id,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      // ... existing error handler
    }
  ```
- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/lib/wms/movimentacoes.ts:389-414` (the `ajustarEstoque` function and `AjusteManualInput`).
- [ ] Add `custo_unitario?: number` to `AjusteManualInput`:
  ```typescript
  export interface AjusteManualInput {
    tripla: Tripla;
    qty: number;
    motivo: string;
    direcao: "entrada" | "saida";
    usuario_id: string;
    /** Custo unitário (alimenta recálculo custo médio em entradas). */
    custo_unitario?: number;
  }
  ```
- [ ] Update body of `ajustarEstoque`:
  ```typescript
  export async function ajustarEstoque(input: AjusteManualInput): Promise<void> {
    if (!input.motivo || input.motivo.trim().length < 3) {
      throw new Error("motivo do ajuste é obrigatório (≥3 caracteres)");
    }
    await inserirMovimentacao({
      tripla: input.tripla,
      tipo: input.direcao === "entrada" ? "E" : "S",
      qty: input.qty,
      origem_tipo: "ajuste_manual",
      origem_detalhes: { direcao: input.direcao },
      motivo: input.motivo.trim(),
      custo_unitario: input.direcao === "entrada" ? input.custo_unitario : undefined,
      usuario_id: input.usuario_id,
    });
  }
  ```
- [ ] No new cenário (covered by cenário 33 indirectly).
- [ ] Commit:
  ```bash
  git add src/app/api/wms/ajuste/route.ts src/lib/wms/movimentacoes.ts
  git commit -m "fix(wms/ajuste): aceita custo_unitario em ajuste entrada (PR-6) (#8.4)"
  ```

### Task 7.4 — Lançamento retroativo preserva `data_recebimento` (finding 8.7)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/app/api/wms/lancamento-retroativo/route.ts:1-92` (full).
- [ ] Add `data_recebimento` to body schema (optional ISO date, ≤ now).
- [ ] Pass through to `lancarRetroativo`:
  ```typescript
    const dataRecebimento = body.data_recebimento as string | undefined;
    if (dataRecebimento) {
      const d = new Date(dataRecebimento);
      if (Number.isNaN(d.getTime()) || d.getTime() > Date.now()) {
        return NextResponse.json(
          { error: "data_recebimento inválida ou no futuro" },
          { status: 400 },
        );
      }
    }
    try {
      await lancarRetroativo({
        tripla,
        qty,
        motivo: body.motivo,
        empresa_compradora_id: body.empresa_compradora_id ?? null,
        fornecedor_id: body.fornecedor_id ?? null,
        custo_unitario: custoUnitario,
        pedido_id: body.pedido_id ?? null,
        data_recebimento: dataRecebimento,
        usuario_id: auth.user.id,
      });
      return NextResponse.json({ ok: true });
    }
  ```
- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/lib/wms/movimentacoes.ts:416-453` (LancamentoRetroativoInput + lancarRetroativo).
- [ ] Add field:
  ```typescript
  export interface LancamentoRetroativoInput {
    // ... existing fields
    /** Data efetiva do recebimento (vai pra origem_detalhes.data_recebimento). */
    data_recebimento?: string;
  }
  ```
- [ ] Update body:
  ```typescript
  export async function lancarRetroativo(input: LancamentoRetroativoInput): Promise<void> {
    if (!input.motivo || input.motivo.trim().length < 3) {
      throw new Error("motivo do lançamento retroativo é obrigatório (≥3 caracteres)");
    }
    await inserirMovimentacao({
      tripla: input.tripla,
      tipo: "E",
      qty: input.qty,
      origem_tipo: "lancamento_retroativo",
      origem_detalhes: input.data_recebimento ? { data_recebimento: input.data_recebimento } : undefined,
      pedido_id: input.pedido_id ?? null,
      empresa_compradora_id: input.empresa_compradora_id ?? null,
      fornecedor_id: input.fornecedor_id ?? null,
      custo_unitario: input.custo_unitario,
      motivo: input.motivo.trim(),
      usuario_id: input.usuario_id,
    });
  }
  ```
- [ ] **Note:** carimbar o `criado_em` da mov com `data_recebimento` exige alteração na RPC `wms_inserir_movimentacao` (parâmetro novo p_criado_em). Se for fora de escopo, deixamos a info em `origem_detalhes` apenas — relatórios filtram por `(origem_detalhes->>'data_recebimento')`. Para o presente plano, **stop here** — o criado_em real fica como `now()`.
- [ ] Commit:
  ```bash
  git add src/app/api/wms/lancamento-retroativo/route.ts src/lib/wms/movimentacoes.ts
  git commit -m "fix(wms/retroativo): aceita data_recebimento como tag em origem_detalhes (#8.7)"
  ```

---

## 8. Devoluções (findings 6.13, 6.18, 6.5 spec)

### Task 8.1 — R5 branch decision: handle `nota_fiscal_id` correctly

- [ ] Open the R5 Decision Log from Task 1.1.
- [ ] **If UUID:** proceed with Task 8.2 (UUID lookup) — devoluções must lookup `siso_notas_fiscais` to convert bigint → UUID. If table doesn't exist, schema migration required (out of scope — flag as ALTO).
- [ ] **If TEXT:** skip Task 8.2 entirely. Remove the `assertUuidLike(input.nota_fiscal_id, ...)` line in `src/lib/wms/ledger.ts:123`. Commit:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE/.claude/worktrees/wms-fix-p2
  ```
  Edit `src/lib/wms/ledger.ts` removing `assertUuidLike(input.nota_fiscal_id, "nota_fiscal_id");`. Add comment:
  ```typescript
  // nota_fiscal_id é TEXT por design (siso_movimentacoes.nota_fiscal_id) —
  // aceita bigint stringificado do Tiny. Não validamos como UUID.
  ```
- [ ] Commit:
  ```bash
  git add src/lib/wms/ledger.ts
  git commit -m "fix(wms/ledger): remove validação uuid de nota_fiscal_id (R5 — coluna é text) (#6.18)"
  ```

### Task 8.2 — (Only if R5=UUID) Devoluções convertem `nota_fiscal_id` bigint → uuid

- [ ] In `src/lib/wms/devolucoes.ts`, in `registrarDevolucaoPendente` (lines 39-48), change the lookup:
  ```typescript
  let pedidoOrigemMovId: string | null = null;
  let notaFiscalUuid: string | null = null;
  if (input.nota_fiscal_id) {
    // Tenta resolver UUID via siso_notas_fiscais (se a tabela existir)
    const { data: nfRow } = await sb
      .from("siso_notas_fiscais")
      .select("id")
      .eq("tiny_nf_id", input.nota_fiscal_id)
      .maybeSingle();
    notaFiscalUuid = (nfRow?.id as string | null) ?? null;
    if (notaFiscalUuid) {
      const { data: mov } = await sb
        .from("siso_movimentacoes")
        .select("id")
        .eq("nota_fiscal_id", notaFiscalUuid)
        .eq("tipo", "S")
        .maybeSingle();
      pedidoOrigemMovId = (mov as { id: string } | null)?.id ?? null;
    }
  }
  ```
- [ ] In `classificarDevolucao`, replace every `nota_fiscal_id: d.nota_fiscal_id?.toString() ?? undefined` with the UUID variant: store uuid in `siso_devolucoes_pendentes.nota_fiscal_id_uuid` (add migration if necessary, out of scope — flag to P6).
- [ ] **If table `siso_notas_fiscais` doesn't exist:** add migration `supabase/migrations/20260527_siso_notas_fiscais.sql` (out of scope for this plan — escalate to P6 spec amendment).
- [ ] Commit:
  ```bash
  git add src/lib/wms/devolucoes.ts
  git commit -m "fix(wms/devolucoes): converte nota_fiscal_id bigint→uuid via siso_notas_fiscais (#6.18)"
  ```

### Task 8.3 — Devoluções B/C/D propagam `custo_unitario` (finding 6.13)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/lib/wms/devolucoes.ts:117-240` (the `switch (input.classificacao)`).
- [ ] Currently only Classe A (integro) looks up `custoUnitarioOriginal` from `mov_original`. Hoist that lookup OUT of the `case "integro"` block so it runs for ALL classifications:
  ```typescript
    // Custo unitário da venda original (alimenta recálculo do custo médio em
    // toda Classe — A, B, C, D). Hoist do bloco integro pra raiz do classificar.
    let custoUnitarioOriginal: number | undefined;
    if (d.pedido_origem_mov_id) {
      const { data: movOriginal } = await sb
        .from("siso_movimentacoes")
        .select("custo_unitario")
        .eq("id", d.pedido_origem_mov_id)
        .single();
      const cu = (movOriginal as { custo_unitario: number | null } | null)?.custo_unitario;
      if (cu) custoUnitarioOriginal = Number(cu);
    }

    switch (input.classificacao) {
      case "integro": {
        await inserirMovimentacao({
          // ... custo_unitario: custoUnitarioOriginal,
        });
        break;
      }
      case "avariado": {
        await inserirMovimentacao({
          tripla,
          tipo: "E",
          qty: input.qty,
          origem_tipo: "devolucao_cliente_avariada",
          nota_fiscal_id: d.nota_fiscal_id?.toString() ?? undefined,
          empresa_referencia_id: empresaReferenciaId,
          custo_unitario: custoUnitarioOriginal, // ← novo
          usuario_id: input.usuario_id,
          motivo: input.observacoes,
        });
        // ... resto
        break;
      }
      case "garantia": {
        await inserirMovimentacao({
          tripla,
          tipo: "E",
          qty: input.qty,
          origem_tipo: "devolucao_cliente_integra",
          nota_fiscal_id: d.nota_fiscal_id?.toString() ?? undefined,
          empresa_referencia_id: empresaReferenciaId,
          custo_unitario: custoUnitarioOriginal, // ← novo
          usuario_id: input.usuario_id,
        });
        // ... resto
        break;
      }
      case "troca_sku":
        await inserirMovimentacao({
          tripla,
          tipo: "E",
          qty: input.qty,
          origem_tipo: "devolucao_cliente_integra",
          nota_fiscal_id: d.nota_fiscal_id?.toString() ?? undefined,
          empresa_referencia_id: empresaReferenciaId,
          custo_unitario: custoUnitarioOriginal, // ← novo
          usuario_id: input.usuario_id,
          motivo: `troca SKU: ${input.observacoes ?? ""}`,
        });
        break;
    }
  ```
- [ ] Run cenário 10 + 11 regression (`npx tsx scripts/wms/cenarios/catalogo/10-devolucao-A-recalc-custo.ts` + `11-devolucao-BCD-quarentena.ts`) — both must continue passing.
- [ ] Commit:
  ```bash
  git add src/lib/wms/devolucoes.ts
  git commit -m "fix(wms/devolucoes): propaga custo_unitario em todas as classes (#6.13)"
  ```

### Task 8.4 — Fix `empresa_id` salvada como receptora exposta como referência (finding 6.5 / 2.26 spec)

- [ ] Read `/Users/eryk/Documents/ESTOQUE/src/lib/wms/devolucoes.ts` `registrarDevolucaoPendente` (line 34-64) and any `listar`/`obter` function.
- [ ] **Bug:** the `empresa_id` saved to `siso_devolucoes_pendentes` represents the receiving empresa (where the NF was received), but downstream consumers expose it as `empresa_referencia_id` (the original selling empresa).
- [ ] Fix: rename the saved column to `empresa_receptora_id` semantically (no migration — just stop confusing them in code). In `classificarDevolucao`, the `empresa_referencia_id` must come ONLY from `resolverEmpresaReferencia(mov_original)`, never from `dev.empresa_id`.
- [ ] Verify current code already does this correctly (line 99-109 uses `pedido_origem_mov_id` resolver) — good. Add a comment clarifying:
  ```typescript
  // empresa_referencia_id = vendedora da venda ORIGINAL (mov S nf_venda).
  // NUNCA confundir com siso_devolucoes_pendentes.empresa_id (que é receptora
  // física da devolução — pode ser empresa diferente da que vendeu).
  ```
- [ ] In `listar` and similar selectors, ensure `empresa_id` NEVER aliased as `empresa_referencia_id` in response payloads. If it is, fix the alias.
- [ ] Commit:
  ```bash
  git add src/lib/wms/devolucoes.ts
  git commit -m "fix(wms/devolucoes): clarifica empresa_id (receptora) vs empresa_referencia_id (vendedora original) (#6.5)"
  ```

---

## 9. Backfill script (R1 mitigation)

### Task 9.1 — Create backfill script `scripts/wms/backfill-compras-recebidas.ts`

- [ ] Create `/Users/eryk/Documents/ESTOQUE/scripts/wms/backfill-compras-recebidas.ts`:
  ```typescript
  #!/usr/bin/env tsx
  /**
   * scripts/wms/backfill-compras-recebidas.ts
   *
   * R1 mitigation: cria movs E retroativas pra OCs já recebidas pre-fix do P2.
   *
   * Antes do P2, /api/wms/compras/receber atualizava só
   * siso_pedido_itens.compra_quantidade_recebida sem gravar no ledger. Após o
   * P2, novas chamadas gravam mov E nf_compra. Mas pedidos já recebidos antes
   * têm um "buraco" no ledger — saldo físico não corresponde a siso_estoque.
   *
   * Este script:
   * 1. Lista todos os siso_pedido_itens com compra_quantidade_recebida > 0
   * 2. Verifica se já existe mov E nf_compra associada (origem_id=pedido_id,
   *    origem_detalhes.pedido_item_id=item.id, tipo=E, origem_tipo=nf_compra)
   * 3. Se NÃO existe, cria mov retroativa com:
   *    - tipo=E, origem_tipo=nf_compra
   *    - qty = compra_quantidade_recebida
   *    - loc = RECEBIMENTO do galpão (resolvido via empresa_origem_id)
   *    - empresa_compradora_id = empresa_origem_id
   *    - fornecedor_id = lookup via fornecedor_oc
   *    - custo_unitario = 0 (sem dado histórico)
   *    - motivo = "Backfill P2 — OC recebida pre-fix"
   * 4. Loga skipped items + sucesso + erros
   *
   * Rodar UMA vez após merge do P2 (idempotente — pula items que já têm mov):
   *   npx tsx scripts/wms/backfill-compras-recebidas.ts
   *
   * Dry-run (preview, não escreve):
   *   npx tsx scripts/wms/backfill-compras-recebidas.ts --dry
   */

  import "dotenv/config";
  import { createClient } from "@supabase/supabase-js";
  import { inserirMovimentacao } from "../../src/lib/wms/ledger";

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("Faltam NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const sb = createClient(supabaseUrl, serviceKey);
  const dry = process.argv.includes("--dry");

  interface ItemRecebido {
    id: number;
    pedido_id: string;
    produto_id: number; // Tiny bigint
    sku: string;
    compra_quantidade_recebida: number;
    fornecedor_oc: string | null;
    siso_pedidos: {
      empresa_origem_id: string | null;
      separacao_galpao_id: string | null;
      nota_fiscal_id: string | null;
    } | null;
  }

  async function main() {
    console.log(`Backfill compras recebidas — modo: ${dry ? "DRY RUN" : "EXECUTING"}`);

    const { data: items, error } = await sb
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, compra_quantidade_recebida, fornecedor_oc, siso_pedidos(empresa_origem_id, separacao_galpao_id, nota_fiscal_id)",
      )
      .gt("compra_quantidade_recebida", 0);
    if (error) {
      console.error("erro ao listar items:", error.message);
      process.exit(1);
    }

    const total = items?.length ?? 0;
    console.log(`Items com compra_quantidade_recebida > 0: ${total}`);

    let criadas = 0;
    let puladas = 0;
    let erros = 0;
    let skipsSemEmpresa = 0;
    let skipsSemMapeamento = 0;
    let skipsSemLoc = 0;

    for (const item of (items ?? []) as unknown as ItemRecebido[]) {
      // Idempotência: verifica se já existe mov E nf_compra pra esse item
      const { data: existentes } = await sb
        .from("siso_movimentacoes")
        .select("id, origem_detalhes")
        .eq("origem_tipo", "nf_compra")
        .eq("origem_id", item.pedido_id)
        .eq("tipo", "E");
      const jaExiste = (existentes ?? []).some((m) => {
        const det = (m.origem_detalhes ?? {}) as { pedido_item_id?: string | number };
        return String(det.pedido_item_id ?? "") === String(item.id);
      });
      if (jaExiste) {
        puladas++;
        continue;
      }

      const empresaOrigemId = item.siso_pedidos?.empresa_origem_id ?? null;
      if (!empresaOrigemId) {
        skipsSemEmpresa++;
        continue;
      }

      let galpaoId = item.siso_pedidos?.separacao_galpao_id ?? null;
      if (!galpaoId) {
        const { data: pref } = await sb
          .from("siso_empresa_galpoes_preferenciais")
          .select("galpao_id")
          .eq("empresa_id", empresaOrigemId)
          .limit(1)
          .maybeSingle();
        galpaoId = (pref?.galpao_id as string | null) ?? null;
      }
      if (!galpaoId) {
        skipsSemEmpresa++;
        continue;
      }

      const { data: map } = await sb
        .from("siso_produto_empresas")
        .select("produto_id")
        .eq("empresa_id", empresaOrigemId)
        .eq("tiny_produto_id", Number(item.produto_id))
        .maybeSingle();
      const produtoWmsId = map?.produto_id as string | undefined;
      if (!produtoWmsId) {
        skipsSemMapeamento++;
        continue;
      }

      const { data: loc } = await sb
        .from("siso_localizacoes")
        .select("id")
        .eq("galpao_id", galpaoId)
        .eq("tipo", "recebimento")
        .eq("ativo", true)
        .limit(1)
        .maybeSingle();
      const locId = loc?.id as string | undefined;
      if (!locId) {
        skipsSemLoc++;
        continue;
      }

      let fornecedorId: string | null = null;
      if (item.fornecedor_oc) {
        const { data: forn } = await sb
          .from("siso_fornecedores")
          .select("id")
          .eq("nome", item.fornecedor_oc)
          .eq("ativo", true)
          .maybeSingle();
        fornecedorId = (forn?.id as string | null) ?? null;
      }

      if (dry) {
        console.log(
          `[DRY] criaria mov E pedido=${item.pedido_id} item=${item.id} sku=${item.sku} qty=${item.compra_quantidade_recebida} loc=${locId}`,
        );
        criadas++;
        continue;
      }

      try {
        await inserirMovimentacao({
          tripla: { produto_id: produtoWmsId, galpao_id: galpaoId, localizacao_id: locId },
          tipo: "E",
          qty: Number(item.compra_quantidade_recebida),
          origem_tipo: "nf_compra",
          origem_id: item.pedido_id,
          origem_detalhes: {
            sku: item.sku,
            pedido_item_id: item.id,
            backfill: true,
            fornecedor_nome: item.fornecedor_oc,
          },
          empresa_compradora_id: empresaOrigemId,
          fornecedor_id: fornecedorId,
          nota_fiscal_id: item.siso_pedidos?.nota_fiscal_id ?? null,
          custo_unitario: 0,
          motivo: `Backfill P2 — OC recebida pre-fix pedido ${item.pedido_id}`,
        });
        criadas++;
        console.log(`OK pedido=${item.pedido_id} item=${item.id} sku=${item.sku} qty=${item.compra_quantidade_recebida}`);
      } catch (e) {
        erros++;
        console.error(`ERRO item=${item.id}:`, e instanceof Error ? e.message : String(e));
      }
    }

    console.log(`\n─── Resumo ───`);
    console.log(`Total items lidos:     ${total}`);
    console.log(`Movs criadas:           ${criadas}`);
    console.log(`Puladas (já tinha mov): ${puladas}`);
    console.log(`Skip sem empresa/galpão: ${skipsSemEmpresa}`);
    console.log(`Skip sem mapeamento:    ${skipsSemMapeamento}`);
    console.log(`Skip sem loc RECEB:     ${skipsSemLoc}`);
    console.log(`Erros:                  ${erros}`);
  }

  main().catch((e) => {
    console.error("Backfill falhou:", e);
    process.exit(1);
  });
  ```
- [ ] Test dry-run against staging:
  ```bash
  npx tsx scripts/wms/backfill-compras-recebidas.ts --dry 2>&1 | tail -30
  ```
- [ ] Document the script in this plan + commit (DO NOT execute the non-dry version yet — that's a post-merge manual step):
  ```bash
  git add scripts/wms/backfill-compras-recebidas.ts
  git commit -m "feat(wms/backfill): script retroativo pra OCs recebidas pre-P2 (R1 mitigation)"
  ```

---

## 10. Final verification

### Task 10.1 — Run full scenario suite

- [ ] Run all scenarios:
  ```bash
  npm run scenarios 2>&1 | tee /tmp/final-p2.log
  grep -E "PASS|FAIL|TOTAL" /tmp/final-p2.log | tail -40
  ```
- [ ] Expected: 21 baseline + 12 new (22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33) = **33 cenários verdes** + 7 invariantes (I1..I7) verdes em cada.
- [ ] If any cenário fails, INVESTIGATE — check whether it's a regression in baseline (rollback the fix) or a missing piece in the new fix.

### Task 10.2 — Verify invariantes I1..I7 acceptance criteria

- [ ] I1 (Ledger ↔ cache coerente):
  ```bash
  curl -s -H "x-worker-secret: <secret>" http://localhost:3001/api/wms/reconciliacao | jq .
  ```
  Expected: `{ divergencias: 0, total_linhas: N }`.
- [ ] I2 (`disponivel = saldo - reservado`): handled by GENERATED column constraint — verify with:
  ```sql
  SELECT count(*) FROM siso_estoque WHERE disponivel != saldo - reservado;
  ```
  Expected: 0.
- [ ] I3 (Custo médio coerente): cenário 33 + cenário 10 covers this.
- [ ] I4 (Sem reservas órfãs): cenários 27, 28, 30 cover.
- [ ] I5 (Pendências guarda coerentes): cenário 8 cover (unchanged).
- [ ] I6 (Pares S+E balanceados): cenário 25 (par S+L) + I7.
- [ ] I7 (Fila vazia ao fim): cenário 1 + all webhook cenários.

### Task 10.3 — Acceptance criteria from §6.5 of spec — checklist confirm

- [ ] Cenário 22 (compras receber) passa: ✅ Task 3.1+3.2.
- [ ] Cenário 25 (bipar-checklist) passa sem dupla baixa: ✅ Task 4.1+4.2.
- [ ] Cenário 30 (cancelamento) passa: ✅ Task 5.1+5.2.
- [ ] Cenário 27 (encaminhar): ✅ Task 4.5+4.6.
- [ ] Cenário 31 (vendas manual): ✅ Task 5.3+5.4.
- [ ] I1..I7 passam após cada cenário: ✅ Task 10.2.
- [ ] Custo médio atualiza após receber compra: parcialmente — receber sem `custo_unitario` no body fica 0. Recomenda-se cenário 24 expandido. **Note this as a follow-up to P6.**
- [ ] `/wms/relatorios/historico-custo` mostra recálculos: manual smoke against staging UI after merge.

### Task 10.4 — Diff review + push

- [ ] Run `git log --oneline origin/develop..HEAD` — must show ~25-30 commits with `fix(wms/...)` or `feat(wms/...)` messages, each referencing a finding ID.
- [ ] Run `git diff --stat origin/develop..HEAD` to confirm scope (~20 endpoints + 5 libs + 12 new scenarios + 1 backfill script).
- [ ] Push branch:
  ```bash
  git push -u origin wms-fix-p2
  ```

### Task 10.5 — Open PR

- [ ] Open PR via `gh`:
  ```bash
  gh pr create --title "fix(wms): P2 · Ledger Completeness (22 findings)" --body "$(cat <<'EOF'
  ## Summary
  - Restaura PR-1 (siso_movimentacoes é fonte de verdade) e PR-6 (custo médio recalcula em entradas)
  - 22 findings fixados em ~20 endpoints + 5 libs
  - Helper compartilhado `pickMovPicking` extraído pra evitar duplicação (marcar-item ↔ bipar-checklist)
  - 12 cenários E2E novos (22..33) + backfill script `scripts/wms/backfill-compras-recebidas.ts`

  ## Spec
  `docs/superpowers/specs/2026-05-26-auditoria-wms-fixes-design.md` §6 (P2)

  ## Test plan
  - [ ] `npm run scenarios` — 33/33 verdes (21 baseline + 12 novos)
  - [ ] I1..I7 invariantes verdes em todo cenário
  - [ ] Smoke manual em staging: receber OC, ver saldo aparecer em `/wms/estoque`
  - [ ] Smoke manual: cancelar pedido com R criada, ver `assertSemReservasOrfas` passar
  - [ ] **Post-merge**: rodar `npx tsx scripts/wms/backfill-compras-recebidas.ts --dry` em staging pra avaliar quantos movs serão criados, depois rodar sem `--dry` numa janela de baixo tráfego.

  ## Dependency notes
  - P4 (auth) deve mergear DEPOIS deste P2 — overlap nos handlers tops é mínimo mas rebase resolve.
  - P1, P3, P6 podem mergear paralelo (worktrees independentes).

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```
- [ ] Capture PR URL and return it to the user in the success message.

### Task 10.6 — Post-merge follow-up (manual, NOT part of this plan execution)

- [ ] After PR merges to `develop` and Vercel auto-deploys, RUN the backfill in staging:
  ```bash
  cd /Users/eryk/Documents/ESTOQUE
  npx tsx scripts/wms/backfill-compras-recebidas.ts --dry  # preview count
  # confirma com user → roda sem --dry
  npx tsx scripts/wms/backfill-compras-recebidas.ts 2>&1 | tee /tmp/backfill-p2-prod.log
  ```
- [ ] Verify `siso_estoque` saldos cobrirem demanda das últimas semanas.
- [ ] Verify zero `compra_estoque_lancado_alerta=true` novas em pedidos pós-merge (monitorar 48h).

---

## Appendix · Files Modified Summary

```
Endpoints (15):
  src/app/api/wms/compras/receber/route.ts                                  [3.1]
  src/app/api/wms/compras/comprar/route.ts                                  [3.2]
  src/app/api/wms/compras/pedidos/[pedidoId]/cancelar/route.ts              [3.4]
  src/app/api/wms/compras/itens/[itemId]/equivalente/confirmar/route.ts     [3.7]
  src/app/api/wms/separacao/bipar-checklist/route.ts                        [2.5]
  src/app/api/wms/separacao/validar-oc-item/route.ts                        [2.6]
  src/app/api/wms/separacao/produto-esgotado/route.ts                       [2.8, 2.14]
  src/app/api/wms/separacao/encaminhar/route.ts                             [2.9]
  src/app/api/wms/separacao/localizacao/route.ts                            [2.7]
  src/app/api/wms/separacao/realocacao/[id]/route.ts                        [2.10]
  src/app/api/wms/separacao/concluir/route.ts                               [2.11]
  src/app/api/wms/separacao/concluir-oc/route.ts                            [2.15]
  src/app/api/wms/separacao/bipar-embalagem/route.ts                        [2.12]
  src/app/api/wms/separacao/confirmar-item-embalagem/route.ts               [2.13]
  src/app/api/wms/vendas/criar/route.ts                                     [7.2]
  src/app/api/wms/webhook/tiny/route.ts                                     [1.1, 6.12]
  src/app/api/wms/pedidos/aprovar/route.ts                                  [2.2]
  src/app/api/wms/ajuste/route.ts                                           [8.4]
  src/app/api/wms/lancamento-retroativo/route.ts                            [8.7]

Libs (6):
  src/lib/wms/separacao/pick-mov.ts (NEW)                                   [2.5]
  src/lib/wms/separacao/pick-mov.test.ts (NEW)                              [2.5]
  src/lib/separacao/wms-mapping.ts                                          [2.3]
  src/lib/wms/devolucoes.ts                                                 [6.13, 6.5, 6.18 if R5=UUID]
  src/lib/wms/inventario.ts                                                 [4.11]
  src/lib/wms/movimentacoes.ts                                              [8.4, 8.7]
  src/lib/nf-webhook-handler.ts                                             [6.12]
  src/lib/wms/ledger.ts (only if R5=TEXT)                                   [6.18]

Cenários novos (12):
  scripts/wms/cenarios/catalogo/22-receber-compra-grava-mov.ts
  scripts/wms/cenarios/catalogo/23-comprar-cria-oc.ts
  scripts/wms/cenarios/catalogo/24-cancelar-pedido-oc-recebida.ts
  scripts/wms/cenarios/catalogo/25-bipar-checklist-gera-mov.ts
  scripts/wms/cenarios/catalogo/26-validar-oc-encontrei-mov.ts
  scripts/wms/cenarios/catalogo/27-encaminhar-libera-reserva.ts
  scripts/wms/cenarios/catalogo/28-delete-realocacao-libera-r.ts
  scripts/wms/cenarios/catalogo/29-produto-esgotado-encaminhar-estorna.ts
  scripts/wms/cenarios/catalogo/30-webhook-cancel-libera-r.ts
  scripts/wms/cenarios/catalogo/31-venda-separacao-cria-r.ts
  scripts/wms/cenarios/catalogo/32-aprovar-transferencia-roteamento.ts
  scripts/wms/cenarios/catalogo/33-inventario-ganho-custo-medio.ts

Script novo:
  scripts/wms/backfill-compras-recebidas.ts (executar 1x post-merge)
```

## Baseline Snapshot (executado 2026-05-26 antes do P2)

Resultado: **16/21 passing, 5/21 failing**. O usuário aprovou prosseguir com P2
mesmo com baseline imperfeito porque várias falhas parecem ser exatamente os
bugs que o P2 vem fixar.

| # | Cenário | Motivo | Hipótese P2 |
|---|---|---|---|
| 01 | Pedido auto-aprovado própria | `assertMovsCount esperado=2 real=4` | #2.5 dupla baixa (bipar-checklist + marcar-item) — Task 4.2 |
| 04 | Parcial + realocação cascateada | pedido ficou `pendente/oc` | #2.3 buscarLocComMaiorSaldo usando saldo (não disponivel) — Task 6.1 |
| 05 | Parcial esgota → encaminhar | 409 `reserva_falhou:erro_runtime` | #2.3 + #2.9 encaminhar libera R — Task 4.6 |
| 06 | Inventário com picking concorrente | separação não inicia em 8s | Flake de timing — investigar à parte |
| 21 | Parcial libera R total + cascade re-emite R | pedido ficou `pendente/oc` | #2.3 buscarLocComMaiorSaldo — Task 6.1 |

**Critério de sucesso pós-P2 (revisado):**
- Cenários 02, 03, 07–20 (16 já verdes) — DEVEM CONTINUAR VERDES.
- Cenários 01, 04, 05, 21 — DEVEM passar verdes pós-P2 (são o que P2 fixa).
- Cenário 06 — fica como follow-up de flake de timing pós-P2.
- Cenários 22..33 (12 novos do P2) — DEVEM passar verdes.
- Meta final: ≥32/34 verdes (20 baseline + 12 novos), com cenário 06 como
  flake conhecido.

Snapshot completo: `/tmp/baseline-p2-snapshot.md`.

## R5 Decision Log

```
Data: 2026-05-26
Resultado SELECT:
  siso_movimentacoes.nota_fiscal_id   data_type = uuid
  siso_movimentacoes.chave_acesso_nf  data_type = text
Branch escolhida: UUID
  ☑ UUID → Task 8.2 obrigatória (lookup siso_notas_fiscais)
  □ TEXT → Task 8.1 executa removal de assertUuidLike(nota_fiscal_id)

Notas:
  - `siso_movimentacoes.nota_fiscal_id` é UUID. O `assertUuidLike` em
    `src/lib/wms/ledger.ts` está correto e PERMANECE.
  - Tabela `siso_notas_fiscais` NÃO EXISTE no banco staging
    (`ehbxpbeijofxtsbezwxd`). Logo, o lookup bigint→uuid descrito na
    Task 8.2 não tem destino. Conforme nota da própria Task 8.2,
    isso ESCALA para o P6 (spec amendment com nova migration
    `supabase/migrations/20260527_siso_notas_fiscais.sql`).
  - **Efeito imediato no P2:** devoluções continuam SEM gravar
    `nota_fiscal_id` no ledger (já é o comportamento atual — qualquer
    tentativa de passar o bigint stringificado do Tiny seria rejeitada
    pelo `assertUuidLike`). Task 8.3 (custo_unitario propagation) e
    Task 8.4 (clarificação semântica empresa) seguem normalmente.
  - **Pendência P6:** criar tabela `siso_notas_fiscais` com `(id uuid PK,
    tiny_nf_id bigint UNIQUE, chave_acesso text UNIQUE, ...)` + populá-la
    a partir do worker que detecta NF + adaptar webhook-processor e
    nf-webhook-handler para gravar nessa tabela. Só então as devoluções
    poderão consultar `pedido_origem_mov_id` via nota_fiscal_id real.
```
