# Auto-aprovação (exceto transferência) + Guarda dinâmica — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-aprovar todo pedido que não é transferência (OC cai na zona de verificação da separação); reduzir `/wms/pedidos` a só transferência; e tornar a guarda dinâmica (quantidade real no recebimento, auto-encerra, reserva forte ao iniciar).

**Architecture:** Reaproveita máquina de estados existente. F1 = mudança cirúrgica no webhook (`webhook-processor-wms.ts`) que passa a enfileirar um job `lancar_estoque decisao:"oc"`, disparando o caminho `executarMarcadoresOnly`→`validacao_oc` que hoje é código morto. OC-zona já existe (`validar-oc-item`, `OcEncontreiModal`); ajustes são frontend + auto-transição de pedido misto. F2 = `a_guardar` derivado no service (sem mexer na coluna GENERATED), auto-encerro + reserva forte via RPC nova/alterada.

**Tech Stack:** Next.js 16 (App Router), TypeScript strict, Supabase (RPC plpgsql, ledger imutável `wms_inserir_movimentacao`), vitest (unit happy-dom + integration contra staging), scenarios E2E HTTP (`scripts/wms/cenarios`).

**Ambiente:** staging `develop` → `ehbxpbeijofxtsbezwxd`. Migrations via `mcp__supabase__apply_migration` OU Management API. NUNCA prod.

**Spec:** `docs/superpowers/specs/2026-06-08-auto-aprovacao-exceto-transferencia-e-guarda-dinamica-design.md`

---

## Decisões travadas (do brainstorming + deep-dive)

| # | Decisão | Valor |
|---|---|---|
| D1 | OC auto-aprova | Toda OC (split + sem-cobertura) → cai na separação em `validacao_oc` |
| D2 | `/wms/pedidos` | Só `sugestao='transferencia'`. Realocação ganha aba na separação |
| D3 | Transferência | Sempre manual |
| D4 | Zona OC | Bucket amber **dentro do checklist** (já existe); pedidos OC ficam na fila normal mesclados |
| D5 | ENCONTREI | Dá baixa na hora (comportamento atual) |
| D6 | "Esgotado" | Mantém o nome (não renomear) |
| D7 | Misto (achou X / não tem Y) | Pedido inteiro → aba "Compras" (`aguardando_compra`) **automático** quando todos os normais já foram pegos |
| D8 | Botão novo | "Solicitar contagem da localização": pega a qty do pedido na hora + enfileira a loc pra contagem futura; pedido **não espera** |
| D9 | Sessão da contagem (G3) | **Sessão contínua operacional** (reuso `getOrCreateSessaoOperacional`), `motivo='solicitada_pick'`. *Decisão minha — diga se prefere sessão cycle_count visível.* |
| D10 | `a_guardar` | `min(qty_pendente, saldo livre real no recebimento)` — campo **derivado** no service; coluna `qty_pendente` GENERATED **intacta** |
| D11 | a_guardar clamp (G4) | Exibe `a_guardar` derivado E mantém `qty_pendente` (verdade contábil). *Decisão minha.* |
| D12 | Auto-encerrar | Quando saldo real chega a 0 → novo status `'encerrada_sem_saldo'` + ajuste do invariante I5 (G5). *Decisão minha — diga se prefere `cancelada`.* |
| D13 | **Recebimento continua pickável** | ⚠️ **NÃO** excluir `tipo='recebimento'` do roteamento (o deep-dive sugeriu — contradiz "às vezes separo direto do recebimento"). Mantido pickável; o `a_guardar` dinâmico + auto-encerrar absorvem o consumo |
| D14 | Travar ao iniciar | **Reserva forte**: `iniciar guarda` cria uma reserva R na loc de recebimento (`origem_tipo='reserva_guarda'`); liberada (L) no confirmar/cancelar/desfazer |
| D15 | Misto também no marcar-item? (G2) | **Não** nesta iteração; `concluir` segue como fallback |

---

## Estrutura de arquivos

**Modificados (TS):**
- `src/lib/webhook-processor-wms.ts` — gate auto-OC (F1).
- `src/app/wms/pedidos/page.tsx` — filtro aba pendentes (F1-UI).
- `src/lib/wms/dashboard-tarefas.ts` — contador "Aprovação" (F1-UI).
- `src/components/wms/home/quadro-tarefas.tsx` — legenda do card (F1-UI).
- `src/app/wms/separacao/page.tsx` — nova aba `pendente_realocacao` (F1-UI).
- `src/app/api/wms/separacao/validar-oc-item/route.ts` — auto-transição misto + ramo "solicitar contagem" (OC).
- `src/app/wms/separacao/checklist/page.tsx` — botão "Solicitar contagem" no `OcEncontreiModal` (OC).
- `src/lib/wms/contagem-inline.ts` — nova fn `enfileirarLocParaContagem` (OC).
- `src/lib/wms/guarda.ts` — `a_guardar` derivado + `iniciarGuarda` via RPC nova (F2).

**Criados:**
- `supabase/migrations/20260609_guarda_reserva_forte_auto_encerrar.sql` — RPCs guarda (F2).
- Cenários E2E: `87`, `88`, `89`, `90`, `91`, `92`, `93` em `scripts/wms/cenarios/catalogo/`.
- Unit: `src/lib/wms/guarda-a-guardar.test.ts`.
- Integration: `test/integration/guarda-reserva-forte.test.ts`, `test/integration/guarda-auto-encerra.test.ts`.

**Convenção do harness de cenário (confirmada):**
```ts
import type { Cenario, Ctx } from "../_harness/types";
export default {
  nome, descricao, tags,
  setup: async (ctx: Ctx) => ({ /* fixtures */ }),
  run: async (ctx, data) => { /* ações */ },
  assertEsperado: async (ctx, data) => { /* asserts via ctx.sb / ctx.assertSaldo */ },
} satisfies Cenario<TSetup>;
// footer runStandalone (copiar de 03-pedido-oc-completo.ts:64-76)
```
Helpers: `ctx.skuUnico(prefix)`, `ctx.criarProduto({sku,descricao})`, `ctx.semearSaldo({produto,galpao,loc,qty})`, `ctx.webhook({empresa,items:[{sku,qty}]})`, `ctx.aprovar(id,decisao)`, `ctx.aguardarStatusSeparacao(id,status,{timeout_ms})`, `ctx.receber({items,galpao,entrada_direta?})`→`{pendencias:string[]}`, `ctx.guardar({pendencia_id,loc_destino,qty?})`, `ctx.aguardarPendenciaGuarda(id,status,{timeout_ms})`, `ctx.sb` (SupabaseClient service-role), `ctx.staging.empresas.netair.cnpj`, `ctx.log`.

