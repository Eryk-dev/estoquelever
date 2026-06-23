# WMS Fix · P3 · Reverse Paritária + Idempotência — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore principle PR-2 (every forward action has a reverse) and PR-7 (idempotency on retry/double-click). Add 7 new undo endpoints, harden 5 race conditions, add 1 UNIQUE constraint, wrap 2 multi-step operations in atomic RPCs.

**Architecture:** Each new reverse endpoint reuses existing `estornarMovimentacao` to keep ledger pairing intact. Race fixes use pessimistic locks (SELECT FOR UPDATE) at the row level for the resources being mutated (pendência guarda, sessão inventário, transferência header). New atomic RPCs (`wms_replenishment_intra_galpao`, `wms_confirmar_guarda_atomico`) wrap multi-leg movements that previously had non-transactional gaps.

**Tech Stack:** TypeScript route handlers, PostgreSQL pessimistic locking, plpgsql RPCs, partial UNIQUE indexes, existing test harness.

**Worktree:** `.claude/worktrees/wms-fix-p3/`. Branch: `wms-fix-p3`.

**Staging only.** Use `mcp__supabase__apply_migration` for migrations on project `ehbxpbeijofxtsbezwxd`.

**Dependency note:** P3 runs parallel to P1/P2/P6. UI buttons depend on backend endpoints being merged first.

---

## Spec traceability

This plan implements spec §7 of `docs/superpowers/specs/2026-05-26-auditoria-wms-fixes-design.md`. Findings covered (cross-reference §15 Módulos 2/4/5/6/7/8 in the appendix):

| Finding | Severity | Resolved by task(s) |
|---|---|---|
| 4.1 — Aplicar inventário não idempotente | ALTO | Tasks 6-11 (UNIQUE constraint + idempotency wrap) |
| 4.2 — Aplicar inventário sem reverse | ALTO | Tasks 23-30 (estornar endpoint + cenário 41) |
| 4.3 — `/contagens` não valida lock | ALTO | Tasks 15-18 (lock check) |
| 4.4 — DELETE sessão sem guard de status | ALTO | Tasks 12-14 (status guard) |
| 4.5 — `computarDivergencias` força sair-party sem aviso | MÉD | Tasks 75-77 (warning aviso) |
| 4.6 — Encerrar parcial deixa locs em_contagem com bloqueada_por finalizado | MÉD | Tasks 75-77 (mesmo bloco) |
| 4.7 — Modo blind vs aberto PATCH sem guard | MÉD | Tasks 78-80 (pickPatchFields guard) |
| 5.1 — Confirmação de guarda IRREVERSÍVEL pela UI | ALTO | Tasks 35-42 (desfazer endpoint + cenário 42) |
| 5.2 — Race silenciosa em `iniciarGuarda` | ALTO | Tasks 19-22 (conditional UPDATE) |
| 5.3 — `confirmarGuarda` sem lock entre validação e UPDATE | ALTO | Tasks 50-58 (atomic RPC wrap) |
| 5.8 — Confirmação parcial regride status | MÉD | Tasks 50-58 (idem RPC) |
| 6.3 — Classificação irreversível sem trilha undo | ALTO | Tasks 43-49 (desclassificar endpoint + cenário 43) |
| 7.7 — Idempotência vendas não cobre rollback | MÉD | Tasks 81-84 (idempotency key lookup) |
| 7.13 — Não há DELETE/cancelar venda | BAIXO | Tasks 59-65 (cancelar venda endpoint + cenário 45) |
| 8.2 — Receber transferência terminal sem reverse | ALTO | Tasks 66-72 (desfazer-recebimento endpoint + cenário 46) |
| 8.3 — Cancelamento transferência não trata recepção parcial | ALTO | Tasks 73-74 (estende cancelar) |
| 8.6 — Reconciliar retroativo aceita compra_mov_id sem validação uuid | MÉD | Tasks 31-34 (uuid + existência check) |
| 8.8 — Replenishment não-transacional | MÉD | Tasks 50-58 + Tasks 85-90 (atomic RPC + reverter endpoint) |
| 8.10 — 2 ops recebendo mesma transferência | MÉD | Tasks 91-94 (FOR UPDATE no header) |
| 2.7 — Desmarcar item race S antes de L | MÉD | Tasks 95-98 (ordem estornos) |
| 2.10 — Reiniciar etapa=embalagem não toca ledger | MÉD | Tasks 99-103 (reverte cutover) |
| 3.20 — Ajuste manual sem reverse endpoint | MÉD | Tasks 104-108 (ajuste/estornar endpoint) |

**Cross-cutting** (touched also in P2/P6): finding 4.13 (re-execução `computarDivergencias`) is documented but actual fix lives in P6 cleanup batch.

---

## Existing primitives we REUSE (do NOT reinvent)

| Primitive | File | Use case in P3 |
|---|---|---|
| `estornarMovimentacao({ mov_id, usuario_id, motivo })` | `src/lib/wms/ledger.ts:281` | All new reverse endpoints. Inverts E↔S, R↔L, refuses double-estorno. |
| `inserirMovimentacao({ ..., tipo: "R", origem_tipo: "reserva_pedido" })` | `src/lib/wms/ledger.ts:103` | Re-cria R quando precisar ressuscitar reserva (desfazer cancela venda). |
| `siso_pedido_item_mov_links` | `supabase/migrations/20260518_realocacao_fix_pack_foundation.sql` | Linkar forward+reverse pra rastreio. Já suporta tipo_link em `('saida','ajuste_loc_zerou','liberacao_reserva','reserva_pedido')` (migration `20260526_picking_R_L_pairing.sql`). |
| `wms_inserir_movimentacao` (RPC) | DB | Lock pessimista + escrita atômica. RPCs novas (`wms_confirmar_guarda_atomico`, `wms_replenishment_intra_galpao`) chamam por dentro. |
| `wms_reservar_atomico` (RPC) | DB | Cria R com TTL. Usado em desfazer-cancelar-venda se a reserva ainda fazia sentido. |
| `liberarReservaPicking`, `estornarLiberacaoReserva` | `src/lib/wms/reservas-picking.ts` | Pareamento R/L em desmarcar/reverter. |
| `requireWarehouseAccess` / `requireAdmin` | `src/lib/wms/auth.ts` | Auth padrão de todos endpoints novos. Admin pra estornar inventário aplicado. |
| `wmsErrorResponse` | `src/lib/wms/api-errors.ts` | Resposta padronizada de erro. |
| `registrarEvento` | `src/lib/historico-service.ts` | Audit trail por pedido (usado em reverse de vendas/separação). |

**Rule of thumb:** NUNCA escrever direto em `siso_estoque` ou `siso_movimentacoes`. SEMPRE passar por `inserirMovimentacao` / `estornarMovimentacao` / RPC.

---

## Test harness

- **Camada 3:** `scripts/wms/cenarios/catalogo/NN-nome.ts`. Hoje vão até 21. P3 reserva o range **40-49** (P2 ocupa 22-39). Próximo livre: **40**.
- Rodar suite completa: `npm run scenarios`
- Rodar cenário isolado: `PORT=3001 npm run dev` (terminal 1), depois `npx tsx scripts/wms/cenarios/catalogo/NN-nome.ts` (terminal 2).
- Invariantes globais (I1..I7) rodam automaticamente ao fim de cada cenário — ver `scripts/wms/cenarios/README.md`.
- Helpers de Ctx em `scripts/wms/cenarios/_harness/context.ts`. P3 adiciona vários novos (estornarInventario, desfazerGuarda, desclassificarDevolucao, etc.).

---

## Risks specific to P3 (ver §12 R3 da spec mestre)

| Risk | Mitigation |
|---|---|
| UNIQUE constraint do inventário falha em dados históricos | Task 6 roda query de detecção ANTES de criar índice. Se retornar >0, parar e abrir ticket pra cleanup manual. |
| Estorno de inventário recria divergências sem cobertura de saldo | RPC do estorno usa `inserirMovimentacao` reverse — se o saldo posterior ficar negativo, estorno aborta com mensagem clara (preserva estado consistente). |
| Cancelar transferência parcial pode estornar movs já reentregues por ajuste | Task 73 valida `recebida_em IS NULL` por item-linha antes de estornar — só estorna o que ainda está em transit pelo header. |
| RPC atômico de replenishment quebra cenário 14 existente | Task 50 começa rodando cenário 14 antes de mudar; depois roda de novo pós-RPC com mesma asserção. |

---

## Conventions for this plan

- Each task starts with `- [ ]` checkbox. Sub-bullets describe exact actions.
- New SQL files use prefix `20260527_p3_*.sql` to facilitate revert.
- New endpoint files referenced by absolute path (`src/app/api/wms/...`).
- Commit messages: `fix(p3): #4.1 aplicar inventário idempotente`, etc. Tag finding ID always.
- TDD strict: failing scenario first, demonstrate failure (output captured), then implement, demonstrate pass, then commit.

---

# Phase 0 · Setup + Pre-req checks

## Task 1 · Create worktree

- [ ] From repo root: `git worktree add .claude/worktrees/wms-fix-p3 -b wms-fix-p3 develop`
- [ ] `cd .claude/worktrees/wms-fix-p3`
- [ ] Verify: `git status` shows clean tree on branch `wms-fix-p3`.
- [ ] Verify: `git log -1 --oneline` matches `develop` HEAD.

## Task 2 · Baseline: verify scenarios pass before any change

- [ ] Run `npm install` (idempotent — should be no-op if root already installed).
- [ ] Ensure `.env.test.local` is present in worktree (copy from `~/Documents/ESTOQUE/.env.test.local` if missing — gitignored by design).
- [ ] Run `npm run scenarios`.
- [ ] Capture full output. Expected: **17/17 pass** (or whatever the current baseline says — check the most recent `scripts/wms/cenarios/reports/` in the parent worktree).
- [ ] If baseline is NOT clean, STOP and report — don't start P3 on a broken baseline.

## Task 3 · Read spec section + sanity-check finding inventory

- [ ] Open `docs/superpowers/specs/2026-05-26-auditoria-wms-fixes-design.md` and read §7 in full.
- [ ] Confirm finding count matches this plan's traceability table (22 findings).
- [ ] Note: §7.5 acceptance criteria are formalized in Tasks 109-114.

## Task 4 · Verify existing primitives are intact

- [ ] `grep -n "export async function estornarMovimentacao" src/lib/wms/ledger.ts` → must return line 281.
- [ ] `grep -n "tipo_link" supabase/migrations/20260526_picking_R_L_pairing.sql` → must show extension to 4 values.
- [ ] `grep -n "siso_pedido_item_mov_links" supabase/migrations/20260518_realocacao_fix_pack_foundation.sql` → confirms table exists.
- [ ] `npx tsc --noEmit` from worktree root → zero errors before any change.

## Task 5 · Document existing schema invariants for inventário aplicar

- [ ] Run query against staging via `mcp__supabase__execute_sql` on project `ehbxpbeijofxtsbezwxd`:
  ```sql
  SELECT origem_tipo, count(*) AS movs, count(DISTINCT origem_detalhes->>'divergencia_id') AS divergencias_distintas
  FROM siso_movimentacoes
  WHERE origem_tipo IN ('inventario_ganho','inventario_perda')
  GROUP BY origem_tipo;
  ```
- [ ] Salvar resultado no task log — usado pra confirmar Task 6 não trava em dados históricos.

---

# Phase 1 · Pre-req · UNIQUE constraint conflict check (§12 R3)

## Task 6 · Detect duplicate inventário aplicado movs BEFORE adding constraint

- [ ] Via `mcp__supabase__execute_sql` no project `ehbxpbeijofxtsbezwxd`:
  ```sql
  SELECT origem_detalhes->>'divergencia_id' AS divergencia_id, count(*) AS movs
  FROM siso_movimentacoes
  WHERE origem_tipo IN ('inventario_ganho', 'inventario_perda')
    AND origem_detalhes ? 'divergencia_id'
  GROUP BY 1
  HAVING count(*) > 1
  ORDER BY 2 DESC;
  ```
- [ ] If output is **empty** → pré-req OK, prosseguir pra Task 7.
- [ ] If output **NÃO está vazio**:
  - Capturar a lista no task log.
  - STOP — abrir issue no GitHub: "P3 blocked: N divergências têm movs duplicadas — decisão necessária (manter primeira mov? estornar duplicadas?)".
  - Apresentar opções pro user. Não prosseguir até decisão registrada.

## Task 7 · Verify movs sem `divergencia_id` em origem_detalhes (movs órfãs)

- [ ] Query:
  ```sql
  SELECT count(*) FROM siso_movimentacoes
  WHERE origem_tipo IN ('inventario_ganho', 'inventario_perda')
    AND NOT (origem_detalhes ? 'divergencia_id');
  ```
- [ ] Se > 0, registrar no log — essas movs NÃO são cobertas pelo UNIQUE parcial (índice WHERE filter inclui `WHERE origem_detalhes ? 'divergencia_id'`); são legacy/manual e ficam fora do enforcement. Documentar.

---

# Phase 2 · Idempotency hardening — Inventário aplicar (findings 4.1, 4.4)

## Task 8 · Create migration: UNIQUE índice parcial pro divergencia_id

- [ ] Create file `supabase/migrations/20260527_p3_movs_unique_inventario_divergencia.sql`:
  ```sql
  -- P3 fix #4.1: idempotência de aplicar inventário.
  -- Cada divergência aprovada vira NO MÁXIMO 1 mov no ledger (E ou S).
  -- Clique duplo no botão "Aplicar" passa a falhar com SQLSTATE 23505 no
  -- 2º clique em vez de duplicar movs.
  --
  -- Índice parcial: cobre apenas movs onde origem_detalhes carrega
  -- divergencia_id (formato pós-P3). Movs históricas sem essa chave ficam
  -- fora do enforcement e dependem do cleanup retroativo (P6).
  --
  -- IMPORTANTE: este migration assume que Task 6 detectou zero duplicatas.
  -- Se rodar com duplicatas, falha com "could not create unique index" —
  -- isso é proteção, não bug.

  CREATE UNIQUE INDEX IF NOT EXISTS uniq_movs_inventario_divergencia
    ON siso_movimentacoes ((origem_detalhes->>'divergencia_id'))
    WHERE origem_tipo IN ('inventario_ganho', 'inventario_perda')
      AND origem_detalhes ? 'divergencia_id';

  COMMENT ON INDEX uniq_movs_inventario_divergencia IS
    'P3 #4.1: garante 1 mov por divergência aplicada (idempotência do aplicarSessao).';
  ```
- [ ] Apply via `mcp__supabase__apply_migration` (project_id `ehbxpbeijofxtsbezwxd`, name `20260527_p3_movs_unique_inventario_divergencia`).
- [ ] Verify created: `SELECT indexname FROM pg_indexes WHERE indexname = 'uniq_movs_inventario_divergencia';`

## Task 9 · Write FAILING scenario 40-aplicar-inventario-idempotente