**Pré-requisitos de ambiente (verificar 1x antes de qualquer scenario/integration):** `.env.test.local` com `SUPABASE_SERVICE_ROLE_KEY` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` reais; binário `@next/swc-darwin-arm64` instalado (`npm run build` falha sem ele). Ver memória `project_test_harness_setup`.

---

## FASE 0 — Baseline + snapshot de assinaturas (sem código de produto)

**Files:** nenhum (só leitura/verificação).

- [ ] **Step 0.1: Snapshot das assinaturas RPC vivas**

Rodar via `mcp__supabase__execute_sql` no project `ehbxpbeijofxtsbezwxd`:
```sql
SELECT proname, pg_get_function_identity_arguments(oid) AS args
FROM pg_proc
WHERE proname IN ('wms_confirmar_guarda_atomico','wms_desfazer_guarda_atomico',
  'wms_replenishment_intra_galpao','wms_inserir_movimentacao','wms_reservar_atomico')
ORDER BY proname;
```
Expected: **uma linha por função** (overload duplicado quebra PostgREST). Salvar o output num scratch (não commitar). Confirma os named params exatos antes de qualquer `CREATE OR REPLACE`.

- [ ] **Step 0.2: Snapshot dos CHECKs que vou tocar**

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN ('siso_movimentacoes'::regclass, 'siso_wms_pendencias_guarda'::regclass, 'siso_fila_execucao'::regclass)
  AND contype = 'c'
  AND (pg_get_constraintdef(oid) ILIKE '%origem_tipo%'
       OR pg_get_constraintdef(oid) ILIKE '%status%'
       OR pg_get_constraintdef(oid) ILIKE '%decisao%');
```
Expected: ver o enum de `origem_tipo` (pra adicionar `reserva_guarda`), o CHECK de `status` da pendência (pra adicionar `encerrada_sem_saldo`), e confirmar que `decisao` da fila aceita `'oc'`. Anotar os nomes dos constraints e os valores atuais — a migration da Fase 6 vai recriá-los com os valores novos.

- [ ] **Step 0.3: Baseline verde dos cenários que vou tocar**

Run: `npm run scenarios:only -- 03-pedido-oc-completo` · `:only -- 01-pedido-auto-propria` · `:only -- 08-receber-guarda-parcial` · `:only -- 53-guarda-parcial-em-guarda`
Expected: todos PASS. Se `03` ou `51` falharem (deep-dive G8/G9 suspeita de assert stale `'pendente'` vs `'em_guarda'`), **anotar e NÃO corrigir agora** — vira Step na fase respectiva. Estabelece a baseline antes de mudar nada.

- [ ] **Step 0.4: Confirmar marcadores do OC manual (pra espelhar no webhook)**

Run: `grep -n "OC.*filialOrigem.*LVR\|marcadores" src/app/api/wms/pedidos/aprovar/route.ts`
Expected: confirma `decisao === "oc" ? ["OC", filialOrigem, "LVR"] : [...]` (aprovar/route.ts ~311). É o shape que o webhook OC vai espelhar.

---

## FASE 1 — F1-webhook: auto-enfileira OC

**Files:**
- Modify: `src/lib/webhook-processor-wms.ts:471` (gate), `:559-575` (upsert), `:644-665` (fila+kick)
- Test: `scripts/wms/cenarios/catalogo/87-webhook-auto-oc.ts` (novo), `scripts/wms/cenarios/catalogo/88-webhook-auto-oc-reentrega.ts` (novo)

- [ ] **Step 1.1: Escrever o cenário RED (auto-OC)**

Create `scripts/wms/cenarios/catalogo/87-webhook-auto-oc.ts`:
```ts
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "87 — Webhook auto-aprova OC (sem painel)",
  descricao: "Pedido sem saldo em nenhum galpão → auto vira validacao_oc SEM passar por /pedidos/aprovar; sem reserva R; 1 job decisao:oc.",
  tags: ["pedido", "oc", "auto", "webhook"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("87");
    await ctx.criarProduto({ sku, descricao: "OC auto 87" });
    // sem semearSaldo → sem cobertura → roteador decide oc
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 3 }],
    });
    await ctx.aguardarStatusSeparacao(pedido.id, "validacao_oc", { timeout_ms: 12_000 });
    return { pedidoId: pedido.id };
  },

  assertEsperado: async (ctx, { sku }) => {
    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .select("id, status, decisao_final, status_separacao, marcadores, tipo_resolucao")
      .eq("id", (await pedidoBySku(ctx, sku)).id)
      .single();
    if (ped!.status !== "executando") throw new Error(`status=${ped!.status} esperado executando`);
    if (ped!.decisao_final !== "oc") throw new Error(`decisao_final=${ped!.decisao_final} esperado oc`);
    if (ped!.status_separacao !== "validacao_oc") throw new Error(`status_separacao=${ped!.status_separacao}`);
    if (ped!.tipo_resolucao !== "auto") throw new Error(`tipo_resolucao=${ped!.tipo_resolucao} esperado auto`);
    if (!(ped!.marcadores as string[]).includes("OC")) throw new Error(`marcadores sem OC: ${ped!.marcadores}`);

    // 1 job decisao:oc
    const { data: jobs } = await ctx.sb
      .from("siso_fila_execucao")
      .select("id, decisao, tipo")
      .eq("pedido_id", ped!.id)
      .eq("tipo", "lancar_estoque");
    const ocJobs = (jobs ?? []).filter((j) => j.decisao === "oc");
    if (ocJobs.length !== 1) throw new Error(`esperado 1 job oc, achou ${ocJobs.length}`);

    // ZERO reserva R
    const { data: rs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("origem_id", ped!.id)
      .eq("tipo", "R");
    if ((rs ?? []).length !== 0) throw new Error(`esperado 0 R, achou ${(rs ?? []).length}`);
  },
} satisfies Cenario<{ sku: string }>;

// helper local: resolve o pedido criado pelo webhook pelo SKU do item
async function pedidoBySku(ctx: Ctx, sku: string): Promise<{ id: string }> {
  const { data } = await ctx.sb
    .from("siso_pedido_itens")
    .select("pedido_id")
    .eq("sku", sku)
    .limit(1)
    .single();
  return { id: (data as { pedido_id: string }).pedido_id };
}

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
```

- [ ] **Step 1.2: Rodar RED**

Run: `npm run scenarios:only -- 87-webhook-auto-oc`
Expected: FAIL no `aguardarStatusSeparacao(...,'validacao_oc')` (timeout — hoje OC fica `pendente`, sem job).

- [ ] **Step 1.3: Gate `autoEnfileiraOc` no webhook**

Em `src/lib/webhook-processor-wms.ts:471`, trocar:
```ts
const isAuto = sugestao === "propria";
const status = isAuto ? "executando" : "pendente";
const tipoResolucao = isAuto ? "auto" : null;
```
por:
```ts
const isAuto = sugestao === "propria";
const autoEnfileiraOc = sugestao === "oc";
const autoAprova = isAuto || autoEnfileiraOc;
const status = autoAprova ? "executando" : "pendente";
const tipoResolucao = autoAprova ? "auto" : null;
```

- [ ] **Step 1.4: Campos OC-aware no upsert do pedido**

Em `src/lib/webhook-processor-wms.ts:563-568`, trocar:
```ts
      decisao_final: isAuto ? "propria" : null,
      separacao_galpao_id: separacaoGalpaoId,
      status_separacao: isAuto ? "aguardando_nf" : null,
      ...
      marcadores: isAuto ? [galpaoOrigemNome, "LVR"] : ["LVR"],
```
por:
```ts
      decisao_final: isAuto ? "propria" : (autoEnfileiraOc ? "oc" : null),
      separacao_galpao_id: separacaoGalpaoId,
      // OC: status_separacao fica NULL aqui — o worker (executarMarcadoresOnly)
      // seta validacao_oc/aguardando_nf. NÃO setar aguardando_nf p/ OC
      // (dispararia enriquecerDadosNf cedo).
      status_separacao: isAuto ? "aguardando_nf" : null,
      ...
      marcadores: isAuto
        ? [galpaoOrigemNome, "LVR"]
        : (autoEnfileiraOc ? ["OC", galpaoOrigemNome, "LVR"] : ["LVR"]),
```

- [ ] **Step 1.5: Generalizar fila + guarda de idempotência**

Em `src/lib/webhook-processor-wms.ts:644-665`, trocar o bloco `if (isAuto) { ... }` por:
```ts
  if (autoAprova) {
    registrarEvento({
      pedidoId: pedido.id,
      evento: "auto_aprovado",
      detalhes: { decisao: isAuto ? "propria" : "oc", motivo, via: "wms" },
    }).catch(() => {});

    // Idempotência de re-entrega: OC não seta estoque_lancado=true, então o
    // early-return de duplicado não cobre. Guarda de dedup ANTES do insert
    // evita 23505 no índice uq_fila_release_pedido. (espelha worker:683-689)
    const { data: jobExistente } = await sb
      .from("siso_fila_execucao")
      .select("id")
      .eq("pedido_id", pedido.id)
      .eq("tipo", "lancar_estoque")
      .in("status", ["pendente", "executando"])
      .maybeSingle();

    if (!jobExistente) {
      await sb.from("siso_fila_execucao").insert({
        pedido_id: pedido.id,
        tipo: "lancar_estoque",
        filial_execucao: galpaoOrigemNome,
        empresa_id: empresaOrigemId,
        decisao: isAuto ? "propria" : "oc",
      });
    }

    kickWorker().catch((err) => {
      logger.error("processor.wms", "kickWorker falhou", {
        pedidoId: pedido.id,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
```

- [ ] **Step 1.6: Rodar GREEN (auto-OC)**

Run: `npm run scenarios:only -- 87-webhook-auto-oc`
Expected: PASS.

- [ ] **Step 1.7: Cenário de re-entrega (RED→GREEN)**

Create `scripts/wms/cenarios/catalogo/88-webhook-auto-oc-reentrega.ts` (mesma estrutura): `setup` cria SKU sem saldo; `run` chama `ctx.webhook(...)` 2x com o **mesmo** `pedidoFakeId` (ver assinatura `webhook({...pedidoFakeId})`); `assertEsperado` busca jobs `lancar_estoque` do pedido e exige `length === 1`.
Run: `npm run scenarios:only -- 88-webhook-auto-oc-reentrega`
Expected: PASS (a guarda de dedup do Step 1.5 garante 1 job).

- [ ] **Step 1.8: Regressão própria + OC manual**

Run: `npm run scenarios:only -- 01-pedido-auto-propria` · `:only -- 03-pedido-oc-completo`
Expected: PASS (própria intacta; OC manual via `aprovar` ainda funciona — não tocamos `aprovar/route.ts:368-383`).
Run: `npm run build && npm run lint`
Expected: sem erros.

- [ ] **Step 1.9: Commit + erros-conhecidos**

Adicionar entrada em `erros-conhecidos.yaml` (`id: webhook-auto-oc-reentrega-23505`, `category: business_logic`, `cause: OC re-entrega não cobria estoque_lancado`, `fix: guarda de dedup pré-insert na fila`, `files: src/lib/webhook-processor-wms.ts`, `tags: [webhook, oc, idempotencia]`).
```bash
git add src/lib/webhook-processor-wms.ts scripts/wms/cenarios/catalogo/87-webhook-auto-oc.ts scripts/wms/cenarios/catalogo/88-webhook-auto-oc-reentrega.ts erros-conhecidos.yaml
git commit -m "feat(wms): webhook auto-aprova OC -> validacao_oc (decisao:oc, idempotente)"
```

---

## FASE 2 — F1-pedidos-UI: aba = só transferência