- [ ] Create `scripts/wms/cenarios/catalogo/40-aplicar-inventario-idempotente.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "40 — Aplicar inventário 2× simultâneo gera 1 conjunto de movs",
    descricao: "Sessão com 1 divergência aplicada. Duas chamadas /aplicar em paralelo devem resultar em exatamente 1 mov de inventário (UNIQUE constraint + idempotência).",
    tags: ["p3", "inventario", "idempotencia", "race"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("40");
      await ctx.criarProduto({ sku, descricao: "P3-40 idempotência aplicar" });
      await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 10 });
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const sess = await ctx.criarSessaoInventario({
        galpao: "CWB",
        locs: ["A-01-01"],
        modo: "blind",
        tipo: "cycle_count",
      });
      await ctx.entrarParty(sess.id);
      await ctx.proximaLoc(sess.id);
      // Conta 8 — gera divergência de -2
      await ctx.bipeInventario({ sessao_id: sess.id, sku, loc: "A-01-01", qty: 8 });
      await ctx.finalizarLocInventario({ sessao_id: sess.id, loc: "A-01-01" });
      await ctx.aprovarInventario(sess.id);

      // 2 chamadas paralelas pro endpoint /aplicar
      const [r1, r2] = await Promise.allSettled([
        ctx.http.post(`/api/wms/inventario/${sess.id}/aplicar`),
        ctx.http.post(`/api/wms/inventario/${sess.id}/aplicar`),
      ]);
      ctx.log("aplicar-idempotente", {
        r1: r1.status,
        r2: r2.status,
        r1_reason: r1.status === "rejected" ? String(r1.reason) : undefined,
        r2_reason: r2.status === "rejected" ? String(r2.reason) : undefined,
      });
      // No mínimo uma das duas tem que ter passado. Idempotência: ambas
      // podem passar (2ª é no-op) OU uma passa + 1 falha graceful.
      const okCount = [r1, r2].filter((r) => r.status === "fulfilled").length;
      if (okCount === 0) throw new Error("nenhuma chamada de aplicar passou");
    },

    assertEsperado: async (ctx, { sku }) => {
      // Saldo final: 8 (10 - 2 da divergência)
      await ctx.assertSaldo(sku, "CWB", "A-01-01", 8);
      // EXATAMENTE 1 mov de inventario_perda (não 2!)
      const { count } = await ctx.sb
        .from("siso_movimentacoes")
        .select("id", { count: "exact", head: true })
        .eq("origem_tipo", "inventario_perda");
      if ((count ?? 0) !== 1) {
        throw new Error(`esperava 1 mov inventario_perda, achou ${count}`);
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
- [ ] Run: `npx tsx scripts/wms/cenarios/catalogo/40-aplicar-inventario-idempotente.ts`
- [ ] Expected: **FAIL** — assertEsperado vê 2 movs em vez de 1 (porque `aplicarSessao` ainda não é idempotente; ele tenta inserir, falha por UNIQUE, e o for loop joga). O resultado correto é fail mostrando contagem de movs incorreta OU exception não-tratada da 2ª chamada.
- [ ] Capture output, save in task log.

## Task 10 · Implement idempotency in `aplicarSessao`

- [ ] Edit `src/lib/wms/inventario.ts` (function `aplicarSessao` at line 805):
  - Antes do `for (const d of divergencias)`, mover a transição de status de sessão pra mais cedo + adicionar guard. **Importante:** se a sessão já está `aplicada`, retornar `{ movsGeradas: 0 }` sem fazer nada (caminho idempotente clássico).
  - No loop, capturar `PostgrestError` com code `23505` (unique violation) e tratar como "já aplicada, segue" em vez de propagar.
- [ ] Patch concreto:
  ```typescript
  export async function aplicarSessao(
    sessaoId: string,
    usuarioId: string,
  ): Promise<{ movsGeradas: number }> {
    const sb = createServiceClient();
    const { data: sessao } = await sb
      .from("siso_inventario_sessoes")
      .select("status, galpao_id, aplicada_em")
      .eq("id", sessaoId)
      .single();
    if (!sessao) throw new Error("sessão não encontrada");
    const s = sessao as { status: string; galpao_id: string; aplicada_em: string | null };

    // P3 #4.1: idempotência. Sessão já aplicada → no-op com retorno coerente.
    if (s.status === "aplicada") {
      const { count } = await sb
        .from("siso_movimentacoes")
        .select("id", { count: "exact", head: true })
        .eq("origem_id", sessaoId)
        .in("origem_tipo", ["inventario_ganho", "inventario_perda"]);
      return { movsGeradas: count ?? 0 };
    }
    if (s.status !== "aprovada") throw new Error("sessão não está aprovada");

    const { data: divergencias } = await sb
      .from("siso_inventario_divergencias")
      .select("*")
      .eq("sessao_id", sessaoId)
      .eq("status", "aprovada");

    type DivRow = {
      id: string;
      produto_id: string;
      localizacao_id: string;
      delta: number;
      delta_pct: number | null;
    };

    let movsGeradas = 0;
    for (const d of (divergencias ?? []) as DivRow[]) {
      if (Number(d.delta) === 0) continue;
      const tipo: TipoMov = Number(d.delta) > 0 ? "E" : "S";
      const qty = Math.abs(Number(d.delta));
      try {
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
          usuario_id: usuarioId,
          motivo: `inventário sessão ${sessaoId}`,
        });
        await sb
          .from("siso_inventario_divergencias")
          .update({ status: "aplicada", mov_aplicada_id: mov.id })
          .eq("id", d.id);
        movsGeradas++;
      } catch (err) {
        // P3 #4.1: UNIQUE violation = outra chamada já aplicou essa divergência.
        // No-op pra essa linha; assegurar status='aplicada' via lookup da mov existente.
        const code = (err as { code?: string })?.code;
        const msg = err instanceof Error ? err.message : String(err);
        const isUniq = code === "23505" || /uniq_movs_inventario_divergencia/.test(msg);
        if (!isUniq) throw err;
        const { data: movExistente } = await sb
          .from("siso_movimentacoes")
          .select("id")
          .eq("origem_detalhes->>divergencia_id", d.id)
          .in("origem_tipo", ["inventario_ganho", "inventario_perda"])
          .maybeSingle();
        if (movExistente) {
          await sb
            .from("siso_inventario_divergencias")
            .update({ status: "aplicada", mov_aplicada_id: movExistente.id })
            .eq("id", d.id);
        }
      }
    }

    // Libera locks da sessão (idempotente)
    const { data: locs } = await sb
      .from("siso_inventario_localizacoes")
      .select("localizacao_id")
      .eq("sessao_id", sessaoId);
    const locIds = ((locs ?? []) as Array<{ localizacao_id: string }>).map(
      (l) => l.localizacao_id,
    );
    if (locIds.length > 0) {
      await sb
        .from("siso_localizacao_locks")
        .update({ finalizado_em: new Date().toISOString() })
        .in("localizacao_id", locIds)
        .is("finalizado_em", null);
    }

    // UPDATE condicional — só transiciona se ainda não foi aplicada (outra request)
    await sb
      .from("siso_inventario_sessoes")
      .update({ status: "aplicada", aplicada_em: new Date().toISOString() })
      .eq("id", sessaoId)
      .neq("status", "aplicada");

    return { movsGeradas };
  }
  ```

## Task 11 · Verify scenario 40 PASSES + commit

- [ ] Run `npx tsx scripts/wms/cenarios/catalogo/40-aplicar-inventario-idempotente.ts`
- [ ] Expected: **PASS** + I1..I7 invariantes verdes.
- [ ] Run `npm run scenarios` — full suite passa (17 originais + 40 novo = 18 total).
- [ ] Commit:
  ```
  git add supabase/migrations/20260527_p3_movs_unique_inventario_divergencia.sql \
          src/lib/wms/inventario.ts \
          scripts/wms/cenarios/catalogo/40-aplicar-inventario-idempotente.ts
  git commit -m "fix(p3): #4.1 aplicar inventário idempotente (UNIQUE + retry handling)

  - Adiciona uniq_movs_inventario_divergencia (índice parcial)
  - aplicarSessao trata 23505 como no-op (outra request já fez)
  - Sessão status='aplicada' → no-op com count das movs existentes
  - UPDATE de status usa .neq('status','aplicada') pra evitar double-write
  - Cenário 40 valida 2x Promise.all = 1 mov só

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

# Phase 3 · DELETE inventário · status guard (finding 4.4)

## Task 12 · Write FAILING scenario inline (sub-step of Task 14)

- [ ] Snippet de validação manual via curl/http durante TDD:
  ```bash
  # Após aplicar uma sessão (status='aplicada'), tentar DELETE deve retornar 409.
  # HOJE retorna 200 + muda status pra 'cancelada' (bug 4.4).
  ```
- [ ] Não precisa de cenário dedicado — o behavior é coberto incidentalmente pelos cenários de inventário existentes. Adicionar assertion na Task 14.

## Task 13 · Implement DELETE guard

- [ ] Edit `src/app/api/wms/inventario/[id]/route.ts` — função `DELETE`:
  ```typescript
  export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) {
    const auth = await requireWarehouseAccess(req);
    if (!auth.ok) return auth.response;

    const { id } = await params;
    const sb = createServiceClient();

    // P3 #4.4: sessão aplicada não pode ser cancelada. Operadora teria
    // que ESTORNAR (POST /estornar). Cancelar deletaria a trilha sem
    // reverter as movs no ledger — saldo ficaria inconsistente.
    const { data: sessao } = await sb
      .from("siso_inventario_sessoes")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    if (!sessao) {
      return NextResponse.json({ error: "sessão não encontrada" }, { status: 404 });
    }
    if ((sessao as { status: string }).status === "aplicada") {
      return NextResponse.json(
        {
          error:
            "sessão já foi aplicada (movs no ledger). Use POST /api/wms/inventario/[id]/estornar para reverter.",
          code: "SESSAO_APLICADA",
        },
        { status: 409 },
      );
    }
    if ((sessao as { status: string }).status === "cancelada") {
      // Já cancelada — idempotente.
      return NextResponse.json({ ok: true });
    }

    const { data: locs } = await sb
      .from("siso_inventario_localizacoes")
      .select("localizacao_id")
      .eq("sessao_id", id);
    const locIds = ((locs ?? []) as Array<{ localizacao_id: string }>).map(
      (l) => l.localizacao_id,
    );
    if (locIds.length > 0) {
      await sb
        .from("siso_localizacao_locks")
        .update({ finalizado_em: new Date().toISOString() })
        .in("localizacao_id", locIds)
        .is("finalizado_em", null);
    }
    await sb
      .from("siso_inventario_sessoes")
      .update({ status: "cancelada" })
      .eq("id", id);
    return NextResponse.json({ ok: true });
  }
  ```

## Task 14 · Verify DELETE guard com cenário rápido inline

- [ ] Adicionar mini-cenário no final de `scripts/wms/cenarios/catalogo/40-aplicar-inventario-idempotente.ts` (ou cenário dedicado se ficar > 100 linhas):
  ```typescript
  // (No mesmo cenário 40, após assertEsperado do main:)
  // Re-faz: tenta DELETE da sessão aplicada → espera 409.
  ```
- [ ] OU criar cenário curtinho `40b-delete-sessao-aplicada.ts`. Decidir conforme limpeza do arquivo.
- [ ] Snippet de fetch direto:
  ```typescript
  const resp = await ctx.http.delete(`/api/wms/inventario/${sess.id}`).catch((e) => e);
  // Esperado: HTTP 409 com body { error, code: 'SESSAO_APLICADA' }
  ```
- [ ] Commit:
  ```
  git add src/app/api/wms/inventario/[id]/route.ts
  git commit -m "fix(p3): #4.4 DELETE inventário aplicada retorna 409

  - Sessão status='aplicada' não pode virar 'cancelada' via DELETE
  - Mensagem aponta pro endpoint /estornar como caminho correto
  - Status='cancelada' continua idempotente (re-DELETE = 200 ok)

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

# Phase 4 · `/contagens` valida lock (finding 4.3)

## Task 15 · Inspect current behavior

- [ ] Read `src/lib/wms/inventario.ts` function `registrarContagem`. Confirmar: hoje aceita qualquer `contada_por` sem checar `bloqueada_por`.
- [ ] Anotar exact line ranges no task log pra fácil patch.

## Task 16 · Write FAILING scenario 40c-contagem-sem-lock-rejeita

- [ ] Create `scripts/wms/cenarios/catalogo/40c-contagem-sem-lock-rejeita.ts`:
  - Setup: cria sessão. **NÃO** entra na party / não reivindica loc.
  - Run: chama `POST /api/wms/inventario/[id]/contagens` direto via `ctx.http.post` com `localizacao_id`+`produto_id`+`qty`. Espera HTTP 409 com mensagem clara.
  - assertEsperado: zero linhas em `siso_inventario_contagens` pra essa sessão.
- [ ] Run cenário → FAIL (hoje contagem é aceita).

## Task 17 · Implement lock validation in `registrarContagem`

- [ ] Edit `src/lib/wms/inventario.ts` — função `registrarContagem`:
  ```typescript
  export async function registrarContagem(input: {
    sessao_id: string;
    localizacao_id: string;
    produto_id: string;
    qty: number;
    contada_por: string;
  }): Promise<void> {
    const sb = createServiceClient();

    // P3 #4.3: bipe só é aceito se a loc está bloqueada por este operador.
    // Sem isso, alguém com PIN qualquer pode injetar contagens em sessão
    // que ele nem entrou — vazamento de write.
    const { data: locRow } = await sb
      .from("siso_inventario_localizacoes")
      .select("bloqueada_por, status")
      .eq("sessao_id", input.sessao_id)
      .eq("localizacao_id", input.localizacao_id)
      .maybeSingle();
    if (!locRow) {
      throw new Error("localização não faz parte desta sessão");
    }
    const lr = locRow as { bloqueada_por: string | null; status: string };
    if (lr.status === "contada" || lr.status === "aprovada") {
      throw new Error(`loc já está em status ${lr.status} — re-abertura via supervisor`);
    }
    if (!lr.bloqueada_por) {
      throw new Error("loc não está reivindicada — chame /proxima-loc antes de bipar");
    }
    if (lr.bloqueada_por !== input.contada_por) {
      throw new Error(
        `loc reivindicada por outro operador (${lr.bloqueada_por}). Aguarde liberação.`,
      );
    }

    // Resto do código original de registrarContagem (UPSERT em siso_inventario_contagens).
    // ... (preservar lógica existente)
  }
  ```
- [ ] **Importante:** preservar lógica restante de `registrarContagem` que faz UPSERT em `siso_inventario_contagens` e atualiza `siso_localizacoes.ultima_contagem_em`. Apenas adicionar o bloco de guard no início.

## Task 18 · Update endpoint to map errors → 409

- [ ] Edit `src/app/api/wms/inventario/[id]/contagens/route.ts`:
  ```typescript
  // No catch, mapear mensagens específicas pra 409 em vez de 400 genérico:
  const isLockMsg =
    msg.includes("não faz parte") ||
    msg.includes("não está reivindicada") ||
    msg.includes("reivindicada por outro") ||
    msg.includes("já está em status");
  return wmsErrorResponse({
    source: "wms.inventario.contagens",
    error: e,
    status: isLockMsg ? 409 : 400,
    requestPath: `/api/wms/inventario/${id}/contagens`,
    requestMethod: "POST",
    metadata: { sessao_id: id, localizacao_id: body.localizacao_id, produto_id: body.produto_id },
  });
  ```
- [ ] Run cenário 40c → PASS.
- [ ] Run `npm run scenarios` full → todos passam (cenário 06 já reivindica loc antes de bipar — protegido).
- [ ] Commit:
  ```
  git add src/lib/wms/inventario.ts src/app/api/wms/inventario/[id]/contagens/route.ts \
          scripts/wms/cenarios/catalogo/40c-contagem-sem-lock-rejeita.ts
  git commit -m "fix(p3): #4.3 contagens validam lock de loc

  - registrarContagem rejeita se loc não está bloqueada pelo operador
  - Endpoint mapeia mensagens de lock pra 409 (não 400 genérico)
  - Cenário 40c valida bipe direto sem proxima-loc bate em 409

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

# Phase 5 · Race fix · iniciarGuarda (finding 5.2)

## Task 19 · Write FAILING scenario 40d-iniciar-guarda-race

- [ ] Create `scripts/wms/cenarios/catalogo/40d-iniciar-guarda-race.ts`:
  - Setup: cria pendência via `ctx.receber({ items, galpao })`.
  - Run: chama `POST /api/wms/guarda/[id]/iniciar` em paralelo com 2 cookies de operadores diferentes (precisa criar operador secundário no seed — usar `test-runner-2`; adicionar helper no harness se ainda não existe).
  - Validação: exatamente 1 das 2 chamadas tem `pendencia.iniciada_por === minha_user_id`. A outra retorna 409 com avatar/info do primeiro.
- [ ] **Helper novo necessário** em `_harness/context.ts`: `loginAlt({ pin })` retornando `{ http_alt: HttpClient }` com cookie do 2º usuário. Adicionar como sub-task antes do cenário rodar.
- [ ] Run cenário → FAIL (hoje 2 chamadas passam, a segunda sobrescreve `iniciada_por`).

## Task 20 · Implement conditional UPDATE in `iniciarGuarda`

- [ ] Edit `src/lib/wms/guarda.ts` — função `iniciarGuarda`:
  ```typescript
  export async function iniciarGuarda(input: {
    pendencia_id: string;
    usuario_id: string;
  }): Promise<PendenciaJoined> {
    const sb = createServiceClient();
    const pend = await obterPendencia(input.pendencia_id);
    if (!pend) throw new Error("pendência não encontrada");
    if (pend.status === "guardada" || pend.status === "cancelada") {
      throw new Error(`pendência em status terminal (${pend.status})`);
    }
    // Re-entrada do mesmo operador: idempotente.
    if (pend.status === "em_guarda" && pend.iniciada_por === input.usuario_id) {
      return pend;
    }
    // Outro operador já reivindicou.
    if (pend.status === "em_guarda" && pend.iniciada_por && pend.iniciada_por !== input.usuario_id) {
      const err = new Error(
        `pendência já está em_guarda com outro operador (${pend.iniciada_por})`,
      ) as Error & { code?: string; iniciada_por?: string };
      err.code = "PENDENCIA_OUTRA_GUARDA";
      err.iniciada_por = pend.iniciada_por;
      throw err;
    }

    // P3 #5.2: UPDATE atômico com guard. WHERE iniciada_por IS NULL OR
    // iniciada_por = $1 — se outro op pegou entre obterPendencia e aqui,
    // updates afeta 0 linhas → erramos com 409.
    const { data: updated, error } = await sb
      .from("siso_wms_pendencias_guarda")
      .update({
        status: "em_guarda",
        iniciada_em: new Date().toISOString(),
        iniciada_por: input.usuario_id,
      })
      .eq("id", input.pendencia_id)
      .or(`iniciada_por.is.null,iniciada_por.eq.${input.usuario_id}`)
      .neq("status", "guardada")
      .neq("status", "cancelada")
      .select("id, iniciada_por");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      // Race: alguém pegou entre a leitura e o UPDATE.
      const refreshed = await obterPendencia(input.pendencia_id);
      const err = new Error(
        `pendência foi reivindicada por outro operador (${refreshed?.iniciada_por ?? "?"})`,
      ) as Error & { code?: string; iniciada_por?: string };
      err.code = "PENDENCIA_OUTRA_GUARDA";
      err.iniciada_por = refreshed?.iniciada_por ?? undefined;
      throw err;
    }

    const refresh = await obterPendencia(input.pendencia_id);
    if (!refresh) throw new Error("pendência sumiu após iniciar (race condition)");
    return refresh;
  }
  ```

## Task 21 · Update endpoint to surface 409 + outro operador

- [ ] Edit `src/app/api/wms/guarda/[id]/iniciar/route.ts`:
  ```typescript
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string }).code;
    const iniciadaPor = (e as { iniciada_por?: string }).iniciada_por;
    const isLock = code === "PENDENCIA_OUTRA_GUARDA";
    const isClient =
      isLock || msg.includes("não encontrada") || msg.includes("status terminal");
    return wmsErrorResponse({
      source: "wms.guarda.iniciar",
      error: e,
      status: isLock ? 409 : isClient ? 400 : 500,
      requestPath: `/api/wms/guarda/${id}/iniciar`,
      requestMethod: "POST",
      metadata: { pendencia_id: id, iniciada_por: iniciadaPor },
      extraResponseBody: isLock ? { iniciada_por: iniciadaPor, code } : undefined,
    });
  }
  ```
- [ ] Se `wmsErrorResponse` não suporta `extraResponseBody`, adicionar como passthrough ou usar `NextResponse.json` direto pro caso `isLock`. Verificar assinatura em `src/lib/wms/api-errors.ts` antes.

## Task 22 · Verify + commit