**Files:**
- Modify: `src/app/wms/pedidos/page.tsx:203-215`, `src/lib/wms/dashboard-tarefas.ts:762-776`, `src/components/wms/home/quadro-tarefas.tsx:101-112`, `src/app/wms/separacao/page.tsx` (TAB_TO_STATUS)
- Test: `test/integration/wms-dashboard-tarefas.test.ts` (estender)

- [ ] **Step 2.1: RED — contador "Aprovação" só transferência**

Em `test/integration/wms-dashboard-tarefas.test.ts`, adicionar `it("aprovacao conta só transferência")`: semear 3 pedidos `status='pendente'` com `sugestao` em `['propria','oc','transferencia']` (SKU/ids randômicos), chamar `montarDashboardTarefas({})`, asserir `dash.aprovacao.count === 1`.
Run: `npx vitest run -c vitest.integration.config.ts test/integration/wms-dashboard-tarefas.test.ts`
Expected: FAIL (hoje conta os 3).

- [ ] **Step 2.2: Filtro da aba Pendentes (client-side)**

Em `src/app/wms/pedidos/page.tsx:203-215`, trocar o filtro:
```ts
  const pendentes = useMemo(() => {
    return filteredByGalpao
      .filter(
        (p) =>
          p.status === "pendente" ||
          p.status_separacao === "pendente_realocacao",
      )
```
por:
```ts
  const pendentes = useMemo(() => {
    return filteredByGalpao
      .filter(
        // Só transferência precisa de decisão humana aqui. Própria/OC
        // auto-aprovam (webhook). Realocação migrou pra aba na separação.
        (p) => p.status === "pendente" && p.sugestao === "transferencia",
      )
```
> NÃO tocar o `GET /api/wms/pedidos` (compartilhado pelas 3 abas; o recompute vivo de `sugestao` em `route.ts:52-84` é o que torna o filtro confiável).

- [ ] **Step 2.3: Contador "Aprovação" só transferência**

Em `src/lib/wms/dashboard-tarefas.ts:762-776`, no `aprovacaoQ`, adicionar `.eq("sugestao", "transferencia")` ao select de `status='pendente'`. Confirmar que o split marketplace/manual (`:1043-1049`) ainda fecha o invariante `marketplace + manual === count` (re-filtra sobre o mesmo conjunto).

- [ ] **Step 2.4: GREEN**

Run: `npx vitest run -c vitest.integration.config.ts test/integration/wms-dashboard-tarefas.test.ts`
Expected: PASS.

- [ ] **Step 2.5: Nova aba de realocação na separação**

Em `src/app/wms/separacao/page.tsx` (TAB_TO_STATUS, ~`:115-122`), adicionar uma aba `pendente_realocacao` (o backend já conta — `separacao/route.ts:82,265`). Label "Realocação". É o destino dos órfãos que saíram de `/wms/pedidos`.

- [ ] **Step 2.6: Legenda do card home**

Em `src/components/wms/home/quadro-tarefas.tsx:101-112`, ajustar o `legendaExtra`/breakdown do card "Aprovação" (split marketplace/manual deixa de fazer sentido — agora é só transferência); confirmar o `href` aponta pra `/wms/pedidos`.

- [ ] **Step 2.7: Regressão + commit**

Run: `npm run scenarios:only -- 72-lista-sugestao-recalcula-vivo` (recompute vivo intacto). `npm run build`.
Entrada `erros-conhecidos.yaml` documentando onde realocação passa a viver. Commit:
```bash
git add src/app/wms/pedidos/page.tsx src/lib/wms/dashboard-tarefas.ts src/components/wms/home/quadro-tarefas.tsx src/app/wms/separacao/page.tsx test/integration/wms-dashboard-tarefas.test.ts erros-conhecidos.yaml
git commit -m "feat(wms): /pedidos vira painel de transferência; realocação ganha aba na separação"
```

---

## FASE 3 — OC-zona: auto-transição de pedido misto → Compras

**Files:**
- Modify: `src/app/api/wms/separacao/validar-oc-item/route.ts:574-577` (select) + `:631-648` (ramo misto)
- Test: `scripts/wms/cenarios/catalogo/89-misto-oc-auto-compras.ts` (novo)

- [ ] **Step 3.1: RED — misto vai pra Compras sem `concluir`**

Create `scripts/wms/cenarios/catalogo/89-misto-oc-auto-compras.ts`: `setup` cria 2 SKUs (skuA com saldo CWB, skuB sem saldo); `run` webhook com os 2 itens → `aguardarStatusSeparacao('validacao_oc')`, `iniciarSeparacao`, `marcar-item` no skuA (normal), depois `POST /api/wms/separacao/validar-oc-item {acao:'esgotado'}` no item OC do skuB; `assertEsperado` busca o pedido e exige `status_separacao === 'aguardando_compra'` **sem** ter chamado `concluir`.
Run: `npm run scenarios:only -- 89-misto-oc-auto-compras`
Expected: FAIL (hoje fica `em_separacao`; só `concluir` resolveria).

- [ ] **Step 3.2: Adicionar `separacao_marcado` ao select**

Em `src/app/api/wms/separacao/validar-oc-item/route.ts:574-577`, trocar:
```ts
      const { data: allItems } = await supabase
        .from("siso_pedido_itens")
        .select("id, compra_status")
        .eq("pedido_id", pedidoId);
```
por:
```ts
      const { data: allItems } = await supabase
        .from("siso_pedido_itens")
        .select("id, compra_status, separacao_marcado")
        .eq("pedido_id", pedidoId);
```

- [ ] **Step 3.3: Ramo misto com guard**

Em `src/app/api/wms/separacao/validar-oc-item/route.ts`, trocar o comentário-só (`:647-648`):
```ts
      // Mixed (some compra, some normal) — no auto-transition here,
      // concluir/route.ts handles this when operator finishes picking normal items
```
por:
```ts
      } else if (
        // Misto: parte virou compra, parte é normal. Só transiciona pra
        // Compras quando TODOS os normais já foram pegos (separacao_marcado).
        // Senão o operador perderia a wave dos normais ainda não bipados.
        normalItems.every((i) => i.separacao_marcado === true)
      ) {
        const { error: updErr } = await supabase
          .from("siso_pedidos")
          .update({ status_separacao: "aguardando_compra" })
          .eq("id", pedidoId)
          .in("status_separacao", ["validacao_oc", "em_separacao"]); // idempotente
        if (!updErr) {
          transicoes.push({ pedido_id: pedidoId, novo_status: "aguardando_compra" });
        }
      }
```
> Nota: o `} else if (normalItems.length === 0) {` do FR-8 acima fecha com `}` — manter a cadeia `if/else if/else if`. Ler `:610-646` antes de editar pra acertar a indentação/chaves.