- [ ] Run cenário 40d → PASS.
- [ ] Run `npm run scenarios` full → todos passam.
- [ ] Commit:
  ```
  git add src/lib/wms/guarda.ts src/app/api/wms/guarda/[id]/iniciar/route.ts \
          scripts/wms/cenarios/catalogo/40d-iniciar-guarda-race.ts \
          scripts/wms/cenarios/_harness/context.ts
  git commit -m "fix(p3): #5.2 iniciarGuarda anti-race (conditional UPDATE)

  - UPDATE com WHERE iniciada_por IS NULL OR = usuario → 0 rows = 409
  - Re-entrada do mesmo operador é idempotente
  - Endpoint expõe iniciada_por no body 409 pra UI mostrar avatar do primeiro
  - Cenário 40d valida 2 ops paralelos = 1 ganha, 1 leva 409

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

# Phase 6 · New reverse endpoint · Estornar inventário aplicado (finding 4.2)

## Task 23 · Add helper `estornarSessaoInventario` to `src/lib/wms/inventario.ts`

- [ ] Append at end of `src/lib/wms/inventario.ts`:
  ```typescript
  /**
   * P3 #4.2: estorna uma sessão de inventário aplicada.
   *
   * Para cada divergência aplicada (status='aplicada' + mov_aplicada_id):
   *   1. Estorna a mov no ledger via estornarMovimentacao (cria contra-mov)
   *   2. Reseta divergencia.status='pendente' (volta pra fila do supervisor)
   *
   * Não toca em contagens — preserva trilha histórica do que foi contado.
   * Sessão volta pra status='revisao' (supervisor decide se re-aplica ou
   * cancela). Idempotente: re-execução não duplica estornos (estornarMov
   * recusa double-estorno).
   *
   * Falha gracefully se algum estorno bater em saldo negativo (ledger
   * coerência sobrepõe undo).
   */
  export async function estornarSessaoInventario(input: {
    sessao_id: string;
    usuario_id: string;
    motivo: string;
  }): Promise<{ movsEstornadas: number }> {
    if (!input.motivo || input.motivo.trim().length < 3) {
      throw new Error("motivo do estorno é obrigatório (≥3 caracteres)");
    }
    const sb = createServiceClient();
    const { data: sessao } = await sb
      .from("siso_inventario_sessoes")
      .select("id, status")
      .eq("id", input.sessao_id)
      .maybeSingle();
    if (!sessao) throw new Error("sessão não encontrada");
    const status = (sessao as { status: string }).status;
    if (status !== "aplicada") {
      throw new Error(`sessão em status ${status} — apenas 'aplicada' pode ser estornada`);
    }

    const { data: divs } = await sb
      .from("siso_inventario_divergencias")
      .select("id, mov_aplicada_id, status")
      .eq("sessao_id", input.sessao_id)
      .eq("status", "aplicada");

    let estornadas = 0;
    for (const d of (divs ?? []) as Array<{
      id: string;
      mov_aplicada_id: string | null;
      status: string;
    }>) {
      if (!d.mov_aplicada_id) continue;
      try {
        await estornarMovimentacao({
          mov_id: d.mov_aplicada_id,
          usuario_id: input.usuario_id,
          motivo: `Estorno sessão inventário ${input.sessao_id}: ${input.motivo}`,
        });
        estornadas++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/já foi estornada/.test(msg) || /já é um estorno/.test(msg)) {
          // Idempotência: outra request já estornou. Segue.
          continue;
        }
        throw err;
      }
      await sb
        .from("siso_inventario_divergencias")
        .update({ status: "pendente", mov_aplicada_id: null })
        .eq("id", d.id);
    }

    await sb
      .from("siso_inventario_sessoes")
      .update({ status: "revisao", aplicada_em: null })
      .eq("id", input.sessao_id)
      .eq("status", "aplicada");

    return { movsEstornadas: estornadas };
  }
  ```

## Task 24 · Create endpoint route file

- [ ] Create `src/app/api/wms/inventario/[id]/estornar/route.ts`:
  ```typescript
  import { NextRequest, NextResponse } from "next/server";
  import { requireAdmin } from "@/lib/wms/auth";
  import { wmsErrorResponse } from "@/lib/wms/api-errors";
  import { estornarSessaoInventario } from "@/lib/wms/inventario";

  /**
   * POST /api/wms/inventario/[id]/estornar
   *
   * Body: { motivo: string }
   *
   * Admin-only. Reverte movs de uma sessão aplicada e recoloca divergências
   * em status='pendente'. Sessão volta pra 'revisao'.
   */
  export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const { id } = await params;
    const body = await req.json().catch(() => null);
    const motivo = typeof body?.motivo === "string" ? body.motivo.trim() : "";
    if (motivo.length < 3) {
      return NextResponse.json(
        { error: "motivo é obrigatório (≥3 caracteres)" },
        { status: 400 },
      );
    }

    try {
      const r = await estornarSessaoInventario({
        sessao_id: id,
        usuario_id: auth.user.id,
        motivo,
      });
      return NextResponse.json({ ok: true, ...r });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isClient =
        msg.includes("não encontrada") ||
        msg.includes("apenas 'aplicada'") ||
        msg.includes("motivo");
      return wmsErrorResponse({
        source: "wms.inventario.estornar",
        error: e,
        status: isClient ? 400 : 500,
        requestPath: `/api/wms/inventario/${id}/estornar`,
        requestMethod: "POST",
        metadata: { sessao_id: id },
      });
    }
  }
  ```

## Task 25 · Add `requireAdmin` if it doesn't exist yet

- [ ] Check `src/lib/wms/auth.ts` for `requireAdmin`. If absent, add:
  ```typescript
  export async function requireAdmin(req: NextRequest): Promise<AuthResult> {
    const session = await getSessionUser(req);
    if (!session) {
      return { ok: false, response: NextResponse.json({ error: "sessao_invalida" }, { status: 401 }) };
    }
    if (!userCan(session, "admin")) {
      return { ok: false, response: NextResponse.json({ error: "acesso negado (admin only)" }, { status: 403 }) };
    }
    return { ok: true, user: session };
  }
  ```
- [ ] OR — if no `admin` permission exists yet — guard with cargo direto: `if (!session.cargos?.includes("admin")) return 403`. Verify pattern from existing endpoints.

## Task 26 · Add Ctx helper `estornarInventario` to harness

- [ ] Edit `scripts/wms/cenarios/_harness/types.ts` — Ctx type:
  ```typescript
  estornarInventario: (sessaoId: string, motivo?: string) => Promise<{ movsEstornadas: number }>;
  ```
- [ ] Edit `scripts/wms/cenarios/_harness/context.ts` — implementation:
  ```typescript
  async function estornarInventario(sessaoId: string, motivo = "teste cenário 41") {
    return ctx.http.post<{ movsEstornadas: number }>(
      `/api/wms/inventario/${sessaoId}/estornar`,
      { motivo },
    );
  }
  // Add to returned object: ..., estornarInventario, ...
  ```

## Task 27 · Write FAILING scenario 41-estornar-inventario-aplicado

- [ ] Create `scripts/wms/cenarios/catalogo/41-estornar-inventario-aplicado.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "41 — Estornar sessão inventário aplicada recoloca divergências pendentes",
    descricao: "Após aplicar sessão com 1 divergência E (ganho de 2), chamar /estornar reverte a mov no ledger, divergência volta pra status='pendente', sessão volta pra 'revisao'.",
    tags: ["p3", "inventario", "reverse"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("41");
      await ctx.criarProduto({ sku, descricao: "P3-41 estorno inventário" });
      await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-02", qty: 5 });
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const sess = await ctx.criarSessaoInventario({
        galpao: "CWB", locs: ["A-01-02"], modo: "blind", tipo: "cycle_count",
      });
      await ctx.entrarParty(sess.id);
      await ctx.proximaLoc(sess.id);
      // Bipa 7 (ganho de 2 — esperava 5)
      await ctx.bipeInventario({ sessao_id: sess.id, sku, loc: "A-01-02", qty: 7 });
      await ctx.finalizarLocInventario({ sessao_id: sess.id, loc: "A-01-02" });
      await ctx.aprovarInventario(sess.id);
      await ctx.aplicarInventario(sess.id);
      // Saldo agora é 7
      await ctx.assertSaldo(sku, "CWB", "A-01-02", 7);

      // Estorna
      const r = await ctx.estornarInventario(sess.id, "teste cenário 41");
      ctx.log("estornar-resultado", { ...r });
      if (r.movsEstornadas !== 1) {
        throw new Error(`esperava 1 mov estornada, achou ${r.movsEstornadas}`);
      }
    },

    assertEsperado: async (ctx, { sku }) => {
      // Saldo volta pra 5 (estorno cria S contra-mov)
      await ctx.assertSaldo(sku, "CWB", "A-01-02", 5);
      // Sessão volta pra 'revisao'
      const { data: s } = await ctx.sb
        .from("siso_inventario_sessoes")
        .select("status, aplicada_em")
        .eq("nome", null) // not enough; use ID from setup → see below
        .maybeSingle();
      // Simpler: query by SKU via produto_id join é frágil — usar contagens
      const { data: divs } = await ctx.sb
        .from("siso_inventario_divergencias")
        .select("status, mov_aplicada_id")
        .eq("status", "pendente");
      const found = (divs ?? []).find((d) => d.mov_aplicada_id === null);
      if (!found) {
        throw new Error("nenhuma divergência voltou pra status='pendente'");
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
- [ ] **Refine:** the assertion query needs the sessão id. Save it from `run` scope and pass via setup return type extension, OR query `siso_inventario_sessoes.galpao_id` filter ordered by `criado_em desc limit 1`. Truncate suite ensures isolation.
- [ ] Run cenário 41 → FAIL (endpoint não existe ainda, 404).

## Task 28 · Run cenário 41 → PASS

- [ ] Run `npx tsx scripts/wms/cenarios/catalogo/41-estornar-inventario-aplicado.ts`
- [ ] Expected: PASS + invariantes I1..I7 OK (saldo coerente após estorno).

## Task 29 · Hand-test idempotência: chamar /estornar 2x

- [ ] Manual via curl ou inline em cenário: 2ª chamada de `/estornar` deve retornar `movsEstornadas: 0` (mov original já estornada, helper pula via guard `/já foi estornada/`).
- [ ] OU 400 com mensagem `sessão em status revisao — apenas 'aplicada' pode ser estornada`. Ambos comportamentos são válidos; documentar qual saiu.

## Task 30 · Commit

- [ ] `git add src/lib/wms/inventario.ts src/app/api/wms/inventario/[id]/estornar/route.ts src/lib/wms/auth.ts scripts/wms/cenarios/_harness/{types,context}.ts scripts/wms/cenarios/catalogo/41-estornar-inventario-aplicado.ts`
- [ ] Commit message:
  ```
  fix(p3): #4.2 endpoint POST /inventario/[id]/estornar

  - estornarSessaoInventario reverte cada mov via estornarMovimentacao
  - Divergências voltam pra status='pendente', mov_aplicada_id=null
  - Sessão volta pra 'revisao'
  - Idempotente (re-estorno = movsEstornadas:0)
  - Admin-only via requireAdmin
  - Cenário 41 valida ganho 2 aplicado → estornado → saldo volta

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 7 · Validation hardening · reconciliar retroativo UUID (finding 8.6)

## Task 31 · Write FAILING scenario 41b-reconciliar-uuid-invalido

- [ ] Create `scripts/wms/cenarios/catalogo/41b-reconciliar-retroativo-uuid.ts`:
  - Setup: lança retroativo via `ctx.lancamentoRetroativo`.
  - Run: chama `POST /api/wms/lancamento-retroativo/[id]/reconciliar` com `body.compra_mov_id = "abc-not-uuid"` → espera 400 com mensagem clara.
  - Segundo POST com uuid válido mas inexistente → espera 404 ou 400.
  - assertEsperado: nenhuma mov de `estorno` foi criada nos dois casos.
- [ ] Run → FAIL (hoje aceita string qualquer; passa pra `reconciliarRetroativo` que ignora `compra_mov_id` e só estorna o retroativo).

## Task 32 · Implement validation in endpoint

- [ ] Edit `src/app/api/wms/lancamento-retroativo/[id]/reconciliar/route.ts`:
  ```typescript
  import { NextRequest, NextResponse } from "next/server";
  import { requireWarehouseAccess } from "@/lib/wms/auth";
  import { wmsErrorResponse } from "@/lib/wms/api-errors";
  import { reconciliarRetroativo } from "@/lib/wms/movimentacoes";
  import { createServiceClient } from "@/lib/supabase-server";

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) {
    const auth = await requireWarehouseAccess(req);
    if (!auth.ok) return auth.response;

    const { id } = await params;
    const body = await req.json().catch(() => null);
    const compraMovId = body?.compra_mov_id;
    if (!compraMovId || typeof compraMovId !== "string") {
      return NextResponse.json({ error: "compra_mov_id obrigatório" }, { status: 400 });
    }
    if (!UUID_RE.test(compraMovId)) {
      return NextResponse.json(
        { error: "compra_mov_id não é um uuid válido" },
        { status: 400 },
      );
    }
    // Verifica existência da mov de compra alvo.
    const sb = createServiceClient();
    const { data: compra } = await sb
      .from("siso_movimentacoes")
      .select("id, origem_tipo")
      .eq("id", compraMovId)
      .maybeSingle();
    if (!compra) {
      return NextResponse.json(
        { error: `compra_mov_id ${compraMovId} não existe em siso_movimentacoes` },
        { status: 404 },
      );
    }

    try {
      await reconciliarRetroativo({
        retroativo_mov_id: id,
        compra_mov_id: compraMovId,
        usuario_id: auth.user.id,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return wmsErrorResponse({
        source: "wms.lancamento-retroativo.reconciliar",
        error: e,
        status: 400,
        requestPath: `/api/wms/lancamento-retroativo/${id}/reconciliar`,
        requestMethod: "POST",
        metadata: { retroativo_mov_id: id, compra_mov_id: compraMovId },
      });
    }
  }
  ```

## Task 33 · Also propagate `compra_mov_id` to ledger origem_detalhes

- [ ] Edit `src/lib/wms/movimentacoes.ts` — função `reconciliarRetroativo`:
  - No `inserirMovimentacao` call, add `origem_detalhes: { compra_mov_id: input.compra_mov_id }` pra rastrear no ledger qual compra reconciliou (auditoria).
  - Atualizar `motivo` se nulo.

## Task 34 · Verify + commit

- [ ] Run cenário 41b → PASS.
- [ ] Run full suite → todos passam.
- [ ] Commit:
  ```
  fix(p3): #8.6 reconciliar retroativo valida uuid + existência

  - 400 se compra_mov_id não é uuid v4
  - 404 se uuid válido mas mov não existe
  - origem_detalhes do estorno carrega compra_mov_id pra trilha
  - Cenário 41b valida 2 caminhos de erro

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 8 · New reverse endpoint · Desfazer guarda (finding 5.1)

## Task 35 · Add `desfazerGuarda` helper to `src/lib/wms/guarda.ts`

- [ ] Append:
  ```typescript
  /**
   * P3 #5.1: desfaz uma guarda confirmada (total ou parcial).
   *
   * Estorna o par S+E intra-galpão (pendência → loc_destino vira loc_destino → pendência),
   * decrementa qty_guardada, devolve status pra 'pendente' (ou 'em_guarda' se ainda
   * houver qty_pendente).
   *
   * Sem qty: desfaz a última confirmação (qty_guardada não-zero mais recente).
   * Com qty: desfaz exatamente qty unidades (deve ≤ qty_guardada).
   *
   * Limitação: a pendência tem que estar em status 'pendente' ou 'guardada' (não cancelada).
   */
  export async function desfazerGuarda(input: {
    pendencia_id: string;
    qty?: number;
    usuario_id: string;
    motivo: string;
  }): Promise<{ pendencia: PendenciaJoined; movsEstornadas: number }> {
    if (!input.motivo || input.motivo.trim().length < 3) {
      throw new Error("motivo do undo é obrigatório (≥3 caracteres)");
    }
    const sb = createServiceClient();
    const pend = await obterPendencia(input.pendencia_id);
    if (!pend) throw new Error("pendência não encontrada");
    if (pend.status === "cancelada") {
      throw new Error("pendência cancelada — undo de guarda não se aplica");
    }
    if (Number(pend.qty_guardada) === 0) {
      throw new Error("pendência sem guardas confirmadas — nada a desfazer");
    }

    // Localiza as movs E (entrada na loc destino) ligadas a essa pendência.
    // origem_id das movs do replenishmentIntraGalpao é o lote da confirmação;
    // o link é via origem_tipo='transferencia_localizacao' + galpao_id +
    // produto_id + janela temporal. Mais simples: usar mov_entrada_id da
    // pendência como pivot.
    //
    // Estratégia: buscar todas as movs do par (S na loc RECEBIMENTO + E na
    // loc destino) com origem_tipo='transferencia_localizacao' e
    // origem_id IN (lista de confirmações dessa pendência).
    //
    // Idempotência: estornarMovimentacao recusa double-estorno. Se 2 chamadas
    // de desfazer chegam, 2ª retorna 0 estornadas.

    // P3 #5.1 simplificação: requer 1 confirmação por pendência (sem qty parcial
    // configurável aqui no MVP). Operador pode desfazer "a guarda" — estorna
    // exatamente qty_guardada. Se desfazer parcial for necessário, escalar
    // pra task futura.
    if (input.qty && input.qty !== Number(pend.qty_guardada)) {
      throw new Error(
        "MVP: desfazer parcial não suportado. Omita qty pra desfazer toda a guarda atual.",
      );
    }

    // Estorna par S+E. Busca movs por origem_id compartilhada com a confirmação.
    // confirmarGuarda compartilha origem_id entre as 2 movs (RPC garante).
    // Mas hoje pendência não armazena os origem_id das confirmações — vamos
    // adicionar coluna tracking_origem_ids text[] em migration separada.
    //
    // Fluxo MVP sem migration: busca movs pela tripla + janela [iniciada_em, now].
    const triplaProduto = pend.produto_id;
    const galpao = pend.galpao_id;
    const locOrigem = pend.localizacao_origem_id;

    const { data: movsS } = await sb
      .from("siso_movimentacoes")
      .select("id, origem_id, criado_em, quantidade, localizacao_id")
      .eq("origem_tipo", "transferencia_localizacao")
      .eq("produto_id", triplaProduto)
      .eq("galpao_id", galpao)
      .eq("localizacao_id", locOrigem)
      .eq("tipo", "S")
      .gte("criado_em", pend.iniciada_em ?? pend.criada_em ?? "1970-01-01")
      .order("criado_em", { ascending: false });

    // Filtra apenas os pares que ainda não foram estornados.
    const candidatos = (movsS ?? []) as Array<{ id: string; origem_id: string; quantidade: number }>;
    let movsEstornadas = 0;
    let qtyDesfeita = 0;
    const qtyAlvo = Number(input.qty ?? pend.qty_guardada);

    for (const m of candidatos) {
      if (qtyDesfeita >= qtyAlvo) break;
      try {
        // Estorna par: a S na origem + a E na destino. Ambas têm o mesmo origem_id.
        const { data: par } = await sb
          .from("siso_movimentacoes")
          .select("id, tipo")
          .eq("origem_id", m.origem_id)
          .eq("origem_tipo", "transferencia_localizacao");
        for (const p of (par ?? []) as Array<{ id: string; tipo: string }>) {
          await estornarMovimentacao({
            mov_id: p.id,
            usuario_id: input.usuario_id,
            motivo: `Desfaz guarda pendência ${input.pendencia_id}: ${input.motivo}`,
          });
          movsEstornadas++;
        }
        qtyDesfeita += Number(m.quantidade);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/já foi estornada|já é um estorno/.test(msg)) continue;
        throw err;
      }
    }

    // Atualiza pendência: decrementa qty_guardada, volta status.
    const novaQtyGuardada = Math.max(0, Number(pend.qty_guardada) - qtyDesfeita);
    const novoStatus = novaQtyGuardada > 0 ? "em_guarda" : "pendente";
    await sb
      .from("siso_wms_pendencias_guarda")
      .update({
        qty_guardada: novaQtyGuardada,
        status: novoStatus,
        guardada_em: novaQtyGuardada >= Number(pend.qty_inicial) ? pend.guardada_em : null,
      })
      .eq("id", input.pendencia_id);

    const refresh = await obterPendencia(input.pendencia_id);
    if (!refresh) throw new Error("pendência sumiu após desfazer");
    return { pendencia: refresh, movsEstornadas };
  }
  ```
- [ ] **Important:** the helper assumes confirmarGuarda S/E share `origem_id`. Verify in `replenishmentIntraGalpao` — yes, the function uses single `origem_id` for both legs. OK.

## Task 36 · Create endpoint route

- [ ] Create `src/app/api/wms/guarda/[id]/desfazer/route.ts`:
  ```typescript
  import { NextRequest, NextResponse } from "next/server";
  import { requireWarehouseAccess } from "@/lib/wms/auth";
  import { wmsErrorResponse } from "@/lib/wms/api-errors";
  import { desfazerGuarda } from "@/lib/wms/guarda";

  /**
   * POST /api/wms/guarda/[id]/desfazer
   *
   * Body: { motivo: string, qty?: number }
   *
   * Estorna par S+E da última (ou única) confirmação dessa pendência,
   * decrementa qty_guardada, recupera status='pendente'|'em_guarda'.
   */
  export async function POST(
    req: NextRequest,
    ctx: { params: Promise<{ id: string }> },
  ) {
    const auth = await requireWarehouseAccess(req);
    if (!auth.ok) return auth.response;
    const { id } = await ctx.params;

    const body = await req.json().catch(() => null);
    const motivo = typeof body?.motivo === "string" ? body.motivo.trim() : "";
    if (motivo.length < 3) {
      return NextResponse.json(
        { error: "motivo (≥3 chars) é obrigatório" },
        { status: 400 },
      );
    }
    const qty = body?.qty !== undefined ? Number(body.qty) : undefined;

    try {
      const r = await desfazerGuarda({
        pendencia_id: id,
        qty,
        usuario_id: auth.user.id,
        motivo,
      });
      return NextResponse.json({ ok: true, ...r });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isClient =
        msg.includes("não encontrada") ||
        msg.includes("cancelada") ||
        msg.includes("sem guardas") ||
        msg.includes("MVP") ||
        msg.includes("motivo");
      return wmsErrorResponse({
        source: "wms.guarda.desfazer",
        error: e,
        status: isClient ? 400 : 500,
        requestPath: `/api/wms/guarda/${id}/desfazer`,
        requestMethod: "POST",
        metadata: { pendencia_id: id, qty },
      });
    }
  }
  ```

## Task 37 · Add Ctx helper `desfazerGuarda`

- [ ] Edit `_harness/types.ts` and `_harness/context.ts`:
  ```typescript
  desfazerGuarda: (p: { pendencia_id: string; motivo?: string }) => Promise<{ movsEstornadas: number }>;
  ```

## Task 38 · Write FAILING scenario 42-desfazer-guarda

- [ ] Create `scripts/wms/cenarios/catalogo/42-desfazer-guarda.ts`:
  ```typescript
  import type { Cenario, Ctx } from "../_harness/types";

  export default {
    nome: "42 — Desfazer guarda confirmada reverte par S+E",
    descricao: "Recebe 10 unidades em CWB, confirma guarda total em A-02-01. Chama /desfazer → saldo em A-02-01 volta pra 0, saldo em RECEBIMENTO volta pra 10, pendência status='pendente'.",
    tags: ["p3", "guarda", "reverse"],

    setup: async (ctx: Ctx) => {
      const sku = ctx.skuUnico("42");
      await ctx.criarProduto({ sku, descricao: "P3-42 desfazer guarda" });
      return { sku };
    },

    run: async (ctx, { sku }) => {
      const { pendencias } = await ctx.receber({
        items: [{ sku, qty: 10 }],
        galpao: "CWB",
      });
      const pid = pendencias[0];
      // Confirma guarda total em A-02-01
      await ctx.guardar({ pendencia_id: pid, loc_destino: "A-02-01", qty: 10 });
      await ctx.assertSaldo(sku, "CWB", "A-02-01", 10);

      // Desfaz
      const r = await ctx.desfazerGuarda({ pendencia_id: pid, motivo: "cenário 42" });
      ctx.log("desfazer-guarda", { ...r });
      if (r.movsEstornadas !== 2) {
        throw new Error(`esperava 2 movs estornadas (par S+E), achou ${r.movsEstornadas}`);
      }
    },

    assertEsperado: async (ctx, { sku }) => {
      await ctx.assertSaldo(sku, "CWB", "A-02-01", 0);
      // Saldo de volta na RECEBIMENTO
      const { data: locReceb } = await ctx.sb
        .from("siso_localizacoes")
        .select("id")
        .eq("codigo", "RECEBIMENTO")
        .eq("galpao_id", ctx.staging.galpoes.cwb.id)
        .single();
      await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 10);
      // Pendência deve estar status='pendente'
      const { data: produto } = await ctx.sb
        .from("siso_produtos").select("id").eq("sku", sku).single();
      const { data: pend } = await ctx.sb
        .from("siso_wms_pendencias_guarda")
        .select("status, qty_guardada")
        .eq("produto_id", produto!.id)
        .single();
      if (pend?.status !== "pendente") {
        throw new Error(`esperava status='pendente', achou ${pend?.status}`);
      }
      if (Number(pend?.qty_guardada) !== 0) {
        throw new Error(`esperava qty_guardada=0, achou ${pend?.qty_guardada}`);
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
- [ ] Run cenário 42 → FAIL (endpoint 404 antes da Task 36).

## Task 39 · Run cenário 42 → PASS

- [ ] After Tasks 35-37, run cenário → PASS + invariantes I1, I5, I6 verdes (especialmente I6: par S+E balanceado pós-estorno).

## Task 40 · Idempotência check: 2ª chamada /desfazer

- [ ] Manual ou inline: chamar /desfazer 2x. 2ª deve retornar 400 com mensagem "sem guardas confirmadas — nada a desfazer". Documentar comportamento.

## Task 41 · Hand-test concurrent UI use case

- [ ] Manual via http: confirmar pendência parcial 5 + 5 (2 chamadas /confirmar com qty=5 cada). Tentar desfazer → MVP deve falhar com "MVP: desfazer parcial não suportado" se input.qty != qty_guardada total. Documentar — escalar pra task futura se necessário.

## Task 42 · Commit

- [ ] `git add src/lib/wms/guarda.ts src/app/api/wms/guarda/[id]/desfazer/route.ts scripts/wms/cenarios/_harness/{types,context}.ts scripts/wms/cenarios/catalogo/42-desfazer-guarda.ts`
- [ ] Commit:
  ```
  fix(p3): #5.1 endpoint POST /guarda/[id]/desfazer

  - desfazerGuarda reverte par S+E via estornarMovimentacao
  - Pendência volta pra 'pendente' (ou 'em_guarda' se qty_guardada residual)
  - Idempotente (2ª chamada → 400 com mensagem clara)
  - MVP: desfazer total apenas; parcial pra task futura
  - Cenário 42 valida 10 unidades guardadas → desfazer → saldo restituído

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 9 · New reverse endpoint · Desclassificar devolução (finding 6.3)

## Task 43 · Add `desclassificarDevolucao` helper to `src/lib/wms/devolucoes.ts`

- [ ] Append:
  ```typescript
  /**
   * P3 #6.3: reverte uma devolução classificada — estorna todas as movs
   * geradas e volta status='aguardando_classificacao'.
   *
   * Como classificarDevolucao não usa origem_id compartilhada hoje
   * (apenas origem_tipo+nota_fiscal_id+empresa_referencia_id), buscamos
   * as movs do par "classe X" pela combinação:
   *   - origem_tipo IN (devolucao_cliente_integra|avariada, transferencia_localizacao, devolucao_fornecedor_enviada, ajuste_manual)
   *   - nota_fiscal_id = devolucao.nota_fiscal_id (quando aplicável)
   *   - criado_em entre devolucao.classificada_em e classificada_em + 1min
   *
   * Estratégia mais robusta (recomendada longo prazo): adicionar coluna
   * `devolucao_id` em siso_movimentacoes via migration. Por ora, usar a
   * janela temporal porque classificarDevolucao escreve em sequência.
   */
  export async function desclassificarDevolucao(input: {
    devolucao_id: string;
    usuario_id: string;
    motivo: string;
  }): Promise<{ movsEstornadas: number }> {
    if (!input.motivo || input.motivo.trim().length < 3) {
      throw new Error("motivo da desclassificação é obrigatório (≥3 caracteres)");
    }
    const sb = createServiceClient();
    const { data: dev } = await sb
      .from("siso_devolucoes_pendentes")
      .select("*")
      .eq("id", input.devolucao_id)
      .maybeSingle();
    if (!dev) throw new Error("devolução não encontrada");
    const d = dev as {
      id: string;
      status: string;
      classificacao: string | null;
      classificada_em: string | null;
      nota_fiscal_id: number | null;
      produto_id: string | null;
      qty: number | null;
    };
    if (d.status !== "classificada") {
      throw new Error(`devolução em status ${d.status} — apenas 'classificada' pode ser desclassificada`);
    }
    if (!d.classificada_em) {
      throw new Error("devolução sem timestamp classificada_em — auditoria quebrada");
    }

    // Janela: classificada_em ± 1min (geração das movs é síncrona dentro
    // de classificarDevolucao; 1min é folgado).
    const t0 = new Date(d.classificada_em);
    const tEarly = new Date(t0.getTime() - 60_000).toISOString();
    const tLate = new Date(t0.getTime() + 60_000).toISOString();

    const origensRelevantes = [
      "devolucao_cliente_integra",
      "devolucao_cliente_avariada",
      "devolucao_fornecedor_enviada",
      "transferencia_localizacao",
      "ajuste_manual",
    ];

    let movsEstornadas = 0;
    let query = sb
      .from("siso_movimentacoes")
      .select("id")
      .in("origem_tipo", origensRelevantes)
      .gte("criado_em", tEarly)
      .lte("criado_em", tLate);
    if (d.nota_fiscal_id) {
      // nota_fiscal_id em movs é text (string do número); cast.
      query = query.eq("nota_fiscal_id", String(d.nota_fiscal_id));
    }
    if (d.produto_id) {
      query = query.eq("produto_id", d.produto_id);
    }
    const { data: movs } = await query;
    for (const m of (movs ?? []) as Array<{ id: string }>) {
      try {
        await estornarMovimentacao({
          mov_id: m.id,
          usuario_id: input.usuario_id,
          motivo: `Desclassifica devolução ${input.devolucao_id}: ${input.motivo}`,
        });
        movsEstornadas++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/já foi estornada|já é um estorno/.test(msg)) continue;
        throw err;
      }
    }

    await sb
      .from("siso_devolucoes_pendentes")
      .update({
        status: "aguardando_classificacao",
        classificacao: null,
        classificada_por: null,
        classificada_em: null,
      })
      .eq("id", input.devolucao_id);

    logger.info("wms.devolucoes", "desclassificada", {
      devolucao_id: input.devolucao_id,
      movs_estornadas: movsEstornadas,
    });

    return { movsEstornadas };
  }
  ```
- [ ] **Long-term TODO marker:** add comment that long-term we should add `devolucao_id text` column in `siso_movimentacoes` to make this lookup unambiguous. Tag for P6.

## Task 44 · Create endpoint route

- [ ] Create `src/app/api/wms/devolucoes/[id]/desclassificar/route.ts`:
  ```typescript
  import { NextRequest, NextResponse } from "next/server";
  import { requireWarehouseAccess } from "@/lib/wms/auth";
  import { wmsErrorResponse } from "@/lib/wms/api-errors";
  import { desclassificarDevolucao } from "@/lib/wms/devolucoes";

  /**
   * POST /api/wms/devolucoes/[id]/desclassificar
   *
   * Body: { motivo: string }
   *
   * Reverte classificação anterior, devolve devolução pra fila pendente.
   */
  export async function POST(
    req: NextRequest,
    ctx: { params: Promise<{ id: string }> },
  ) {
    const auth = await requireWarehouseAccess(req);
    if (!auth.ok) return auth.response;
    const { id } = await ctx.params;

    const body = await req.json().catch(() => null);
    const motivo = typeof body?.motivo === "string" ? body.motivo.trim() : "";
    if (motivo.length < 3) {
      return NextResponse.json({ error: "motivo (≥3 chars) é obrigatório" }, { status: 400 });
    }

    try {
      const r = await desclassificarDevolucao({
        devolucao_id: id,
        usuario_id: auth.user.id,
        motivo,
      });
      return NextResponse.json({ ok: true, ...r });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isClient =
        msg.includes("não encontrada") ||
        msg.includes("apenas 'classificada'") ||
        msg.includes("motivo") ||
        msg.includes("classificada_em");
      return wmsErrorResponse({
        source: "wms.devolucoes.desclassificar",
        error: e,
        status: isClient ? 400 : 500,
        requestPath: `/api/wms/devolucoes/${id}/desclassificar`,
        requestMethod: "POST",
        metadata: { devolucao_id: id },
      });
    }
  }
  ```

## Task 45 · Add Ctx helper `desclassificarDevolucao`

- [ ] Edit `_harness/types.ts` and `_harness/context.ts`:
  ```typescript
  desclassificarDevolucao: (p: { devolucao_id: string; motivo?: string }) => Promise<{ movsEstornadas: number }>;
  ```

## Task 46 · Write FAILING scenario 43-desclassificar-devolucao

- [ ] Create `scripts/wms/cenarios/catalogo/43-desclassificar-devolucao.ts`:
  - Setup: criar produto + saldo. Inserir devolução pendente direto via SQL (helper `criarDevolucaoPendente` no harness — ou usar cenário 10 como ponto de partida).
  - Run: classificar como 'integro' (classe A) via `ctx.classificarDevolucao`. Aguardar mov E criada. Depois chamar `/desclassificar` via novo Ctx helper.
  - assertEsperado: saldo voltou ao pre-classificação; devolução status='aguardando_classificacao'.
- [ ] Run → FAIL (endpoint inexistente).

## Task 47 · Run cenário 43 → PASS

- [ ] After Tasks 43-45, run → PASS.
- [ ] Inspect logs: confirm `desclassificada` log appears.

## Task 48 · Test re-classificação após desclassificar

- [ ] Inline ou cenário extra: após `/desclassificar`, chamar `/classificar` de novo como 'avariado'. Deve funcionar (devolução pendente de novo, agora gerar movs B). Saldo final: 0 na loc original + 0 na quarentena se loc quarentena existe, ou ajuste manual S na loc original.

## Task 49 · Commit

- [ ] `git add src/lib/wms/devolucoes.ts src/app/api/wms/devolucoes/[id]/desclassificar/route.ts scripts/wms/cenarios/_harness/{types,context}.ts scripts/wms/cenarios/catalogo/43-desclassificar-devolucao.ts`
- [ ] Commit:
  ```
  fix(p3): #6.3 endpoint POST /devolucoes/[id]/desclassificar

  - desclassificarDevolucao estorna movs por janela temporal (±60s da classificada_em)
  - Devolução volta pra 'aguardando_classificacao'; permite re-classificação
  - TODO P6: adicionar coluna devolucao_id em movs pra lookup determinístico
  - Cenário 43 valida classe A → desclassifica → re-classifica como B

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 10 · Atomic RPCs · `wms_replenishment_intra_galpao` + `wms_confirmar_guarda_atomico` (findings 8.8, 5.3)

## Task 50 · Baseline: run cenário 14 (replenishment intra-galpão)

- [ ] Run `npx tsx scripts/wms/cenarios/catalogo/14-replenishment-intra-galpao.ts`
- [ ] Confirm PASS. Output saved no log.

## Task 51 · Create migration: RPC `wms_replenishment_intra_galpao`

- [ ] Create `supabase/migrations/20260527_p3_rpc_wms_replenishment_atomico.sql`:
  ```sql
  -- P3 fix #8.8: replenishment intra-galpão transacional.
  --
  -- Hoje `replenishmentIntraGalpao` chama `inserirMovimentacao` 2x em loop
  -- TypeScript. Se a 1ª (S) passa e a 2ª (E) falha (ex: loc destino
  -- desativada entre chamadas), saldo "evapora" — sai da origem e nunca
  -- entra no destino. Wrap em RPC plpgsql traz tudo pra mesma transação.
  --
  -- Cada chamada gera 1 par S+E por item, compartilhando origem_id.
  -- Em caso de falha em qualquer leg, BEGIN/EXCEPTION RAISES propaga
  -- rollback automático da transação no PostgreSQL.

  CREATE OR REPLACE FUNCTION wms_replenishment_intra_galpao(
    p_galpao_id uuid,
    p_localizacao_origem_id uuid,
    p_localizacao_destino_id uuid,
    p_itens jsonb,             -- [{ produto_id: uuid, qty: numeric }]
    p_usuario_id uuid,
    p_observacoes text DEFAULT NULL,
    p_origem_id uuid DEFAULT NULL
  )
  RETURNS jsonb
  LANGUAGE plpgsql
  AS $$
  DECLARE
    v_origem_id uuid;
    v_item jsonb;
    v_mov_s_id uuid;
    v_mov_e_id uuid;
    v_mov_ids uuid[] := ARRAY[]::uuid[];
  BEGIN
    IF p_localizacao_origem_id = p_localizacao_destino_id THEN
      RAISE EXCEPTION 'origem e destino não podem ser a mesma localização'
        USING ERRCODE = '22023';
    END IF;
    IF p_itens IS NULL OR jsonb_array_length(p_itens) = 0 THEN
      RAISE EXCEPTION 'itens vazios'
        USING ERRCODE = '22023';
    END IF;

    v_origem_id := COALESCE(p_origem_id, gen_random_uuid());

    FOR v_item IN SELECT jsonb_array_elements(p_itens) LOOP
      -- Leg 1: SAÍDA da origem (chama RPC existente)
      SELECT wms_inserir_movimentacao(
        p_produto_id := (v_item->>'produto_id')::uuid,
        p_galpao_id := p_galpao_id,
        p_localizacao_id := p_localizacao_origem_id,
        p_tipo := 'S',
        p_quantidade := (v_item->>'qty')::numeric,
        p_origem_tipo := 'transferencia_localizacao',
        p_origem_id := v_origem_id::text,
        p_origem_detalhes := NULL,
        p_usuario_id := p_usuario_id,
        p_expira_em := NULL,
        p_estorno_de := NULL,
        p_empresa_compradora_id := NULL,
        p_empresa_vendedora_id := NULL,
        p_empresa_referencia_id := NULL,
        p_fornecedor_id := NULL,
        p_motivo := p_observacoes,
        p_cliente_nome := NULL,
        p_pedido_id := NULL,
        p_nota_fiscal_id := NULL,
        p_chave_acesso_nf := NULL,
        p_custo_unitario := NULL
      ) INTO v_mov_s_id;
      v_mov_ids := array_append(v_mov_ids, v_mov_s_id);

      -- Leg 2: ENTRADA no destino. Se falhar, transação inteira rollback.
      SELECT wms_inserir_movimentacao(
        p_produto_id := (v_item->>'produto_id')::uuid,
        p_galpao_id := p_galpao_id,
        p_localizacao_id := p_localizacao_destino_id,
        p_tipo := 'E',
        p_quantidade := (v_item->>'qty')::numeric,
        p_origem_tipo := 'transferencia_localizacao',
        p_origem_id := v_origem_id::text,
        p_origem_detalhes := NULL,
        p_usuario_id := p_usuario_id,
        p_expira_em := NULL,
        p_estorno_de := NULL,
        p_empresa_compradora_id := NULL,
        p_empresa_vendedora_id := NULL,
        p_empresa_referencia_id := NULL,
        p_fornecedor_id := NULL,
        p_motivo := p_observacoes,
        p_cliente_nome := NULL,
        p_pedido_id := NULL,
        p_nota_fiscal_id := NULL,
        p_chave_acesso_nf := NULL,
        p_custo_unitario := NULL
      ) INTO v_mov_e_id;
      v_mov_ids := array_append(v_mov_ids, v_mov_e_id);
    END LOOP;

    RETURN jsonb_build_object(
      'origem_id', v_origem_id,
      'mov_ids', to_jsonb(v_mov_ids)
    );
  END;
  $$;

  COMMENT ON FUNCTION wms_replenishment_intra_galpao(uuid,uuid,uuid,jsonb,uuid,text,uuid) IS
    'P3 #8.8: replenishment intra-galpão atômico. Par S+E na mesma transação.';
  ```
- [ ] Apply via `mcp__supabase__apply_migration`.

## Task 52 · Refactor `replenishmentIntraGalpao` to use the RPC

- [ ] Edit `src/lib/wms/movimentacoes.ts`:
  ```typescript
  export async function replenishmentIntraGalpao(
    input: ReplenishmentInput,
  ): Promise<{ origem_id: string; mov_ids: string[] }> {
    validarTransferenciaIntraGalpao(input);
    const sb = createServiceClient();
    const { data, error } = await sb.rpc("wms_replenishment_intra_galpao", {
      p_galpao_id: input.galpao_id,
      p_localizacao_origem_id: input.localizacao_origem_id,
      p_localizacao_destino_id: input.localizacao_destino_id,
      p_itens: input.itens.map((i) => ({ produto_id: i.produto_id, qty: i.qty })),
      p_usuario_id: input.usuario_id,
      p_observacoes: input.observacoes ?? null,
      p_origem_id: input.origem_id ?? null,
    });
    if (error) {
      logger.error("wms.replenishment", "RPC falhou", { error });
      throw error;
    }
    const r = data as { origem_id: string; mov_ids: string[] };
    return { origem_id: r.origem_id, mov_ids: r.mov_ids };
  }
  ```
- [ ] **Atenção:** o retorno do helper agora inclui `mov_ids`. Verificar quem consome (especialmente `confirmarGuarda`) e não quebrar tipo.

## Task 53 · Update `confirmarGuarda` consumer

- [ ] `src/lib/wms/guarda.ts` — função `confirmarGuarda` chama `replenishmentIntraGalpao` e usa `origem_id`. Adaptar pra preservar comportamento + opcionalmente salvar `mov_ids` em `siso_wms_pendencias_guarda.tracking_mov_ids` (jsonb, ADD COLUMN se quisermos rastreio explícito).
- [ ] **MVP decision:** não adicionar coluna agora — usar `desfazerGuarda` strategy de busca por janela temporal já implementada em Phase 8.

## Task 54 · Verify cenário 14 ainda passa pós-RPC

- [ ] Run `npx tsx scripts/wms/cenarios/catalogo/14-replenishment-intra-galpao.ts`
- [ ] Expected: PASS (mesmo invariantes I1/I6).

## Task 55 · Write scenario 44-replenishment-atomico-rollback

- [ ] Create `scripts/wms/cenarios/catalogo/44-replenishment-atomico-rollback.ts`:
  - Setup: criar produto, semear saldo apenas em A-01 (origem).
  - Run: chamar replenishment com loc destino INVÁLIDA (uuid que existe mas é de OUTRO galpão — força erro no leg 2).
  - assertEsperado: zero movs criadas (transação inteira rollback). Saldo em A-01 intacto.
- [ ] Run → deve FAIL hoje (pré-RPC, mov S é criada antes do erro no E). Após Task 52 → PASS.

## Task 56 · Verify scenario 44 PASS

- [ ] Run → PASS. Confirm zero movs.

## Task 57 · Create migration: RPC `wms_confirmar_guarda_atomico`

- [ ] Create `supabase/migrations/20260527_p3_rpc_wms_confirmar_guarda_atomico.sql`:
  ```sql
  -- P3 fix #5.3 + #5.8: confirmar guarda atômico com lock pessimista.
  --
  -- Hoje confirmarGuarda lê pendência → valida → chama replenishment →
  -- atualiza pendência. Race entre leitura e UPDATE pode causar
  -- over-decremento (2 confirmações concorrentes da mesma pendência).
  --
  -- RPC envolve tudo em SELECT FOR UPDATE no row da pendência + chamada
  -- ao RPC de replenishment + UPDATE final, tudo na mesma transação.

  CREATE OR REPLACE FUNCTION wms_confirmar_guarda_atomico(
    p_pendencia_id uuid,
    p_qty numeric,
    p_localizacao_destino_id uuid,
    p_usuario_id uuid
  )
  RETURNS jsonb
  LANGUAGE plpgsql
  AS $$
  DECLARE
    v_pend RECORD;
    v_loc_dest RECORD;
    v_repl_result jsonb;
    v_nova_qty_guardada numeric;
    v_totalmente boolean;
    v_novo_status text;
  BEGIN
    IF p_qty <= 0 THEN
      RAISE EXCEPTION 'qty deve ser > 0' USING ERRCODE = '22023';
    END IF;

    -- LOCK pessimista no row da pendência. Concurrentes ficam esperando.
    SELECT id, produto_id, galpao_id, localizacao_origem_id, qty_inicial,
           qty_guardada, qty_pendente, status, guardada_em
    INTO v_pend
    FROM siso_wms_pendencias_guarda
    WHERE id = p_pendencia_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'pendência não encontrada' USING ERRCODE = 'NO_DATA_FOUND';
    END IF;

    IF v_pend.status = 'guardada' OR v_pend.status = 'cancelada' THEN
      RAISE EXCEPTION 'pendência em status terminal (%)', v_pend.status
        USING ERRCODE = '22023';
    END IF;

    IF p_qty > v_pend.qty_pendente THEN
      RAISE EXCEPTION 'qty (%) excede pendente (%)', p_qty, v_pend.qty_pendente
        USING ERRCODE = '22023';
    END IF;

    IF p_localizacao_destino_id = v_pend.localizacao_origem_id THEN
      RAISE EXCEPTION 'loc destino não pode ser a loc de recebimento (origem da guarda)'
        USING ERRCODE = '22023';
    END IF;

    -- Valida loc destino: existe, ativa, mesmo galpão
    SELECT id, galpao_id, ativo INTO v_loc_dest
    FROM siso_localizacoes WHERE id = p_localizacao_destino_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'localização destino não encontrada' USING ERRCODE = 'NO_DATA_FOUND';
    END IF;
    IF NOT v_loc_dest.ativo THEN
      RAISE EXCEPTION 'localização destino inativa' USING ERRCODE = '22023';
    END IF;
    IF v_loc_dest.galpao_id <> v_pend.galpao_id THEN
      RAISE EXCEPTION 'localização destino é de outro galpão' USING ERRCODE = '22023';
    END IF;

    -- Replenishment atômico (par S+E).
    SELECT wms_replenishment_intra_galpao(
      p_galpao_id := v_pend.galpao_id,
      p_localizacao_origem_id := v_pend.localizacao_origem_id,
      p_localizacao_destino_id := p_localizacao_destino_id,
      p_itens := jsonb_build_array(
        jsonb_build_object('produto_id', v_pend.produto_id, 'qty', p_qty)
      ),
      p_usuario_id := p_usuario_id,
      p_observacoes := NULL,
      p_origem_id := NULL
    ) INTO v_repl_result;

    v_nova_qty_guardada := v_pend.qty_guardada + p_qty;
    v_totalmente := v_nova_qty_guardada >= v_pend.qty_inicial;
    v_novo_status := CASE WHEN v_totalmente THEN 'guardada' ELSE 'pendente' END;

    UPDATE siso_wms_pendencias_guarda
    SET qty_guardada = v_nova_qty_guardada,
        status = v_novo_status,
        guardada_em = CASE WHEN v_totalmente THEN now() ELSE NULL END
    WHERE id = p_pendencia_id;

    RETURN jsonb_build_object(
      'pendencia_id', p_pendencia_id,
      'origem_id', v_repl_result->>'origem_id',
      'mov_ids', v_repl_result->'mov_ids',
      'totalmente_guardada', v_totalmente,
      'qty_guardada', v_nova_qty_guardada,
      'status', v_novo_status
    );
  END;
  $$;

  COMMENT ON FUNCTION wms_confirmar_guarda_atomico(uuid,numeric,uuid,uuid) IS
    'P3 #5.3 + #5.8: confirmar guarda atômico com FOR UPDATE no row da pendência.';
  ```
- [ ] Apply.

## Task 58 · Refactor `confirmarGuarda` to use the RPC + commit

- [ ] Edit `src/lib/wms/guarda.ts`:
  ```typescript
  export async function confirmarGuarda(
    input: ConfirmarGuardaInput,
  ): Promise<ConfirmarGuardaResult> {
    if (!input.qty || input.qty <= 0) {
      throw new Error("qty deve ser > 0");
    }
    const sb = createServiceClient();
    const { data, error } = await sb.rpc("wms_confirmar_guarda_atomico", {
      p_pendencia_id: input.pendencia_id,
      p_qty: input.qty,
      p_localizacao_destino_id: input.localizacao_destino_id,
      p_usuario_id: input.usuario_id,
    });
    if (error) {
      logger.error(LOG_SOURCE, "confirmarGuarda RPC falhou", { error });
      throw error;
    }
    const r = data as {
      pendencia_id: string;
      origem_id: string;
      mov_ids: string[];
      totalmente_guardada: boolean;
      qty_guardada: number;
      status: string;
    };
    const refresh = await obterPendencia(input.pendencia_id);
    if (!refresh) throw new Error("pendência sumiu após confirmar");
    return {
      pendencia: refresh,
      origem_id: r.origem_id,
      totalmente_guardada: r.totalmente_guardada,
    };
  }
  ```
- [ ] Run cenário 8 (receber-guarda-parcial) e 42 (desfazer guarda) → ambos PASS.
- [ ] Run `npm run scenarios` full → todos passam.
- [ ] Commit:
  ```
  fix(p3): #5.3 #5.8 #8.8 RPCs atômicos pra replenishment + confirmar guarda

  - wms_replenishment_intra_galpao(jsonb itens) — par S+E na mesma transação
  - wms_confirmar_guarda_atomico — FOR UPDATE na pendência + replenishment + update
  - replenishmentIntraGalpao + confirmarGuarda agora chamam as RPCs
  - Cenário 44 valida rollback quando leg 2 falha (zero movs)
  - Cenário 14 + 8 + 42 continuam verdes

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 11 · New reverse endpoint · Cancelar venda manual (finding 7.13)

## Task 59 · Add `cancelarVendaManual` helper to existing vendas-cancelamento file (or new)

- [ ] Check `src/lib/wms/vendas-*.ts` for existing cancelamento helper. Provavelmente não existe.
- [ ] Create `src/lib/wms/vendas-cancelamento.ts`:
  ```typescript
  import { createServiceClient } from "@/lib/supabase-server";
  import { estornarMovimentacao } from "./ledger";
  import { liberarReserva } from "./reservas";
  import { registrarEvento } from "@/lib/historico-service";

  /**
   * P3 #7.13: cancela uma venda manual.
   *
   * Casos:
   *   - Venda em status_separacao='aguardando_separacao' (modo separação ainda não picada):
   *     libera reservas R, marca pedido como 'cancelado'.
   *   - Venda em status='concluido' com mov de baixa_direta (modo baixa direta):
   *     estorna a mov de venda, marca pedido como 'cancelado'.
   *   - Venda em separação ativa ('em_separacao', 'separado', 'embalado'):
   *     400 — operador precisa primeiro voltar etapa ou usar endpoint
   *     /separacao/cancelar pra reverter picks.
   */
  export async function cancelarVendaManual(input: {
    pedido_id: string;
    usuario_id: string;
    motivo: string;
  }): Promise<{ movsEstornadas: number; reservasLiberadas: number }> {
    if (!input.motivo || input.motivo.trim().length < 3) {
      throw new Error("motivo do cancelamento é obrigatório (≥3 caracteres)");
    }
    const sb = createServiceClient();
    const { data: pedido } = await sb
      .from("siso_pedidos")
      .select("id, status, status_separacao, origem_detalhes")
      .eq("id", input.pedido_id)
      .maybeSingle();
    if (!pedido) throw new Error("pedido não encontrado");
    const p = pedido as {
      id: string;
      status: string;
      status_separacao: string | null;
      origem_detalhes: Record<string, unknown> | null;
    };

    const origem = p.origem_detalhes?.["fonte"] ?? null;
    // Aceita venda manual OU ML/Shopee — descomentar se restringir.

    if (p.status === "cancelado") {
      return { movsEstornadas: 0, reservasLiberadas: 0 }; // idempotente
    }

    if (["em_separacao", "separado", "embalado"].includes(p.status_separacao ?? "")) {
      throw new Error(
        "pedido em separação ativa — use voltar-etapa antes de cancelar (preserva auditoria de picks)",
      );
    }

    let movsEstornadas = 0;
    let reservasLiberadas = 0;

    // Caminho 1: separação ainda não iniciada — libera R.
    if (p.status_separacao === "aguardando_separacao" || p.status_separacao === "aguardando_compra") {
      const r = await liberarReserva({
        pedido_id: input.pedido_id,
        motivo: `Cancelamento venda manual: ${input.motivo}`,
        usuario_id: input.usuario_id,
      });
      reservasLiberadas = r?.liberadas ?? 0;
    }

    // Caminho 2: baixa direta — estorna mov de venda_manual.
    const { data: movsVenda } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("pedido_id", input.pedido_id)
      .eq("origem_tipo", "venda_manual")
      .eq("tipo", "S");
    for (const m of (movsVenda ?? []) as Array<{ id: string }>) {
      try {
        await estornarMovimentacao({
          mov_id: m.id,
          usuario_id: input.usuario_id,
          motivo: `Cancelamento venda manual: ${input.motivo}`,
        });
        movsEstornadas++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/já foi estornada|já é um estorno/.test(msg)) continue;
        throw err;
      }
    }

    await sb
      .from("siso_pedidos")
      .update({ status: "cancelado", cancelado_em: new Date().toISOString() })
      .eq("id", input.pedido_id);

    await registrarEvento({
      pedido_id: input.pedido_id,
      evento: "venda_cancelada",
      detalhes: {
        motivo: input.motivo,
        movs_estornadas: movsEstornadas,
        reservas_liberadas: reservasLiberadas,
      },
      usuario_id: input.usuario_id,
    }).catch(() => {/* fire-and-forget */});

    return { movsEstornadas, reservasLiberadas };
  }
  ```

## Task 60 · Create endpoint

- [ ] Create `src/app/api/wms/vendas/[id]/cancelar/route.ts`:
  ```typescript
  import { NextRequest, NextResponse } from "next/server";
  import { requireWarehouseAccess } from "@/lib/wms/auth";
  import { wmsErrorResponse } from "@/lib/wms/api-errors";
  import { cancelarVendaManual } from "@/lib/wms/vendas-cancelamento";

  /**
   * POST /api/wms/vendas/[id]/cancelar
   * Body: { motivo: string }
   *
   * Cancela venda manual: libera R se ainda não picada, estorna mov se baixa direta.
   * Pedido em separação ativa retorna 400.
   */
  export async function POST(
    req: NextRequest,
    ctx: { params: Promise<{ id: string }> },
  ) {
    const auth = await requireWarehouseAccess(req);
    if (!auth.ok) return auth.response;
    const { id } = await ctx.params;

    const body = await req.json().catch(() => null);
    const motivo = typeof body?.motivo === "string" ? body.motivo.trim() : "";
    if (motivo.length < 3) {
      return NextResponse.json({ error: "motivo (≥3 chars) é obrigatório" }, { status: 400 });
    }

    try {
      const r = await cancelarVendaManual({
        pedido_id: id,
        usuario_id: auth.user.id,
        motivo,
      });
      return NextResponse.json({ ok: true, ...r });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isClient =
        msg.includes("não encontrado") ||
        msg.includes("separação ativa") ||
        msg.includes("motivo");
      return wmsErrorResponse({
        source: "wms.vendas.cancelar",
        error: e,
        status: isClient ? 400 : 500,
        requestPath: `/api/wms/vendas/${id}/cancelar`,
        requestMethod: "POST",
        metadata: { pedido_id: id },
      });
    }
  }
  ```

## Task 61 · Add Ctx helper

- [ ] `cancelarVenda: (p: { pedido_id: string; motivo?: string }) => Promise<{ movsEstornadas: number; reservasLiberadas: number }>;`

## Task 62 · Write FAILING scenario 45-cancelar-venda-baixa-direta

- [ ] Create `scripts/wms/cenarios/catalogo/45-cancelar-venda-baixa-direta.ts`:
  - Setup: criar produto + saldo.
  - Run: criar venda em modo `baixa_direta` (sai mov S imediata). Assert saldo decremented. Chamar `/cancelar`. Assert saldo restored.
  - assertEsperado: saldo final == saldo inicial; pedido status='cancelado'; pelo menos 1 mov estornada.
- [ ] Run → FAIL.

## Task 63 · Write scenario 45b-cancelar-venda-separacao

- [ ] Create `scripts/wms/cenarios/catalogo/45b-cancelar-venda-separacao.ts`:
  - Setup: criar produto + saldo.
  - Run: criar venda modo `separacao` (cria R, pedido em aguardando_separacao). Cancelar → R liberada, pedido cancelado.
  - assertEsperado: reservas=0; saldo intacto; pedido status='cancelado'.
- [ ] Run → FAIL.

## Task 64 · Implement + run both → PASS

- [ ] After Tasks 59-61 implementations, run both cenários → PASS.

## Task 65 · Commit

- [ ] Commit:
  ```
  fix(p3): #7.13 endpoint POST /vendas/[id]/cancelar

  - cancelarVendaManual:
    * baixa direta → estorna mov S
    * separação não iniciada → libera R
    * separação ativa → 400 (use voltar-etapa)
  - Cenários 45 + 45b validam ambos caminhos
  - Idempotente (re-cancelar = 0 movs/0 reservas)

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 12 · New reverse endpoint · Desfazer recebimento de transferência (finding 8.2)

## Task 66 · Add `desfazerRecebimentoTransferencia` helper

- [ ] Edit `src/lib/wms/transferencias.ts` (verify exists) or `src/lib/wms/movimentacoes.ts`:
  - Append helper:
  ```typescript
  /**
   * P3 #8.2: desfaz o recebimento de uma transferência (parcial ou total).
   *
   * Estorna o leg E (entrada no galpão destino) das movs ligadas via origem_id
   * da transferência. Volta status_recebimento dos itens-linha pra null e
   * status header de 'recebida'→'em_transito' (ou 'recebida_parcial'→'em_transito').
   */
  export async function desfazerRecebimentoTransferencia(input: {
    transferencia_id: string;
    usuario_id: string;
    motivo: string;
  }): Promise<{ movsEstornadas: number }> {
    if (!input.motivo || input.motivo.trim().length < 3) {
      throw new Error("motivo é obrigatório (≥3 caracteres)");
    }
    const sb = createServiceClient();
    const { data: header } = await sb
      .from("siso_transferencias_galpao")
      .select("id, status, origem_id")
      .eq("id", input.transferencia_id)
      .maybeSingle();
    if (!header) throw new Error("transferência não encontrada");
    const h = header as { id: string; status: string; origem_id: string | null };
    if (!["recebida", "recebida_parcial"].includes(h.status)) {
      throw new Error(`transferência em status ${h.status} — apenas 'recebida' ou 'recebida_parcial' pode ter recebimento desfeito`);
    }
    if (!h.origem_id) {
      throw new Error("transferência sem origem_id — auditoria quebrada");
    }

    // Estorna apenas o LEG E (entrada destino). Leg S (saída origem) fica
    // — está em outro galpão e ainda é válido enquanto o item estiver "em transit".
    const { data: movsE } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("origem_id", h.origem_id)
      .eq("origem_tipo", "transferencia_galpao")
      .eq("tipo", "E");

    let estornadas = 0;
    for (const m of (movsE ?? []) as Array<{ id: string }>) {
      try {
        await estornarMovimentacao({
          mov_id: m.id,
          usuario_id: input.usuario_id,
          motivo: `Desfaz recebimento transferência ${input.transferencia_id}: ${input.motivo}`,
        });
        estornadas++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/já foi estornada|já é um estorno/.test(msg)) continue;
        throw err;
      }
    }

    // Reset itens (recebida_em=null, qty_recebida=0)
    await sb
      .from("siso_transferencia_itens")
      .update({ recebida_em: null, qty_recebida: 0, localizacao_destino_id: null })
      .eq("transferencia_id", input.transferencia_id);

    // Header volta pra 'em_transito'
    await sb
      .from("siso_transferencias_galpao")
      .update({ status: "em_transito", recebida_em: null })
      .eq("id", input.transferencia_id);

    return { movsEstornadas: estornadas };
  }
  ```

## Task 67 · Create endpoint

- [ ] Create `src/app/api/wms/transferencias/[id]/desfazer-recebimento/route.ts`:
  ```typescript
  import { NextRequest, NextResponse } from "next/server";
  import { requireWarehouseAccess } from "@/lib/wms/auth";
  import { wmsErrorResponse } from "@/lib/wms/api-errors";
  import { desfazerRecebimentoTransferencia } from "@/lib/wms/movimentacoes";

  export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) {
    const auth = await requireWarehouseAccess(req);
    if (!auth.ok) return auth.response;

    const { id } = await params;
    const body = await req.json().catch(() => null);
    const motivo = typeof body?.motivo === "string" ? body.motivo.trim() : "";
    if (motivo.length < 3) {
      return NextResponse.json({ error: "motivo (≥3 chars) é obrigatório" }, { status: 400 });
    }
    try {
      const r = await desfazerRecebimentoTransferencia({
        transferencia_id: id,
        usuario_id: auth.user.id,
        motivo,
      });
      return NextResponse.json({ ok: true, ...r });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isClient =
        msg.includes("não encontrada") ||
        msg.includes("apenas 'recebida'") ||
        msg.includes("auditoria quebrada") ||
        msg.includes("motivo");
      return wmsErrorResponse({
        source: "wms.transferencias.desfazer-recebimento",
        error: e,
        status: isClient ? 400 : 500,
        requestPath: `/api/wms/transferencias/${id}/desfazer-recebimento`,
        requestMethod: "POST",
        metadata: { transferencia_id: id },
      });
    }
  }
  ```

## Task 68 · Add Ctx helper

- [ ] `desfazerRecebimentoTransferencia: (p: { transferencia_id: string; motivo?: string }) => Promise<{ movsEstornadas: number }>;`

## Task 69 · Write FAILING scenario 46-desfazer-recebimento-transferencia

- [ ] Create `scripts/wms/cenarios/catalogo/46-desfazer-recebimento-transferencia.ts`:
  - Setup: criar produto + saldo no CWB.
  - Run: criar transferência CWB→SP de 5 unidades. Receber em SP em loc B-01. Assert saldo CWB=0, SP B-01=5. Chamar `/desfazer-recebimento`. Assert saldo SP B-01=0 (estornado).
  - assertEsperado: header status='em_transito'; itens recebida_em=null; saldo SP=0.
- [ ] Run → FAIL.

## Task 70 · Implement + run → PASS

- [ ] After Tasks 66-68, run → PASS.

## Task 71 · Hand-test: receber novamente após desfazer

- [ ] Inline ou cenário extra: após desfazer, chamar `/receber` de novo com qty diferente. Deve funcionar (transferência voltou pra em_transito).

## Task 72 · Commit

- [ ] Commit:
  ```
  fix(p3): #8.2 endpoint POST /transferencias/[id]/desfazer-recebimento

  - desfazerRecebimentoTransferencia estorna apenas leg E (entrada destino)
  - Itens recebida_em=null, qty_recebida=0; header volta pra 'em_transito'
  - Idempotente; pode re-receber após desfazer
  - Cenário 46 valida fluxo full

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 13 · Cancelar transferência parcial (finding 8.3)

## Task 73 · Implement parcial-aware cancelamento

- [ ] Edit `src/lib/wms/transferencias.ts` (ou wherever `cancelarTransferencia` lives — search first):
  ```typescript
  export async function cancelarTransferencia(
    transferencia_id: string,
    usuario_id: string,
    motivo?: string,
  ): Promise<{ movsEstornadas: number; itensComRecebimentoParcial: number }> {
    const sb = createServiceClient();
    const { data: header } = await sb
      .from("siso_transferencias_galpao")
      .select("id, status, origem_id")
      .eq("id", transferencia_id)
      .maybeSingle();
    if (!header) throw new Error("transferência não encontrada");
    const h = header as { id: string; status: string; origem_id: string | null };

    // P3 #8.3: aceita em_transito (sem recepção alguma) E recebida_parcial.
    // Status 'recebida' (full) NÃO pode mais ser cancelada — operador
    // precisa usar /desfazer-recebimento primeiro.
    if (!["em_transito", "recebida_parcial"].includes(h.status)) {
      throw new Error(
        `transferência em status ${h.status} — apenas 'em_transito' ou 'recebida_parcial' podem ser canceladas. Para 'recebida', use /desfazer-recebimento primeiro.`,
      );
    }

    // Para cada item: se tinha qty_recebida > 0 (parcial), estorna a mov E correspondente
    // ANTES de estornar a mov S original. Sem isso, saldo destino fica órfão.
    const { data: itens } = await sb
      .from("siso_transferencia_itens")
      .select("id, produto_id, qty, qty_recebida, localizacao_destino_id, recebida_em")
      .eq("transferencia_id", transferencia_id);

    let movsEstornadas = 0;
    let parciais = 0;

    for (const item of (itens ?? []) as Array<{
      id: string;
      qty_recebida: number | null;
      recebida_em: string | null;
    }>) {
      if (Number(item.qty_recebida ?? 0) > 0) {
        parciais++;
        // Estorna o leg E desse item (mov específica recebida).
        // Identifica via origem_id + tipo='E' + produto_id no destino.
        // (mesma estratégia de desfazer-recebimento, mas item-by-item)
        // ... implementação simétrica ao Task 66
      }
    }

    // Estorna leg S do header (saída na origem) — só agora que destinos estão limpos.
    if (h.origem_id) {
      const { data: movsS } = await sb
        .from("siso_movimentacoes")
        .select("id")
        .eq("origem_id", h.origem_id)
        .eq("origem_tipo", "transferencia_galpao")
        .eq("tipo", "S");
      for (const m of (movsS ?? []) as Array<{ id: string }>) {
        try {
          await estornarMovimentacao({
            mov_id: m.id,
            usuario_id,
            motivo: motivo ?? `Cancelamento transferência ${transferencia_id}`,
          });
          movsEstornadas++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/já foi estornada|já é um estorno/.test(msg)) continue;
          throw err;
        }
      }
    }

    await sb
      .from("siso_transferencias_galpao")
      .update({ status: "cancelada", cancelada_em: new Date().toISOString() })
      .eq("id", transferencia_id);

    return { movsEstornadas, itensComRecebimentoParcial: parciais };
  }
  ```

## Task 74 · Write scenario 46b-cancelar-transferencia-parcial + commit

- [ ] Create `scripts/wms/cenarios/catalogo/46b-cancelar-transferencia-parcial.ts`:
  - Setup: criar produto + saldo CWB.
  - Run: criar transferência CWB→SP de 10 unidades. Receber em SP **apenas 6** (parcial; assumindo helper de recepção parcial existe ou usar receber com qty < total). Chamar `/cancelar`. Assert saldo CWB=10 (estornado o S), SP=0 (estornado os 6 E).
- [ ] Run → FAIL.
- [ ] Implement → PASS.
- [ ] Commit:
  ```
  fix(p3): #8.3 cancelar transferência aceita recebida_parcial

  - cancelarTransferencia agora aceita status em ('em_transito', 'recebida_parcial')
  - Estorna primeiro legs E dos itens com qty_recebida > 0
  - Depois estorna leg S do header
  - Status 'recebida' (full) rejeita com mensagem apontando /desfazer-recebimento
  - Cenário 46b valida parcial cancelado restaura ambos lados

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 14 · `computarDivergencias` aviso de operadores ativos (findings 4.5, 4.6)

## Task 75 · Add helper `listarOperadoresAtivos` to inventario.ts

- [ ] Append in `src/lib/wms/inventario.ts`:
  ```typescript
  export async function listarOperadoresAtivos(sessao_id: string): Promise<
    Array<{ usuario_id: string; nome: string | null }>
  > {
    const sb = createServiceClient();
    const { data } = await sb
      .from("siso_inventario_operadores")
      .select("usuario_id, usuario:siso_usuarios(nome)")
      .eq("sessao_id", sessao_id)
      .is("finalizado_em", null);
    return ((data ?? []) as Array<{ usuario_id: string; usuario: { nome: string | null } | null }>).map(
      (r) => ({ usuario_id: r.usuario_id, nome: r.usuario?.nome ?? null }),
    );
  }
  ```

## Task 76 · Modify `computarDivergencias` to surface warning + cleanup locks `em_contagem` órfãs

- [ ] In same file, locate `computarDivergencias` function. Add at start:
  ```typescript
  // P3 #4.5: warning se há operadores ativos. Caller pode optar por confirmar
  // (caso supervisor de fato quer encerrar) ou abortar.
  const ativos = await listarOperadoresAtivos(sessaoId);
  if (ativos.length > 0 && !opts?.forceWithActiveOperators) {
    const err = new Error(
      `há ${ativos.length} operador(es) ativo(s) — passe forceWithActiveOperators=true se confirma`,
    ) as Error & { code?: string; operadores?: typeof ativos };
    err.code = "OPERADORES_ATIVOS";
    err.operadores = ativos;
    throw err;
  }
  ```
- [ ] After computation, cleanup locs em_contagem with bloqueada_por finalizado (P3 #4.6):
  ```typescript
  // P3 #4.6: locs em_contagem cujo operador já finalizou ficam órfãs.
  // Reset pra 'pendente' + libera bloqueada_por.
  await sb
    .from("siso_inventario_localizacoes")
    .update({ status: "pendente", bloqueada_por: null, bloqueada_em: null })
    .eq("sessao_id", sessaoId)
    .eq("status", "em_contagem")
    .not("bloqueada_por", "is", null)
    .not("bloqueada_por", "in", `(${ativos.map((a) => `'${a.usuario_id}'`).join(",") || "''"})`);
  ```
- [ ] Modify signature: `computarDivergencias(sessaoId: string, opts?: { forceWithActiveOperators?: boolean })`. Update all callers (search `computarDivergencias(`):
  - `src/app/api/wms/inventario/[id]/aprovar/route.ts` — accept `force` flag from body, pass through.
  - `src/app/api/wms/inventario/[id]/aprovar-sessao/route.ts` — idem.

## Task 77 · Endpoint surfaces 409 with operator list + commit

- [ ] Endpoints retornam 409 com body:
  ```json
  { "error": "...", "code": "OPERADORES_ATIVOS", "operadores": [{ "usuario_id": "...", "nome": "..." }] }
  ```
- [ ] Quick test inline + commit:
  ```
  fix(p3): #4.5 #4.6 computarDivergencias avisa operadores ativos + limpa órfãos

  - listarOperadoresAtivos retorna lista pra UI mostrar 'X operadores ativos'
  - computarDivergencias aborta com 409 se ativos > 0 (force opt-in)
  - Pós-computação: locs em_contagem com bloqueada_por finalizado → reset pra pendente
  - Endpoints aprovar + aprovar-sessao aceitam force=true

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 15 · `pickPatchFields` guard modo_contagem mid-sessão (finding 4.7)

## Task 78 · Write FAILING quick scenario inline

- [ ] Inline (sem cenário dedicado — guard simples):
  ```typescript
  // Em scenario existente de inventário: após criar sessão (status='planejada'),
  // PATCH modo_contagem='aberto' → 200. Depois entrarParty (status='em_andamento'),
  // PATCH modo_contagem='blind' → 400 com mensagem clara.
  ```

## Task 79 · Implement guard in pickPatchFields

- [ ] Edit `src/app/api/wms/inventario/[id]/route.ts` — função `pickPatchFields` + endpoint PATCH:
  ```typescript
  // Mover validação pro endpoint pra ter acesso ao status atual:
  export async function PATCH(req: NextRequest, { params }: ...) {
    // ... auth
    const sb = createServiceClient();
    const { data: sessao } = await sb
      .from("siso_inventario_sessoes")
      .select("status, modo_contagem")
      .eq("id", id)
      .maybeSingle();
    if (!sessao) return NextResponse.json({ error: "sessão não encontrada" }, { status: 404 });

    const body = await req.json();
    const allowed = pickPatchFields(body);

    // P3 #4.7: modo_contagem só pode mudar em status='planejada'.
    if (
      allowed.modo_contagem &&
      allowed.modo_contagem !== (sessao as { modo_contagem: string }).modo_contagem &&
      (sessao as { status: string }).status !== "planejada"
    ) {
      return NextResponse.json(
        {
          error: "modo_contagem só pode ser alterado em sessão 'planejada' (ainda não iniciada)",
          code: "MODO_LOCKED",
          status_atual: (sessao as { status: string }).status,
        },
        { status: 409 },
      );
    }

    if (Object.keys(allowed).length === 0) {
      return NextResponse.json({ error: "nenhum campo válido pra atualizar" }, { status: 400 });
    }
    const { error } = await sb.from("siso_inventario_sessoes").update(allowed).eq("id", id);
    // ... rest
  }
  ```

## Task 80 · Verify + commit

- [ ] Hand-test via curl or quick inline assertion in a scenario.
- [ ] Commit:
  ```
  fix(p3): #4.7 PATCH inventário bloqueia troca de modo_contagem fora de 'planejada'

  - modo_contagem só muda quando sessão ainda não iniciada
  - 409 com code='MODO_LOCKED' + status atual no body

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 16 · Idempotência vendas com rollback (finding 7.7)

## Task 81 · Add idempotency lookup hardening in vendas/criar

- [ ] Edit `src/app/api/wms/vendas/criar/route.ts`:
  - Antes de qualquer escrita, se body tem `idempotency_key`, fazer SELECT em `siso_pedidos` por `payload_original->>'idempotency_key'`.
  - Se existe E `status != 'cancelado'` → retornar o pedido existente (idempotência clássica).
  - Se existe E `status = 'cancelado'` → seguir e criar novo (rollback recovery).

## Task 82 · Write scenario 47-vendas-idempotency-rollback

- [ ] Create `scripts/wms/cenarios/catalogo/47-vendas-idempotency-rollback.ts`:
  - Setup: produto + saldo.
  - Run: criar venda com `idempotency_key: 'abc'`. Cancelar. Criar de novo com mesma key → deve criar pedido NOVO (não retornar o cancelado).
  - Adicional: criar venda com key 'def'. Criar de novo com mesma key (sem cancelar) → retornar pedido existente (sem duplicar).
- [ ] Run → FAIL (hoje retorna pedido cancelado E duplica).

## Task 83 · Implement + run → PASS

- [ ] Add `payload_original->>'idempotency_key'` lookup with status filter.

## Task 84 · Commit

- [ ] Commit:
  ```
  fix(p3): #7.7 idempotência vendas distingue pedido vivo vs cancelado

  - Lookup por idempotency_key filtra status != 'cancelado'
  - Pedido cancelado libera a key pra nova venda
  - Cenário 47 valida ambos caminhos

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 17 · Reverter replenishment endpoint (finding 8.8 reverse side)

## Task 85 · Add `reverterReplenishment` helper

- [ ] Edit `src/lib/wms/movimentacoes.ts`:
  ```typescript
  /**
   * P3 #8.8 reverse: desfaz um replenishment estornando o par S+E completo.
   * Identifica pelo origem_id compartilhado.
   */
  export async function reverterReplenishment(input: {
    origem_id: string;
    usuario_id: string;
    motivo: string;
  }): Promise<{ movsEstornadas: number }> {
    if (!input.motivo || input.motivo.trim().length < 3) {
      throw new Error("motivo é obrigatório (≥3 caracteres)");
    }
    const sb = createServiceClient();
    const { data: movs } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("origem_id", input.origem_id)
      .eq("origem_tipo", "transferencia_localizacao");
    if (!movs || movs.length === 0) {
      throw new Error("nenhuma mov encontrada com esse origem_id");
    }
    let estornadas = 0;
    for (const m of movs as Array<{ id: string }>) {
      try {
        await estornarMovimentacao({
          mov_id: m.id,
          usuario_id: input.usuario_id,
          motivo: `Reverter replenishment ${input.origem_id}: ${input.motivo}`,
        });
        estornadas++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/já foi estornada|já é um estorno/.test(msg)) continue;
        throw err;
      }
    }
    return { movsEstornadas: estornadas };
  }
  ```

## Task 86 · Create endpoint

- [ ] Create `src/app/api/wms/replenishment/[id]/reverter/route.ts`:
  - **Note:** `[id]` here = `origem_id` (uuid de uma operação de replenishment). Endpoint trata id como origem_id.
  ```typescript
  import { NextRequest, NextResponse } from "next/server";
  import { requireWarehouseAccess } from "@/lib/wms/auth";
  import { wmsErrorResponse } from "@/lib/wms/api-errors";
  import { reverterReplenishment } from "@/lib/wms/movimentacoes";

  export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) {
    const auth = await requireWarehouseAccess(req);
    if (!auth.ok) return auth.response;
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const motivo = typeof body?.motivo === "string" ? body.motivo.trim() : "";
    if (motivo.length < 3) {
      return NextResponse.json({ error: "motivo (≥3 chars) é obrigatório" }, { status: 400 });
    }
    try {
      const r = await reverterReplenishment({ origem_id: id, usuario_id: auth.user.id, motivo });
      return NextResponse.json({ ok: true, ...r });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isClient = msg.includes("nenhuma mov") || msg.includes("motivo");
      return wmsErrorResponse({
        source: "wms.replenishment.reverter",
        error: e,
        status: isClient ? 400 : 500,
        requestPath: `/api/wms/replenishment/${id}/reverter`,
        requestMethod: "POST",
        metadata: { origem_id: id },
      });
    }
  }
  ```

## Task 87 · Add Ctx helper `reverterReplenishment`

- [ ] `reverterReplenishment: (p: { origem_id: string; motivo?: string }) => Promise<{ movsEstornadas: number }>;`

## Task 88 · Write FAILING scenario 48-reverter-replenishment

- [ ] Create `scripts/wms/cenarios/catalogo/48-reverter-replenishment.ts`:
  - Setup: produto + saldo em A-01.
  - Run: replenishment 5 unidades A-01 → A-02. Capturar `origem_id`. Chamar `/reverter`. Assert saldo A-01 = original, A-02 = 0.
- [ ] Run → FAIL.

## Task 89 · Implement + run → PASS

## Task 90 · Commit

- [ ] Commit:
  ```
  fix(p3): #8.8 reverse endpoint POST /replenishment/[origem_id]/reverter

  - Estorna par S+E via origem_id compartilhado
  - Idempotente; cenário 48 valida saldo restaurado

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 18 · `receberTransferencia` FOR UPDATE no header (finding 8.10)

## Task 91 · Locate + patch `receberTransferencia`

- [ ] `grep -n "export async function receberTransferencia" src/lib/wms/`. Probably in `transferencias.ts`.
- [ ] Patch: usar RPC `SELECT ... FOR UPDATE` no header antes de validar/inserir movs. Como o helper já faz JS-side `select+update`, envolver toda a operação em uma RPC ou usar `sb.rpc('wms_lock_transferencia', { id })` que faz SELECT FOR UPDATE e retorna.
- [ ] Simpler approach: inline a SQL `SELECT ... FOR UPDATE` via `sb.rpc("wms_lock_header_transferencia", ...)`. Create RPC:
  ```sql
  CREATE OR REPLACE FUNCTION wms_lock_header_transferencia(p_id uuid)
  RETURNS RECORD
  LANGUAGE plpgsql
  AS $$
  DECLARE r RECORD;
  BEGIN
    SELECT id, status, origem_id INTO r
    FROM siso_transferencias_galpao
    WHERE id = p_id
    FOR UPDATE;
    RETURN r;
  END;
  $$;
  ```
- [ ] Apply migration `20260527_p3_rpc_wms_lock_header_transferencia.sql`.

## Task 92 · Add scenario 48b-receber-transferencia-race

- [ ] Create scenario simulating 2 ops paralelos chamando `/receber` na mesma transferência. Espera: 1 ganha (200), outro 409 ou erro consistente; nunca duplica recepção.
- [ ] Run → FAIL (current: race).

## Task 93 · Implement + run → PASS

## Task 94 · Commit

- [ ] Commit:
  ```
  fix(p3): #8.10 receberTransferencia trava header com FOR UPDATE

  - RPC wms_lock_header_transferencia previne race
  - 2 ops paralelos: 1 ganha, outro 409 com 'já recebida'
  - Cenário 48b simula concorrência

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 19 · Desmarcar item · ordem dos estornos (finding 2.7)

## Task 95 · Audit current code in marcar-item/route.ts (desmarcar branch)

- [ ] Read `src/app/api/wms/separacao/marcar-item/route.ts` linhas que fazem loop sobre `links` em desmarcar:
  - Today: itera links em ordem de inserção (não-determinística). Se S é estornado primeiro, saldo volta. Se L é estornado depois, reservado volta. OK em teoria mas se a chain estiver corrompida, mid-state pode violar I2.
- [ ] Fix: garantir ordem **L primeiro (volta reservado), depois S (volta saldo)** — preserva invariante `reservado <= saldo` em todo passo intermediário.

## Task 96 · Patch ordering

- [ ] Edit `src/app/api/wms/separacao/marcar-item/route.ts` — no bloco desmarcar:
  ```typescript
  // P3 #2.7: ordem importa. Estornar S primeiro num momento em que
  // reservado > saldo_posterior gera throw em validarCoerencia.
  // Estornar L primeiro reduz reservado, depois S aumenta saldo — invariante OK.
  const sortedLinks = [...(links ?? [])].sort((a, b) => {
    if (a.tipo_link === "liberacao_reserva" && b.tipo_link !== "liberacao_reserva") return -1;
    if (a.tipo_link !== "liberacao_reserva" && b.tipo_link === "liberacao_reserva") return 1;
    return 0;
  });
  for (const link of sortedLinks) {
    // ... (lógica existente)
  }
  ```

## Task 97 · Write scenario 48c-desmarcar-ordem-estornos (optional, if invariant catches it)

- [ ] Cenário 20 (checkbox-preserva-reserva) já cobre o caminho feliz. Adicionar variante que força saldo baixo (sem buffer) entre os estornos — see if it triggers I2.
- [ ] Se cenário existente já passa post-fix, OK.

## Task 98 · Commit

- [ ] Commit:
  ```
  fix(p3): #2.7 desmarcar item — estorna L antes de S

  - Preserva invariante reservado <= saldo em todo passo intermediário
  - Sem mudança de comportamento end-to-end; apenas ordem do loop
  - Cenário 20 continua verde

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 20 · Reiniciar etapa=embalagem reverte cutover (finding 2.10)

## Task 99 · Audit current code

- [ ] Read `src/app/api/wms/separacao/reiniciar/route.ts` — etapa='embalagem' branch hoje só zera campos.
- [ ] Audit `src/lib/wms/cutover.ts` — função `reverterCutoverSeRetrocedeu(pedidoId, novoStatus, motivo, userId)`.

## Task 100 · Patch reiniciar to call reverter

- [ ] Edit `src/app/api/wms/separacao/reiniciar/route.ts`:
  ```typescript
  } else {
    // etapa === 'embalagem'
    // P3 #2.10: se cutover já aconteceu (estoque_lancado=true em qualquer item),
    // reverter via reverterCutoverSeRetrocedeu. Status alvo: 'separado'.
    for (const pid of pedido_ids) {
      await reverterCutoverSeRetrocedeu(pid, "separado", "reiniciar_embalagem", session.id);
    }
    const { error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        quantidade_bipada: 0,
        bipado_completo: false,
      })
      .in("pedido_id", pedido_ids);
    if (updateError) { /* ... */ }
  }
  ```
- [ ] Add import: `import { reverterCutoverSeRetrocedeu } from "@/lib/wms/cutover";`

## Task 101 · Write FAILING scenario 49-reiniciar-embalagem-reverte-cutover

- [ ] Create `scripts/wms/cenarios/catalogo/49-reiniciar-embalagem-reverte-cutover.ts`:
  - Setup: pedido propria com saldo. Aprovar → separar → embalar (deve fazer cutover S no ledger).
  - Run: chamar `/separacao/reiniciar` com etapa='embalagem'.
  - assertEsperado: saldo do produto voltou pro valor original (cutover revertido); itens com `estoque_lancado=false`.
- [ ] Run → FAIL.

## Task 102 · Run → PASS

## Task 103 · Commit

- [ ] Commit:
  ```
  fix(p3): #2.10 reiniciar etapa='embalagem' reverte cutover do ledger

  - Chama reverterCutoverSeRetrocedeu pra cada pedido_id
  - Saldo restaurado, estoque_lancado=false, status pedido='separado'
  - Cenário 49 valida ciclo full

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 21 · Ajuste manual reverse endpoint (finding 3.20)

## Task 104 · Add helper `estornarAjuste` to movimentacoes.ts

- [ ] Append:
  ```typescript
  export async function estornarAjuste(input: {
    mov_id: string;
    usuario_id: string;
    motivo: string;
  }): Promise<void> {
    if (!input.motivo || input.motivo.trim().length < 3) {
      throw new Error("motivo é obrigatório (≥3 caracteres)");
    }
    const sb = createServiceClient();
    const { data: mov } = await sb
      .from("siso_movimentacoes")
      .select("origem_tipo")
      .eq("id", input.mov_id)
      .maybeSingle();
    if (!mov) throw new Error("mov não encontrada");
    if ((mov as { origem_tipo: string }).origem_tipo !== "ajuste_manual") {
      throw new Error(`mov não é ajuste_manual (origem_tipo=${(mov as { origem_tipo: string }).origem_tipo})`);
    }
    await estornarMovimentacao({
      mov_id: input.mov_id,
      usuario_id: input.usuario_id,
      motivo: `Estorno ajuste manual: ${input.motivo}`,
    });
  }
  ```

## Task 105 · Create endpoint

- [ ] Create `src/app/api/wms/ajuste/[id]/estornar/route.ts`:
  - **Note:** `[id]` aqui = mov_id do ajuste original (uuid).
  ```typescript
  import { NextRequest, NextResponse } from "next/server";
  import { requireWarehouseAccess } from "@/lib/wms/auth";
  import { wmsErrorResponse } from "@/lib/wms/api-errors";
  import { estornarAjuste } from "@/lib/wms/movimentacoes";

  export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) {
    const auth = await requireWarehouseAccess(req);
    if (!auth.ok) return auth.response;
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const motivo = typeof body?.motivo === "string" ? body.motivo.trim() : "";
    if (motivo.length < 3) {
      return NextResponse.json({ error: "motivo (≥3 chars) é obrigatório" }, { status: 400 });
    }
    try {
      await estornarAjuste({ mov_id: id, usuario_id: auth.user.id, motivo });
      return NextResponse.json({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isClient =
        msg.includes("não encontrada") ||
        msg.includes("não é ajuste_manual") ||
        msg.includes("já foi estornada") ||
        msg.includes("já é um estorno") ||
        msg.includes("motivo");
      return wmsErrorResponse({
        source: "wms.ajuste.estornar",
        error: e,
        status: isClient ? 400 : 500,
        requestPath: `/api/wms/ajuste/${id}/estornar`,
        requestMethod: "POST",
        metadata: { mov_id: id },
      });
    }
  }
  ```