- [ ] **Step 3.4: GREEN**

Run: `npm run scenarios:only -- 89-misto-oc-auto-compras`
Expected: PASS.

- [ ] **Step 3.5: Cenário gêmeo — ordem inversa (guard segura)**

Create `scripts/wms/cenarios/catalogo/89b-misto-oc-ordem-inversa.ts`: resolve o OC (`esgotado`) ANTES de marcar o normal → asserir que **NÃO** transiciona prematuro (fica `em_separacao`), e que depois de marcar o normal + concluir, vai pra `aguardando_compra` (fallback `concluir`).
Run: `npm run scenarios:only -- 89b-misto-oc-ordem-inversa`
Expected: PASS.

- [ ] **Step 3.6: Regressão + commit**

Run: `:only -- 03-pedido-oc-completo` (FR-8 100% OC intacto) · `:only -- 26-validar-oc-encontrei-mov` (FR-9 intacto). NÃO tocar `concluir/route.ts`. Entrada `erros-conhecidos.yaml`. Commit.

---

## FASE 4 — OC-zona: botão "Solicitar contagem da localização"

**Files:**
- Modify: `src/lib/wms/contagem-inline.ts` (nova fn exportada), `src/app/api/wms/separacao/validar-oc-item/route.ts` (novo ramo), `src/app/wms/separacao/checklist/page.tsx:1886-2030` (modal) + handler (`:624-692`)
- Test: `scripts/wms/cenarios/catalogo/90-solicitar-contagem-pick.ts` (novo)

- [ ] **Step 4.1: RED**

Create `scripts/wms/cenarios/catalogo/90-solicitar-contagem-pick.ts` (clonar `71-encontrei-contagem-inline.ts` se existir, senão `26-validar-oc-encontrei-mov.ts`): item OC de qty 2 numa loc; chamar `POST /api/wms/separacao/validar-oc-item {acao:'encontrei', solicitar_contagem:true, localizacao_codigo:'A-01-01'}`. `assertEsperado`:
  1. saiu 1 mov `S` (`nf_venda`) de qty 2 (`assertMovsCount`/query);
  2. **NÃO** existe contagem/divergência aplicada com qty total (não chamou `registrarContagemInline`);
  3. existe 1 row em `siso_inventario_localizacoes` com `status='pendente'` e `motivo='solicitada_pick'` na sessão contínua do galpão;
  4. pedido transicionou (FR-9 → `aguardando_separacao` ou separado).
Run: `npm run scenarios:only -- 90-solicitar-contagem-pick`
Expected: FAIL (rota ainda não aceita `solicitar_contagem`).

- [ ] **Step 4.2: `enfileirarLocParaContagem` no contagem-inline.ts**

Em `src/lib/wms/contagem-inline.ts`, exportar:
```ts
export async function enfileirarLocParaContagem(
  sb: ReturnType<typeof createServiceClient>,
  galpao_id: string,
  localizacao_id: string,
  solicitada_por: string,
): Promise<void> {
  const sessao_id = await getOrCreateSessaoOperacional(sb, galpao_id, solicitada_por);
  // idempotência clique-duplo via UNIQUE(sessao_id, localizacao_id)
  await sb
    .from("siso_inventario_localizacoes")
    .upsert(
      { sessao_id, localizacao_id, status: "pendente", motivo: "solicitada_pick" },
      { onConflict: "sessao_id,localizacao_id", ignoreDuplicates: true },
    );
}
```
> Confirmar no schema vivo (Step 0.2 / `list_tables`) que `siso_inventario_localizacoes` tem UNIQUE(sessao_id, localizacao_id) e que `motivo` é texto livre (sem CHECK). Ajustar colunas obrigatórias se o schema exigir (ex: `criada_em`).

- [ ] **Step 4.3: Ramo "solicitar contagem" na rota**

Em `src/app/api/wms/separacao/validar-oc-item/route.ts`, no parse do body adicionar `solicitar_contagem?: boolean` (Zod, default false, mutuamente exclusivo com `qty_contada`). No ramo `acao==='encontrei'`, quando `solicitar_contagem===true`: pular `registrarContagemInline`; fazer `inserirMovimentacao({ tipo:'E', origem_tipo:'ajuste_manual', origem_id:'solicitar-contagem-'+item.id, quantidade: quantidade_pedida, ... })` (só a qty do pedido) → depois `pickMovPicking` (S `nf_venda`); após o pick, `await enfileirarLocParaContagem(supabase, galpao_id, localizacao_id, user.id).catch((e)=>logger.warn(...))` (fire-and-forget). Reusar os updates de item + auto-transições `:568-649` (compartilhados).
> O `origem_id` PRÓPRIO (`solicitar-contagem-${item.id}`) evita colisão de idempotência com o caminho `encontrei-sem-cadastro-${item.id}`.

- [ ] **Step 4.4: GREEN**

Run: `npm run scenarios:only -- 90-solicitar-contagem-pick`
Expected: PASS.

- [ ] **Step 4.5: Botão no modal**

Em `src/app/wms/separacao/checklist/page.tsx` `OcEncontreiModal` (`:2009-2026`, footer), adicionar um botão ghost "Solicitar contagem depois" que chama `onSolicitarContagem(locInput)` (nova prop, ignora `qtdContada` — só exige a loc bipada). No componente pai (`:1313-1320` + handler `:624-692`), implementar `onSolicitarContagem` que faz o POST com `{acao:'encontrei', solicitar_contagem:true, localizacao_codigo}`.

- [ ] **Step 4.6: Regressão + commit**