## Task 106 · Add Ctx helper

- [ ] `estornarAjuste: (p: { mov_id: string; motivo?: string }) => Promise<void>;`

## Task 107 · Write FAILING scenario 49b-estornar-ajuste

- [ ] Create `scripts/wms/cenarios/catalogo/49b-estornar-ajuste.ts`:
  - Setup: produto + saldo 10.
  - Run: ajuste manual entrada +5 (saldo → 15). Capturar `mov_id` retornado (precisa expor — patch ajustarEstoque pra retornar). Chamar `/ajuste/[mov_id]/estornar`. Assert saldo → 10.
- [ ] Need: `ajustarEstoque` retorna `{ mov_id }`. Patch:
  ```typescript
  export async function ajustarEstoque(input: AjusteManualInput): Promise<{ mov_id: string }> {
    // ... mesma lógica, mas guardar mov retornada
    const mov = await inserirMovimentacao({ /* ... */ });
    return { mov_id: mov.id };
  }
  ```
- [ ] Patch endpoint /ajuste/route.ts pra incluir `mov_id` no response.
- [ ] Run cenário → FAIL.

## Task 108 · Implement + run → PASS + commit

- [ ] Commit:
  ```
  fix(p3): #3.20 endpoint POST /ajuste/[id]/estornar

  - estornarAjuste valida origem_tipo='ajuste_manual' antes de estornar
  - ajustarEstoque + endpoint /ajuste retornam mov_id pra rastreio
  - Cenário 49b valida ajuste +5 → estornado → saldo restaurado

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 22 · UI undo buttons (after all endpoints exist)

## Task 109 · Inventário: botão "Estornar sessão aplicada" em /wms/inventario/[id]/page.tsx

- [ ] Locate page. Add botão visível somente quando:
  - `sessao.status === 'aplicada'`
  - User has admin perm (via `usePermissoes()`)
- [ ] Behavior: confirm dialog (Sonner-style) → POST `/api/wms/inventario/[id]/estornar` com `motivo` (textarea obrigatório) → toast result → invalidate query.

## Task 110 · Guarda: botão "Desfazer guarda" em /wms/guarda/[id]/page.tsx

- [ ] Visible when `pendencia.qty_guardada > 0` and user has warehouse access.
- [ ] Confirm + POST `/api/wms/guarda/[id]/desfazer`.

## Task 111 · Devoluções: botão "Desclassificar" em /wms/devolucoes/[id]/page.tsx

- [ ] Visible when `devolucao.status === 'classificada'`.
- [ ] Confirm + POST `/api/wms/devolucoes/[id]/desclassificar`.

## Task 112 · Vendas: botão "Cancelar venda" em /wms/vendas/[id]/page.tsx

- [ ] Visible when `pedido.status !== 'cancelado'`. Display warning if in active separação.
- [ ] POST `/api/wms/vendas/[id]/cancelar`.

## Task 113 · Transferências: botões em /wms/transferencias/[id]/page.tsx (verify exists; if not, skip UI here and document for P5)

- [ ] **Note:** P5 will refine UI. P3 ensures backend endpoints work; UI hookup minimal.

## Task 114 · Commit UI batch

- [ ] Single commit:
  ```
  fix(p3): UI buttons for undo endpoints (inventário, guarda, devoluções, vendas)

  - Cada botão atrás de confirm + textarea de motivo
  - Inventário 'Estornar' visível só pra admin com sessão aplicada
  - Guarda 'Desfazer' visível com qty_guardada > 0
  - Devoluções 'Desclassificar' visível com status='classificada'
  - Vendas 'Cancelar' visível com status != 'cancelado' + warning se em separação

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