Run: `:only -- 26-validar-oc-encontrei-mov` (caminho qty_contada intacto). `npm run build`. Entrada `erros-conhecidos.yaml` (documentar que o saldo da loc fica temporariamente subcontado até a contagem futura — é o ponto da feature). Commit.

---

## FASE 5 — F2-guarda: `a_guardar` dinâmico (recebimento CONTINUA pickável)

**Files:**
- Modify: `src/lib/wms/guarda.ts:195-232` (listarPendencias) + `:246-296` (listarRotaPendencias) + tipo `PendenciaJoined`
- Test: `src/lib/wms/guarda-a-guardar.test.ts` (novo, unit), `scripts/wms/cenarios/catalogo/91-guarda-dinamica-reflete-pick.ts` (novo)

> ⚠️ **NÃO** mexer na coluna GENERATED `qty_pendente` (I5 e o CHECK `status='guardada'⇒qty_guardada=qty_inicial` dependem dela). `a_guardar` é campo **derivado**.
> ⚠️ **NÃO** excluir `tipo='recebimento'` do roteamento (D13). Recebimento segue pickável — é o que faz a guarda ser dinâmica.

- [ ] **Step 5.1: RED unit — fórmula `a_guardar`**

Create `src/lib/wms/guarda-a-guardar.test.ts` (vitest puro):
```ts
import { describe, it, expect } from "vitest";
import { calcularAGuardar } from "./guarda";

describe("calcularAGuardar", () => {
  it("a_guardar = min(qty_pendente, livre)", () => {
    expect(calcularAGuardar({ qty_pendente: 40, saldo: 10, reservado_alheio: 0 })).toBe(10);
    expect(calcularAGuardar({ qty_pendente: 5, saldo: 50, reservado_alheio: 0 })).toBe(5);
  });
  it("desconta reservado de pedidos (livre = saldo - reservado_alheio)", () => {
    expect(calcularAGuardar({ qty_pendente: 10, saldo: 10, reservado_alheio: 3 })).toBe(7);
  });
  it("saldo zero → 0 (guarda já consumida pelo pick)", () => {
    expect(calcularAGuardar({ qty_pendente: 40, saldo: 0, reservado_alheio: 0 })).toBe(0);
  });
  it("nunca negativo", () => {
    expect(calcularAGuardar({ qty_pendente: 5, saldo: 2, reservado_alheio: 9 })).toBe(0);
  });
});
```
Run: `npx vitest run src/lib/wms/guarda-a-guardar.test.ts`
Expected: FAIL (`calcularAGuardar` não existe).

- [ ] **Step 5.2: Implementar `calcularAGuardar` + campo no tipo**

Em `src/lib/wms/guarda.ts`, exportar:
```ts
export function calcularAGuardar(p: {
  qty_pendente: number;
  saldo: number;
  reservado_alheio: number; // reservas que NÃO são desta guarda (pedidos, etc)
}): number {
  const livre = Math.max(0, p.saldo - p.reservado_alheio);
  return Math.max(0, Math.min(p.qty_pendente, livre));
}
```
Adicionar `a_guardar?: number` (opcional aditivo) ao tipo `PendenciaJoined` (não quebra callers).

- [ ] **Step 5.3: GREEN unit**

Run: `npx vitest run src/lib/wms/guarda-a-guardar.test.ts`
Expected: PASS.

- [ ] **Step 5.4: Enriquecer `listarPendencias` com `a_guardar` (1 query batch)**

Em `src/lib/wms/guarda.ts:222` (após `const rows = ...map(normalizarNumeros)` e antes do filtro `q`), adicionar batch:
```ts
  // a_guardar dinâmico: saldo real - reservas de TERCEIROS na loc de origem.
  // 1 query batch (evita N+1). reservas desta própria guarda (origem_tipo
  // 'reserva_guarda', origem_id = pendencia.id) são excluídas do "alheio".
  if (rows.length > 0) {
    const triplas = rows.map((r) => ({
      produto_id: r.produto_id,
      galpao_id: r.galpao_id,
      localizacao_id: r.localizacao_origem_id,
    }));
    const { data: estoques } = await sb
      .from("siso_estoque")
      .select("produto_id, galpao_id, localizacao_id, saldo, reservado")
      .in("produto_id", [...new Set(triplas.map((t) => t.produto_id))]);
    const byTripla = new Map(
      (estoques ?? []).map((e) => [
        `${e.produto_id}|${e.galpao_id}|${e.localizacao_id}`,
        { saldo: Number(e.saldo), reservado: Number(e.reservado) },
      ]),
    );
    // reservas desta guarda (pra não descontar a si mesma)
    const pendIds = rows.filter((r) => r.status === "em_guarda").map((r) => r.id);
    const ownReserva = new Map<string, number>();
    if (pendIds.length > 0) {
      const { data: rg } = await sb
        .from("siso_movimentacoes")
        .select("origem_id, quantidade")
        .eq("tipo", "R")
        .eq("origem_tipo", "reserva_guarda")
        .in("origem_id", pendIds);
      for (const m of rg ?? []) {
        ownReserva.set(m.origem_id, (ownReserva.get(m.origem_id) ?? 0) + Number(m.quantidade));
      }
    }
    for (const r of rows) {
      const e = byTripla.get(`${r.produto_id}|${r.galpao_id}|${r.localizacao_origem_id}`);
      const saldo = e?.saldo ?? 0;
      const reservadoTotal = e?.reservado ?? 0;
      const reservadoProprio = ownReserva.get(r.id) ?? 0;
      r.a_guardar = calcularAGuardar({
        qty_pendente: r.qty_pendente,
        saldo,
        reservado_alheio: reservadoTotal - reservadoProprio,
      });
    }
  }
```
> Confirmar os nomes das colunas em `PendenciaJoined` (`produto_id`, `galpao_id`, `localizacao_origem_id`) — vêm do `select("*")`. Replicar o mesmo bloco em `listarRotaPendencias` (`:278`).

- [ ] **Step 5.5: RED→GREEN E2E — guarda reflete o pick**