# Phase 23 · Final verification (§7.5 critérios de pronto)

## Task 115 · Run full scenario suite

- [ ] `npm run scenarios` from worktree root.
- [ ] Expected: 17 originais + 13 novos (40, 40c, 40d, 41, 41b, 42, 43, 44, 45, 45b, 46, 46b, 47, 48, 48b, 48c, 49, 49b) = **34 cenários, todos PASS**. Adjust count if some sub-scenarios were merged inline.
- [ ] Save report from `scripts/wms/cenarios/reports/` as `docs/superpowers/smoke-2026-05-27-p3-reverse.md`.

## Task 116 · Verify §7.5 criteria explicitly

- [ ] **#1** Cenário 40 (aplicar inventário 2x simultâneo) gera apenas 1 conjunto de movs → ✅ via cenário 40
- [ ] **#2** Cenário 42 (desfazer guarda) reverte par S+E preservando trilha → ✅ via cenário 42
- [ ] **#3** Cenário 41 (estornar inventário aplicado) recoloca divergências como pendentes → ✅
- [ ] **#4** Cenário 43 (desclassificar devolução) reverte movs + permite re-classificação → ✅
- [ ] **#5** `wms_replenishment_intra_galpao` atômico: cenário 44 prova rollback → ✅
- [ ] **#6** DELETE de sessão aplicada retorna 409 com mensagem clara → manual via curl ou inline assertion in cenário 40