Create `scripts/wms/cenarios/catalogo/91-guarda-dinamica-reflete-pick.ts`: receber 40 na loc recebimento (`ctx.receber({galpao:'CWB', items:[{sku,qty:40}]})` → pendência); webhook+auto de um pedido de qty 30 do mesmo SKU/galpão que separa do recebimento (picking consome); depois `listarPendencias` via `GET /api/wms/guarda` e asserir `a_guardar === 10` na pendência (qty_pendente segue 40). 
Run: `npm run scenarios:only -- 91-guarda-dinamica-reflete-pick`
Expected: PASS (com o enriquecimento; provaria o conceito).

- [ ] **Step 5.6: Regressão + commit**

Run: `:only -- 08-receber-guarda-parcial` · `:only -- 01-pedido-auto-propria` · `:only -- 02-pedido-transferencia` (roteamento intacto). `npm test` (unit). `npm run build`.
Entrada `erros-conhecidos.yaml` (tag `guarda`, `recebimento`, `a_guardar`). Commit.

---

## FASE 6 — F2-guarda: reserva forte ao iniciar + auto-encerrar (RPCs)

**Files:**
- Create: `supabase/migrations/20260609_guarda_reserva_forte_auto_encerrar.sql`
- Modify: `src/lib/wms/guarda.ts:345-410` (iniciarGuarda → RPC), `src/lib/wms/guarda.ts` (confirmar/cancelar/desfazer liberam a R), `scripts/wms/cenarios/_harness/invariantes.ts:128-147` (I5 aceita status novo)
- Test: `test/integration/guarda-reserva-forte.test.ts` (novo), `test/integration/guarda-auto-encerra.test.ts` (novo), `scripts/wms/cenarios/catalogo/92-guarda-reserva-forte-bloqueia-pick.ts` (novo)

> ⚠️ Esta é a fase mais delicada (mexe no ledger). Ordem das pernas e liberação da R são críticas — seguir os steps à risca.

- [ ] **Step 6.1: RED integration — reserva forte bloqueia pick concorrente**

Create `test/integration/guarda-reserva-forte.test.ts` (espelha `webhook-reserva-all-or-nothing.integration.test.ts`): seed SKU randômico + saldo 10 na loc de recebimento; chamar a futura `wms_iniciar_guarda_atomico(pendencia, operador)`; asserir que `siso_estoque.reservado` da loc subiu 10 e `disponivel` caiu a 0, e que existe 1 mov `R` `origem_tipo='reserva_guarda'`.
Run: `npx vitest run -c vitest.integration.config.ts test/integration/guarda-reserva-forte.test.ts`
Expected: FAIL (RPC não existe).

- [ ] **Step 6.2: RED integration — auto-encerrar quando saldo zera**

Create `test/integration/guarda-auto-encerra.test.ts`: criar pendência + entrada na recebimento; forçar S de toda a qty (pick consumiu); chamar o caminho de confirmação/encerro → asserir status `'encerrada_sem_saldo'`, `qty_pendente>0`, saldo intacto (sem par S+E), e que o invariante I5 passa.
Run: `npx vitest run -c vitest.integration.config.ts test/integration/guarda-auto-encerra.test.ts`
Expected: FAIL.

- [ ] **Step 6.3: Migration — CHECKs + RPCs**

Create `supabase/migrations/20260609_guarda_reserva_forte_auto_encerrar.sql`. Partir dos constraints/funções vivos (Steps 0.1/0.2). Conteúdo:

1. **ALTER CHECK `origem_tipo`** de `siso_movimentacoes` para incluir `'reserva_guarda'` e `'liberacao_guarda'` (copiar a definição atual do Step 0.2 e adicionar os valores).
2. **ALTER CHECK status** de `siso_wms_pendencias_guarda` para incluir `'encerrada_sem_saldo'`.
3. **`CREATE FUNCTION wms_iniciar_guarda_atomico(p_pendencia_id uuid, p_usuario_id uuid, p_forcar boolean DEFAULT false) RETURNS jsonb`**: `SELECT ... FOR UPDATE` na pendência; claim condicional (status→`em_guarda`, `iniciada_por`, respeitando `forcar`/takeover preservando qty_guardada); calcular `livre = saldo - reservado` na loc de origem; criar `R` via `wms_inserir_movimentacao(... p_tipo:='R', p_origem_tipo:='reserva_guarda', p_origem_id:=p_pendencia_id::text, p_quantidade:=LEAST(qty_pendente, livre), p_expira_em:= now()+interval '7 days', named params ...)`; retornar jsonb `{pendencia_id, reservado, iniciada_por}`. **Idempotente:** se já existe R `reserva_guarda` pra essa pendência, não duplicar.
4. **`CREATE OR REPLACE wms_confirmar_guarda_atomico(p_pendencia_id uuid, p_qty numeric, p_localizacao_destino_id uuid, p_usuario_id uuid) RETURNS jsonb`** — partir do corpo vivo de `20260528_p7` (Step 0.1), **manter assinatura e textos de exceção literais** (`'qty (%) excede pendente'`, `'saldo insuficiente'` — cenários 08/42/53/51 dependem). Inserir DOIS blocos:
   - **(a) Auto-encerrar** logo após o `FOR UPDATE`: ler `siso_estoque` da loc origem; se `disponivel = 0 AND qty_pendente > 0` → `UPDATE status='encerrada_sem_saldo', guardada_em=now()` e `RETURN` early (sem par S+E, saldo intacto).
   - **(b) Liberar a R da guarda ANTES do replenishment**: se existe R `reserva_guarda` pra essa pendência, emitir `L` (`wms_inserir_movimentacao p_tipo:='L', p_origem_tipo:='liberacao_guarda', p_estorno_de:=<id da R>`) **antes** das pernas S+E (senão a S violaria `CHECK reservado<=saldo`). Liberar só a fração sendo guardada (`p_qty`); se guarda parcial, manter o restante da R.
5. **`CREATE OR REPLACE wms_desfazer_guarda_atomico`** — ao desfazer, recriar/ajustar a R `reserva_guarda` se a pendência volta a `em_guarda` (manter consistência). Partir do corpo vivo (4 args).

> Usar SEMPRE named params nas chamadas internas a `wms_inserir_movimentacao` (23 args — Step 0.1). NÃO inverter ordem das pernas (S antes de E). NÃO adicionar `FOR UPDATE` extra na loc de recebimento além do que o `wms_replenishment` já faz (evita deadlock).