## Task 117 · TypeScript check

- [ ] `npx tsc --noEmit` from worktree → 0 errors.

## Task 118 · Lint

- [ ] `npm run lint` → 0 errors. Fix any new warnings introduced.

## Task 119 · Update docs

- [ ] Update `docs/api-reference-complete.md`:
  - Add 7 new endpoints (estornar/inventário, desfazer/guarda, desclassificar/devoluções, reverter/replenishment, estornar/ajuste, cancelar/venda, desfazer-recebimento/transferência).
  - Document new behavior: DELETE inventário 409, cancelar transferência aceita parcial, /contagens 409 sem lock, /iniciar guarda 409 race.
- [ ] Update `docs/database-schema.md`:
  - Add `uniq_movs_inventario_divergencia` partial UNIQUE index
  - Document new RPCs: `wms_replenishment_intra_galpao`, `wms_confirmar_guarda_atomico`, `wms_lock_header_transferencia`
- [ ] Update `docs/architecture-and-flows.md`:
  - Section on "Reverse paritária": each forward action and its reverse counterpart.

## Task 120 · Update CLAUDE.md project structure

- [ ] Add new endpoints to the `/api/wms/*` listing in the Project Structure section.
- [ ] Add WMS Plano P3 entry in "Current Status" section under "Recently completed".

## Task 121 · Update `erros-conhecidos.yaml`

- [ ] Add entries for each finding fixed (4.1, 4.4, 4.3, 5.2, 4.2, 8.6, 5.1, 6.3, 5.3, 5.8, 8.8, 7.13, 8.2, 8.3, 4.5, 4.6, 4.7, 7.7, 8.10, 2.7, 2.10, 3.20).
- [ ] Format per existing entries: id (`p3-fix-{finding}`), date 2026-05-27, source (file path), category, message, cause, fix, files, tags.

## Task 122 · Final commit + push

- [ ] `git status` → only docs changes plus possibly small lint fixes.
- [ ] `git add docs/ CLAUDE.md erros-conhecidos.yaml`
- [ ] Commit:
  ```
  docs(p3): updates docs + CLAUDE.md + erros-conhecidos pós-P3

  - 7 novos endpoints reverse documentados em api-reference-complete
  - 3 novas RPCs em database-schema
  - Seção 'Reverse paritária' em architecture-and-flows
  - 22 entradas em erros-conhecidos.yaml com causa/fix
  - CLAUDE.md: P3 listado em 'Recently completed'

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- [ ] `git push -u origin wms-fix-p3`

## Task 123 · Open PR

- [ ] Use `gh pr create --base develop --title "WMS P3 · Reverse Paritária + Idempotência (22 findings)" --body "$(cat <<'EOF'
## Summary
- 7 novos endpoints reverse (inventário/guarda/devoluções/replenishment/ajuste/venda/transferência)
- 5 race fixes (iniciar guarda, contagens lock, confirmar guarda atômico, receber transferência, desmarcar ordem)
- 2 atomic RPCs (replenishment, confirmar guarda)
- 1 UNIQUE constraint pra idempotência (inventário aplicar)
- 13 novos cenários (40-49+sub) — suite cresce de 17 → 34

## Test plan
- [ ] CI: `npm run scenarios` verde (todos os 34)
- [ ] CI: `npx tsc --noEmit` verde
- [ ] Manual: estornar sessão inventário aplicada via UI admin
- [ ] Manual: desfazer guarda via tablet operador
- [ ] Manual: cancelar venda manual em baixa direta
- [ ] Manual: receber transferência com 2 ops paralelos → 1 ganha
EOF
)"`

## Task 124 · Verify CI passes on PR

- [ ] Wait for Vercel preview + CI checks.
- [ ] If any fail, fix and push amend or new commit (NEVER --amend with hooks failed).

---

## Out-of-scope (deferred to P6 / future)

- Adicionar coluna `devolucao_id text` em `siso_movimentacoes` pra lookup determinístico de desclassificar (Task 43 nota).
- Desfazer guarda PARCIAL com qty configurável (Task 35 MVP limitation).
- Coluna `tracking_origem_ids text[]` em `siso_wms_pendencias_guarda` (Task 53 deferred).
- `siso_inventario_localizacoes` exclui locs tipo='quarentena' da sugestão (P6 — finding 6.9).
- Re-execução de `computarDivergencias` duplicar lock cleanup (4.13 — P6).