- [ ] **Step 6.4: Aplicar migration + re-snapshot**

Aplicar via `mcp__supabase__apply_migration` (name `20260609_guarda_reserva_forte_auto_encerrar`) no `ehbxpbeijofxtsbezwxd`. Re-rodar a query do Step 0.1.
Expected: **1 overload** por função (overload duplo quebra PostgREST).

- [ ] **Step 6.5: `iniciarGuarda` chama a RPC; confirmar/cancelar liberam a R**

Em `src/lib/wms/guarda.ts:345-410`, trocar o UPDATE PostgREST de claim por `sb.rpc("wms_iniciar_guarda_atomico", { p_pendencia_id, p_usuario_id, p_forcar })`. Em `cancelarPendencia` (`:562-594`): antes de cancelar, emitir `L` da R `reserva_guarda` remanescente (loc volta a ter disponível). `confirmarGuarda` já delega à RPC (que agora libera a R) — só conferir o retorno.

- [ ] **Step 6.6: Ajustar invariante I5**

Em `scripts/wms/cenarios/_harness/invariantes.ts:128-147`, tratar `'encerrada_sem_saldo'` como status terminal SEM exigir `qty_pendente=0` (a peça sumiu no pick legítimo).

- [ ] **Step 6.7: GREEN integration**

Run: `npx vitest run -c vitest.integration.config.ts test/integration/guarda-reserva-forte.test.ts test/integration/guarda-auto-encerra.test.ts`
Expected: PASS.

- [ ] **Step 6.8: E2E — reserva forte bloqueia pick concorrente**

Create `scripts/wms/cenarios/catalogo/92-guarda-reserva-forte-bloqueia-pick.ts`: receber 10 → `iniciar guarda` (reserva 10) → webhook de pedido do mesmo SKU/galpão → asserir que o pedido **NÃO** separa do recebimento (vai pra `validacao_oc`/OC, disponível=0). Depois cancelar a guarda → asserir que a R foi liberada (`reservado` voltou a 0).
Run: `npm run scenarios:only -- 92-guarda-reserva-forte-bloqueia-pick`
Expected: PASS.

- [ ] **Step 6.9: Regressão pesada + cenário 51 stale**

Run: `:only -- 08-receber-guarda-parcial` · `53-guarda-parcial-em-guarda` · `51-desfazer-guarda-parcial-qty` · `42-desfazer-guarda` · `40d-iniciar-guarda-race` · `38-criada-por-guarda`. `npx vitest run -c vitest.integration.config.ts test/integration/guarda-force-unlock.test.ts`.
Se o `51` falhar por assert stale (`'pendente'` vs `'em_guarda'` — deep-dive G8): corrigir o assert do cenário e registrar em `erros-conhecidos.yaml`.
Expected: todos PASS.

- [ ] **Step 6.10: Commit + docs**

`npm run build`. Atualizar `docs/database-schema.md` (novo `origem_tipo`, status pendência) + `CLAUDE.md` (RPC `wms_iniciar_guarda_atomico`, reserva forte). Entrada `erros-conhecidos.yaml`. Commit:
```bash
git add supabase/migrations/20260609_guarda_reserva_forte_auto_encerrar.sql src/lib/wms/guarda.ts scripts/wms/cenarios/_harness/invariantes.ts test/integration/guarda-reserva-forte.test.ts test/integration/guarda-auto-encerra.test.ts scripts/wms/cenarios/catalogo/92-guarda-reserva-forte-bloqueia-pick.ts docs/database-schema.md CLAUDE.md erros-conhecidos.yaml
git commit -m "feat(wms): guarda dinâmica — reserva forte ao iniciar + auto-encerrar (RPC)"
```

---

## Self-Review (preenchido)

**Cobertura do spec:** F1 auto-OC (Fase 1) ✓ · `/wms/pedidos` só transferência (Fase 2) ✓ · zona OC amber/encontrei/esgotado — já existe, misto auto (Fase 3) ✓ · botão solicitar contagem (Fase 4) ✓ · `a_guardar` dinâmico (Fase 5) ✓ · auto-encerrar + reserva forte (Fase 6) ✓. **Correção vs spec:** o spec mencionava `FOR UPDATE` na RPC genericamente — a Fase 6 detalha como reserva forte (D14, escolha do dono) e **dropa** a exclusão de recebimento (D13). O "polimento visual amber" do bucket OC ficou implícito (já existe `--wms-c-warn`); adicionar como Step opcional 3.7 se a UI não estiver clara o suficiente.

**Placeholders:** nenhum `TBD`. Pontos "confirmar no schema vivo" (Steps 4.2, 5.4) são leituras de verificação, não lógica faltando.

**Consistência de tipos:** `calcularAGuardar({qty_pendente,saldo,reservado_alheio})` usado igual em 5.1/5.2/5.4. `a_guardar` opcional em `PendenciaJoined`. `enfileirarLocParaContagem(sb,galpao_id,localizacao_id,solicitada_por)` igual em 4.2/4.3. Status novo `'encerrada_sem_saldo'` e `origem_tipo='reserva_guarda'`/`'liberacao_guarda'` consistentes entre migration (6.3) e service (5.4, 6.5).

**Riscos cobertos:** reserva R indevida em OC (cenário 87 assert 0 R), idempotência webhook (88), transição misto cedo demais (guard `every(separacao_marcado)`), deadlock guarda (não inverter pernas), CHECK `reservado<=saldo` (liberar R antes do S), recebimento pickável preservado (D13).

---

## Decisões que tomei por você (diga se quer flipar)

- **D9** contagem → sessão contínua (vs cycle_count visível no painel de inventário).
- **D11** `a_guardar` exibido + `qty_pendente` mantido (não clampa a coluna).
- **D12** auto-encerrar usa status novo `'encerrada_sem_saldo'` (vs reusar `cancelada`).
- **Rateio multi-pendência mesma loc** (cross-dock split, 2 pendências dividindo o mesmo saldo): a soma de `a_guardar` pode passar do físico, mas a RPC de confirmar (FOR UPDATE) impede over-guard real. Tratei como exibição otimista; proration FIFO ficou **fora de escopo** (raro). Diga se quer rateio explícito.
