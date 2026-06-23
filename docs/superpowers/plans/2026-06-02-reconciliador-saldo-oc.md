# Reconciliador de saldo OC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando entra estoque de um produto, devolver automaticamente ao picking os pedidos parados por falta desse produto (FIFO, mais antigo primeiro), usando só saldo livre (respeitando reservas), e consertar o recebimento de OC que hoje deixa o pedido preso.

**Architecture:** Dois mecanismos independentes. **Mec. 1 (Reconciliador):** um novo módulo `reconciliador-oc.ts` é chamado pelo gancho que já dispara a cada mov `E` no ledger; ele seleciona itens OC cobertos por FIFO, cria reserva atômica (igual ao fluxo própria do webhook), desvincula a OC e transiciona o pedido pra própria espelhando a degradação OC→própria do worker (`execution-worker.ts:612-668`). **Mec. 2 (Recebimento):** `receberItensViaOC` passa a setar `compra_status='recebido'` e chamar `checkAndReleasePedidos`, fechando o buraco do "preso pra sempre".

**Tech Stack:** TypeScript strict · Next.js App Router · Supabase (`createServiceClient`, service role) · vitest (unit, happy-dom) · runner de cenários E2E (`scripts/wms/cenarios`) contra staging real.

**Spec:** [`2026-06-02-reconciliador-saldo-oc-design.md`](../specs/2026-06-02-reconciliador-saldo-oc-design.md) · **Diagrama:** [`2026-06-02-reconciliador-saldo-oc-fluxo.html`](../specs/2026-06-02-reconciliador-saldo-oc-fluxo.html)

---

## Decisões travadas (do brainstorming)

1. **Auto-return:** estoque que aparece devolve o item ao picking sozinho.
2. **Só saldo livre:** usa `disponivel` (saldo − reservado); nunca toca reserva alheia. A reserva atômica é a fonte da verdade contra oversell.
3. **FIFO estrito:** pedido mais antigo (por `siso_pedidos.criado_em`, a convenção de aging já usada em todo o código) primeiro; ao encontrar um que o saldo não cobre, **para** (não fura a fila).
4. **Limite:** age só em itens **não comprados** (`compra_status IN ('oc_pendente','aguardando_compra')`). Item `comprado`/`recebido` segue pelo recebimento (Mec. 2).
5. **Transição de volta:** espelha a degradação OC→própria do worker (`decisao_final='propria'`, `status_separacao='aguardando_nf'`, enfileira `lancar_estoque`), com guarda pra **não** regredir um pedido já em `em_separacao`.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/lib/wms/reconciliador-oc.ts` | Reconciliador: seletor FIFO puro + orquestrador `reconciliarEntradaEstoque` | **Criar** |
| `src/lib/wms/reconciliador-oc.test.ts` | Unit do seletor FIFO puro | **Criar** |
| `src/lib/wms/ledger.ts:230-256` | Gancho mov `E`: chamar o reconciliador além da varredura | **Modificar** |
| `src/lib/wms/receber-oc.ts:246-296` | Mec. 2: setar `recebido` + release + lock otimista | **Modificar** |
| `scripts/wms/cenarios/catalogo/80-reconciliador-saldo-oc.ts` | E2E Mec. 1 (FIFO) | **Criar** |
| `scripts/wms/cenarios/catalogo/81-receber-oc-destrava-pedido.ts` | E2E Mec. 2 | **Criar** |
| `erros-conhecidos.yaml` · `CLAUDE.md` · `docs/fluxos-siso.md` | Docs | **Modificar** |

---

## Task 1: Seletor FIFO puro + unit tests

**Files:**
- Create: `src/lib/wms/reconciliador-oc.ts` (só a função pura nesta task)
- Test: `src/lib/wms/reconciliador-oc.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/wms/reconciliador-oc.test.ts
import { describe, it, expect } from "vitest";
import { selecionarLiberaveisFifo } from "./reconciliador-oc";

describe("selecionarLiberaveisFifo — FIFO estrito, respeita saldo livre", () => {
  it("cobre o mais antigo e sobra não cobre o próximo (exemplo ACD003: 15 livre)", () => {
    const r = selecionarLiberaveisFifo(
      [
        { id: "i2001", outstanding: 13 }, // mais antigo (já vem ordenado)
        { id: "i2050", outstanding: 10 },
      ],
      15,
    );
    expect(r[0]).toMatchObject({ id: "i2001", libera: true });
    expect(r[1]).toMatchObject({ id: "i2050", libera: false });
  });

  it("FIFO estrito: se o mais antigo não cabe, NÃO libera o mais novo (não fura fila)", () => {
    const r = selecionarLiberaveisFifo(
      [
        { id: "velho", outstanding: 100 },
        { id: "novo", outstanding: 5 },
      ],
      10,
    );
    expect(r[0]).toMatchObject({ id: "velho", libera: false });
    expect(r[1]).toMatchObject({ id: "novo", libera: false });
  });

  it("libera vários em sequência enquanto o saldo livre aguenta", () => {
    const r = selecionarLiberaveisFifo(
      [
        { id: "a", outstanding: 4 },
        { id: "b", outstanding: 4 },
        { id: "c", outstanding: 4 },
      ],
      9,
    );
    expect(r.map((x) => x.libera)).toEqual([true, true, false]);
  });

  it("outstanding 0 é ignorado e não bloqueia a fila", () => {
    const r = selecionarLiberaveisFifo(
      [
        { id: "zero", outstanding: 0 },
        { id: "real", outstanding: 3 },
      ],
      3,
    );
    expect(r[0]).toMatchObject({ id: "zero", libera: false });
    expect(r[1]).toMatchObject({ id: "real", libera: true });
  });

  it("saldo livre 0 não libera nada", () => {
    const r = selecionarLiberaveisFifo([{ id: "a", outstanding: 1 }], 0);
    expect(r[0].libera).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -- reconciliador-oc`
Expected: FAIL — `selecionarLiberaveisFifo` não existe / módulo não encontrado.

- [ ] **Step 3: Implementação mínima**

```ts
// src/lib/wms/reconciliador-oc.ts
// ──────────────────────────────────────────────────────────────────
// Reconciliador de saldo OC — quando entra estoque, devolve ao picking
// os pedidos parados por falta (FIFO, mais antigo primeiro), usando só
// saldo LIVRE. Disparado pelo gancho de mov E em ledger.ts.

/** Item OC pendente, já ordenado do mais antigo pro mais novo. */
export interface PendenteOc {
  /** id do siso_pedido_itens */
  id: string;
  /** quantidade ainda em falta (qtyEfetiva) */
  outstanding: number;
}

/**
 * FIFO estrito: percorre os pendentes (já ordenados por antiguidade) e marca
 * `libera=true` enquanto o saldo livre cobre o `outstanding` de cada um. Ao
 * encontrar o primeiro que não cabe, bloqueia o resto (não fura a fila).
 */
export function selecionarLiberaveisFifo<T extends { outstanding: number }>(
  pendentesOrdenados: T[],
  saldoLivre: number,
): Array<T & { libera: boolean }> {
  let restante = Math.max(0, saldoLivre);
  let bloqueado = false;
  return pendentesOrdenados.map((item) => {
    const need = Math.max(0, item.outstanding);
    if (!bloqueado && need > 0 && need <= restante) {
      restante -= need;
      return { ...item, libera: true };
    }
    if (need > 0) bloqueado = true;
    return { ...item, libera: false };
  });
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -- reconciliador-oc`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/reconciliador-oc.ts src/lib/wms/reconciliador-oc.test.ts
git commit -m "feat(wms): seletor FIFO puro do reconciliador de saldo OC"
```

---

## Task 2: Orquestrador `reconciliarEntradaEstoque` (IO)

**Files:**
- Modify: `src/lib/wms/reconciliador-oc.ts` (adicionar o orquestrador abaixo do seletor)

Reúsa, sem reimplementar:
- `reservarAtomico` (`src/lib/wms/reservas.ts:20`) — cria a R (passar `ttl_horas: 24*30`).
- `buscarLocComMaiorSaldoNoGalpao` (`src/lib/separacao/wms-mapping.ts:70`) — escolhe a loc.
- `cancelOcIfEmpty` (`src/lib/compras-utils.ts:178`) — fecha/cancela a OC ao desvincular.
- `registrarEvento` (`src/lib/historico-service.ts`) — histórico fire-and-forget.
- `logger` (`src/lib/logger.ts`).

Espelha a transição OC→própria do worker (`execution-worker.ts:612-668`) e a guarda `em_separacao` do `encontrei` (`validar-oc-item:631-646`).

- [ ] **Step 1: Implementar o orquestrador**

```ts
// src/lib/wms/reconciliador-oc.ts  (append)
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { reservarAtomico } from "@/lib/wms/reservas";
import { buscarLocComMaiorSaldoNoGalpao } from "@/lib/separacao/wms-mapping";
import { cancelOcIfEmpty } from "@/lib/compras-utils";
import { registrarEvento } from "@/lib/historico-service";

const STATUS_PEDIDO_OC = ["validacao_oc", "aguardando_compra"] as const;
const COMPRA_PENDENTE = ["oc_pendente", "aguardando_compra"] as const;

/**
 * Chamado fire-and-forget pelo gancho de mov E. Recebe a tripla produto+galpão
 * (produto_id é o uuid WMS, vindo do ledger). Devolve ao picking os pedidos OC
 * parados por falta desse produto, FIFO, dentro do saldo livre.
 */
export async function reconciliarEntradaEstoque(args: {
  produtoId: string; // uuid WMS (siso_produtos.id)
  galpaoId: string;
}): Promise<void> {
  const { produtoId, galpaoId } = args;
  const supabase = createServiceClient();

  // 1. produto uuid → sku (itens OC são casados por sku, como no resto do módulo)
  const { data: prod } = await supabase
    .from("siso_produtos")
    .select("sku")
    .eq("id", produtoId)
    .maybeSingle();
  const sku = prod?.sku as string | undefined;
  if (!sku) return;

  // 2. itens OC pendentes desse sku, em pedidos desse galpão em estado OC
  const { data: rows } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, pedido_id, quantidade_pedida, quantidade_pega, compra_status, ordem_compra_id, siso_pedidos!inner(id, criado_em, status_separacao, separacao_galpao_id)",
    )
    .eq("sku", sku)
    .in("compra_status", COMPRA_PENDENTE as unknown as string[])
    .eq("siso_pedidos.separacao_galpao_id", galpaoId)
    .in(
      "siso_pedidos.status_separacao",
      STATUS_PEDIDO_OC as unknown as string[],
    );
  if (!rows || rows.length === 0) return;

  // 3. desconta partes já picadas (parcial + realocações) — igual ao qtyEfetiva
  //    do validar-oc-item, pra não devolver/reservar qty que já saiu.
  const itemIds = rows.map((r) => r.id as string);
  const { data: realocs } = await supabase
    .from("siso_pedido_item_realocacoes")
    .select("pedido_item_id, qty_picada")
    .in("pedido_item_id", itemIds)
    .eq("status", "picado");
  const picadoPorItem = new Map<string, number>();
  for (const r of realocs ?? []) {
    const k = r.pedido_item_id as string;
    picadoPorItem.set(k, (picadoPorItem.get(k) ?? 0) + Number(r.qty_picada ?? 0));
  }

  type Linha = {
    id: string;
    pedido_id: string;
    ordem_compra_id: string | null;
    criado_em: string;
    outstanding: number;
  };
  const pendentes: Linha[] = rows
    .map((r) => {
      const ped = r.siso_pedidos as { id: string; criado_em?: string } | null;
      const outstanding = Math.max(
        0,
        Number(r.quantidade_pedida ?? 0) -
          Number(r.quantidade_pega ?? 0) -
          (picadoPorItem.get(r.id as string) ?? 0),
      );
      return {
        id: r.id as string,
        pedido_id: r.pedido_id as string,
        ordem_compra_id: (r.ordem_compra_id as string | null) ?? null,
        criado_em: ped?.criado_em ?? "",
        outstanding,
      };
    })
    .filter((l) => l.outstanding > 0)
    // FIFO: mais antigo primeiro (criado_em = convenção de aging do projeto)
    .sort((a, b) => a.criado_em.localeCompare(b.criado_em));
  if (pendentes.length === 0) return;

  // 4. saldo LIVRE do produto no galpão (soma disponivel das locs)
  const { data: est } = await supabase
    .from("siso_estoque")
    .select("disponivel")
    .eq("produto_id", produtoId)
    .eq("galpao_id", galpaoId)
    .gt("disponivel", 0);
  const saldoLivre = (est ?? []).reduce(
    (acc, row) => acc + Number(row.disponivel ?? 0),
    0,
  );
  if (saldoLivre <= 0) return;

  // 5. seleção FIFO estrita (função pura testada na Task 1)
  const selecao = selecionarLiberaveisFifo(pendentes, saldoLivre);

  // 6. para cada liberável: reserva atômica → desvincula OC → limpa campos
  const pedidosAfetados = new Set<string>();
  for (const linha of selecao) {
    if (!linha.libera) continue;

    const locId = await buscarLocComMaiorSaldoNoGalpao(galpaoId, produtoId);
    if (!locId) continue; // sem loc com saldo — pula

    try {
      await reservarAtomico({
        tripla: { produto_id: produtoId, galpao_id: galpaoId, localizacao_id: locId },
        qty: linha.outstanding,
        pedido_id: linha.pedido_id,
        ttl_horas: 24 * 30, // 30 dias, igual webhook/aprovar
      });
    } catch (err) {
      // saldo sumiu/loc não cobre (corrida) → não libera; tenta na próxima entrada
      logger.warn("reconciliador-oc", "reserva falhou; item segue na compra", {
        item_id: linha.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const { error: updErr } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: null,
        ordem_compra_id: null,
        compra_quantidade_solicitada: 0,
        compra_solicitada_em: null,
        fornecedor_oc: null,
      })
      .eq("id", linha.id);
    if (updErr) {
      logger.logError({
        error: updErr,
        source: "reconciliador-oc",
        message: `Falha ao limpar campos de compra do item ${linha.id}`,
        category: "database",
      });
      continue;
    }

    await cancelOcIfEmpty(supabase, linha.ordem_compra_id, "reconciliador-oc");
    pedidosAfetados.add(linha.pedido_id);

    registrarEvento({
      pedidoId: linha.pedido_id,
      evento: "oc_item_saldo_reconciliado",
      detalhes: { item_id: linha.id, sku, qty: linha.outstanding, galpao_id: galpaoId },
    });
  }

  // 7. recomputa status dos pedidos afetados (espelha worker OC→própria)
  for (const pedidoId of pedidosAfetados) {
    await transicionarPedidoSeReconciliado(supabase, pedidoId);
  }
}

/**
 * Se o pedido não tem mais nenhum item em fluxo de compra, vira própria e
 * reentra no portão de NF (espelha execution-worker.ts:612-668), salvo se já
 * está em em_separacao (não regride — igual ao 'encontrei').
 */
async function transicionarPedidoSeReconciliado(
  supabase: ReturnType<typeof createServiceClient>,
  pedidoId: string,
): Promise<void> {
  const { data: allItems } = await supabase
    .from("siso_pedido_itens")
    .select("compra_status")
    .eq("pedido_id", pedidoId);
  if (!allItems) return;

  // ainda há item em compra (oc_pendente/aguardando_compra/comprado) → não transita
  const aindaEmCompra = allItems.some(
    (i) =>
      i.compra_status === "oc_pendente" ||
      i.compra_status === "aguardando_compra" ||
      i.compra_status === "comprado",
  );
  if (aindaEmCompra) return;

  const { data: pedido } = await supabase
    .from("siso_pedidos")
    .select("id, status_separacao, empresa_origem_id")
    .eq("id", pedidoId)
    .maybeSingle();
  if (!pedido) return;

  // em_separacao: operador já está separando → só garante decisao propria, não regride
  if (pedido.status_separacao === "em_separacao") {
    await supabase
      .from("siso_pedidos")
      .update({ decisao_final: "propria" })
      .eq("id", pedidoId);
    return;
  }

  // validacao_oc / aguardando_compra → vira própria e reentra no portão de NF
  await supabase
    .from("siso_pedidos")
    .update({
      decisao_final: "propria",
      status: "executando",
      status_separacao: "aguardando_nf",
    })
    .eq("id", pedidoId);

  // enfileira lancar_estoque(propria) se não houver um pendente (idempotência)
  const { data: jobExistente } = await supabase
    .from("siso_fila_execucao")
    .select("id")
    .eq("pedido_id", pedidoId)
    .eq("tipo", "lancar_estoque")
    .in("status", ["pendente", "executando"])
    .maybeSingle();
  if (!jobExistente) {
    await supabase.from("siso_fila_execucao").insert({
      pedido_id: pedidoId,
      tipo: "lancar_estoque",
      empresa_id: pedido.empresa_origem_id,
      decisao: "propria",
    });
  }

  logger.info("reconciliador-oc", "pedido OC devolvido ao fluxo próprio por saldo", {
    pedidoId,
  });
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit 2>&1 | grep reconciliador-oc || echo "OK sem erros no módulo"`
Expected: `OK sem erros no módulo` (o único erro pré-existente do repo é `@testing-library/react` num teto não relacionado).

- [ ] **Step 3: Commit**

```bash
git add src/lib/wms/reconciliador-oc.ts
git commit -m "feat(wms): orquestrador reconciliarEntradaEstoque (FIFO + reserva + transição própria)"
```

---

## Task 3: Ligar o reconciliador no gancho de mov E

**Files:**
- Modify: `src/lib/wms/ledger.ts:230-256` (o bloco `if (tipo === "E" && ...)`)

O gancho já roda `varrerPedidosAfetadosPorEntrada` (banner). Adicionar a chamada do reconciliador no mesmo bloco fire-and-forget (lazy import, try/catch→warn).

- [ ] **Step 1: Adicionar a chamada do reconciliador**

Localizar (`src/lib/wms/ledger.ts`, dentro do `void (async () => { try { ... } })()`), logo após o `await varrerPedidosAfetadosPorEntrada({...})`:

```ts
        await varrerPedidosAfetadosPorEntrada({
          produto_id: tripla.produto_id,
          galpao_id: tripla.galpao_id,
          localizacao_id: tripla.localizacao_id,
        });

        // Reconciliador OC: devolve ao picking pedidos parados por falta cujo
        // saldo livre agora cobre (FIFO). Fire-and-forget; erros não fatais.
        const { reconciliarEntradaEstoque } = await import("./reconciliador-oc");
        await reconciliarEntradaEstoque({
          produtoId: tripla.produto_id,
          galpaoId: tripla.galpao_id,
        });
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "ledger|reconciliador" || echo "OK"`
Expected: `OK`.

- [ ] **Step 3: Verificar que não criou ciclo de import**

Run: `npm run build 2>&1 | tail -20`
Expected: build conclui sem erro de ciclo (o lazy `import()` quebra o ciclo ledger↔reconciliador, igual à varredura).

- [ ] **Step 4: Commit**

```bash
git add src/lib/wms/ledger.ts
git commit -m "feat(wms): disparar reconciliador OC a cada entrada de estoque (mov E)"
```

---

## Task 4: Cenário E2E — Mec. 1 (estoque chega → FIFO → volta pro picking)

**Files:**
- Create: `scripts/wms/cenarios/catalogo/80-reconciliador-saldo-oc.ts`

Espelha o cenário 69. Cria 2 pedidos OC do mesmo SKU sem saldo, injeta saldo parcial (cobre só o mais antigo), e verifica que o mais antigo voltou pra própria (`decisao_final='propria'`, item `compra_status=null`, reserva criada) e o mais novo continua na compra.

- [ ] **Step 1: Escrever o cenário**

```ts
// scripts/wms/cenarios/catalogo/80-reconciliador-saldo-oc.ts
import type { Cenario, Ctx } from "../_harness/types";

type TSetup = { sku: string };

async function carregarItemPorPedido(ctx: Ctx, pedidoId: string) {
  const { data } = await ctx.sb
    .from("siso_pedido_itens")
    .select("id, compra_status, ordem_compra_id")
    .eq("pedido_id", pedidoId)
    .limit(1)
    .single();
  return data!;
}
async function carregarPedido(ctx: Ctx, pedidoId: string) {
  const { data } = await ctx.sb
    .from("siso_pedidos")
    .select("id, status_separacao, decisao_final")
    .eq("id", pedidoId)
    .single();
  return data!;
}

export default {
  nome: "80 — Reconciliador: estoque chega devolve o pedido OC mais antigo ao picking (FIFO)",
  descricao:
    "Dois pedidos OC do mesmo SKU sem saldo. Entra saldo que cobre só o mais antigo. O mais antigo vira própria; o mais novo segue na compra.",
  tags: ["reconciliador", "oc", "fifo", "estoque", "wms"],
  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("80");
    await ctx.criarProduto({ sku, descricao: "Reconciliador FIFO 80" });
    // SEM saldo inicial → os pedidos caem em OC.
    return { sku };
  },
  run: async (ctx, { sku }) => {
    // Pedido 1 (mais antigo): precisa 13
    const p1 = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 13 }],
    });
    // Pedido 2 (mais novo): precisa 10
    const p2 = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 10 }],
    });
    await ctx.aguardarStatus(p1.id, "concluido");
    await ctx.aguardarStatus(p2.id, "concluido");
    // Garante ordem FIFO determinística (criado_em do p1 < p2)
    await ctx.sb
      .from("siso_pedidos")
      .update({ criado_em: "2026-01-01T00:00:00Z" })
      .eq("id", p1.id);
    await ctx.sb
      .from("siso_pedidos")
      .update({ criado_em: "2026-01-02T00:00:00Z" })
      .eq("id", p2.id);
    // Aprova os dois como OC (operador) → validacao_oc, itens oc_pendente
    await ctx.aprovar(p1.id, "oc");
    await ctx.aprovar(p2.id, "oc");
    await ctx.aguardarStatusSeparacao(p1.id, "validacao_oc");
    await ctx.aguardarStatusSeparacao(p2.id, "validacao_oc");

    // Chega 15 no galpão de separação (CWB) → mov E dispara o reconciliador.
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-03", qty: 15 });

    // dá tempo do fire-and-forget rodar
    await new Promise((r) => setTimeout(r, 1500));
    return { p1: p1.id, p2: p2.id };
  },
  assertEsperado: async (ctx, _setup, { p1, p2 }: { p1: string; p2: string }) => {
    const ped1 = await carregarPedido(ctx, p1);
    const item1 = await carregarItemPorPedido(ctx, p1);
    if (ped1.decisao_final !== "propria")
      throw new Error(`p1 deveria virar propria, veio ${ped1.decisao_final}`);
    if (item1.compra_status !== null)
      throw new Error(`item p1 deveria ter compra_status=null, veio ${item1.compra_status}`);
    if (ped1.status_separacao !== "aguardando_nf")
      throw new Error(`p1 deveria ir pra aguardando_nf, veio ${ped1.status_separacao}`);

    const item2 = await carregarItemPorPedido(ctx, p2);
    if (item2.compra_status === null)
      throw new Error("item p2 (mais novo) NÃO deveria ter sido reconciliado (sobrou só 2)");
  },
} satisfies Cenario<TSetup>;
```

> **Nota:** se a assinatura de `assertEsperado` no harness for `(ctx, setup)` (sem 3º arg de retorno do `run`), guarde os ids em `setup` no `run` (mute o objeto de setup) ou recarregue por SKU. Conferir `scripts/wms/cenarios/_harness/types.ts` ao implementar e ajustar a assinatura pra bater com o `Cenario<TSetup>` real.

- [ ] **Step 2: Rodar o cenário contra staging**

Run: `npm run scenarios:only "80 —"`
Expected: cenário 80 PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/wms/cenarios/catalogo/80-reconciliador-saldo-oc.ts
git commit -m "test(wms): cenário 80 — reconciliador FIFO devolve OC ao picking"
```

---

## Task 5: Mec. 2 — unificar `receberItensViaOC` (setar recebido + release)

**Files:**
- Modify: `src/lib/wms/receber-oc.ts` (bloco do incremento ~246-252 e fim da função ~291-305)

Hoje `receberItensViaOC` só incrementa `compra_quantidade_recebida` e nunca libera o pedido. Passar a: (a) com lock otimista, incrementar; (b) quando `recebido >= solicitado`, setar `compra_status='recebido'`; (c) ao fim, chamar `checkAndReleasePedidos` com os itens recebidos.

- [ ] **Step 1: Importar o release no topo do arquivo**

```ts
// src/lib/wms/receber-oc.ts (junto dos outros imports)
import { checkAndReleasePedidos } from "@/lib/compras-release";
```

- [ ] **Step 2: Trocar o incremento por incremento + flag recebido (lock otimista)**

Substituir o bloco atual (receber-oc.ts ~246-252):

```ts
// Atualiza compra_quantidade_recebida
const novaQtyReceb =
  Number(item.compra_quantidade_recebida ?? 0) + itemReq.qty_real;
await supabase
  .from("siso_pedido_itens")
  .update({ compra_quantidade_recebida: novaQtyReceb })
  .eq("id", item.id);
```

por:

```ts
// Atualiza compra_quantidade_recebida (lock otimista contra recebimento concorrente)
const jaRecebido = Number(item.compra_quantidade_recebida ?? 0);
const novaQtyReceb = jaRecebido + itemReq.qty_real;
const qtySolic = Number(item.compra_quantidade_solicitada ?? 0);
const updatePayload: Record<string, unknown> = {
  compra_quantidade_recebida: novaQtyReceb,
};
// Mec. 2: ao completar o solicitado, marca recebido pro release enxergar.
if (qtySolic > 0 && novaQtyReceb >= qtySolic) {
  updatePayload.compra_status = "recebido";
}
const { error: updRecebErr } = await supabase
  .from("siso_pedido_itens")
  .update(updatePayload)
  .eq("id", item.id)
  .eq("compra_quantidade_recebida", jaRecebido); // optimistic lock
if (updRecebErr) {
  logger.warn("receber-oc", "update de recebimento falhou (lock); pulando item", {
    item_id: item.id,
    error: updRecebErr.message,
  });
  continue;
}
itensRecebidosIds.push(String(item.id));
```

- [ ] **Step 3: Declarar o acumulador e chamar o release no fim**

No início da função `receberItensViaOC` (junto das outras declarações de acumulador, ex. `pendenciasCriadas`), adicionar:

```ts
const itensRecebidosIds: string[] = [];
```

E ao final da função, **depois** do bloco que fecha a OC header (receber-oc.ts ~291-296), antes do `return`:

```ts
// Mec. 2: libera os pedidos cujos itens de compra agora estão todos resolvidos.
// checkAndReleasePedidos é idempotente (guarda de status + índice único).
if (itensRecebidosIds.length > 0) {
  try {
    await checkAndReleasePedidos(itensRecebidosIds);
  } catch (err) {
    logger.warn("receber-oc", "checkAndReleasePedidos falhou (não-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

- [ ] **Step 4: Verificar typecheck**

Run: `npx tsc --noEmit 2>&1 | grep receber-oc || echo "OK"`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wms/receber-oc.ts
git commit -m "fix(wms): receberItensViaOC seta recebido + libera o pedido (unifica os 2 recebimentos)"
```

---

## Task 6: Cenário E2E — Mec. 2 (receber via OC destrava o pedido)

**Files:**
- Create: `scripts/wms/cenarios/catalogo/81-receber-oc-destrava-pedido.ts`

Pedido 100% OC → esgotado → comprado → recebido via `/api/wms/receber/oc/[id]` → pedido deve sair de `aguardando_compra` (release).

- [ ] **Step 1: Escrever o cenário**

```ts
// scripts/wms/cenarios/catalogo/81-receber-oc-destrava-pedido.ts
import type { Cenario, Ctx } from "../_harness/types";

type TSetup = { sku: string };

export default {
  nome: "81 — Receber via OC destrava o pedido (status sai de aguardando_compra)",
  descricao:
    "Pedido 100% OC, esgotado e comprado. Receber pelo caminho /receber/oc/[id] deve setar recebido e liberar o pedido.",
  tags: ["reconciliador", "oc", "recebimento", "release", "wms"],
  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("81");
    await ctx.criarProduto({ sku, descricao: "Receber OC destrava 81" });
    return { sku };
  },
  run: async (ctx, { sku }) => {
    const ped = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 4 }],
    });
    await ctx.aguardarStatus(ped.id, "concluido");
    await ctx.aprovar(ped.id, "oc");
    await ctx.aguardarStatusSeparacao(ped.id, "validacao_oc");

    // marcar esgotado o item (vai pra compra) — usa o endpoint real de validação OC
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .select("id")
      .eq("pedido_id", ped.id)
      .single();
    await ctx.http.post("/api/wms/separacao/validar-oc-item", {
      item_ids: [item!.id],
      acao: "esgotado",
    });
    await ctx.aguardarStatusSeparacao(ped.id, "aguardando_compra");

    // comprar (via comprador) → comprado
    await ctx.comprar({ sku });

    // receber via OC: resolve a OC vinculada e chama o endpoint /receber/oc/[id]
    const { data: itemOc } = await ctx.sb
      .from("siso_pedido_itens")
      .select("ordem_compra_id")
      .eq("pedido_id", ped.id)
      .single();
    const ocId = itemOc!.ordem_compra_id as string;
    await ctx.http.post(`/api/wms/receber/oc/${ocId}`, {
      itens: [{ sku, qty_real: 4, custo_unitario: 10 }],
    });

    await new Promise((r) => setTimeout(r, 1500));
    return { pedidoId: ped.id };
  },
  assertEsperado: async (ctx, _s, { pedidoId }: { pedidoId: string }) => {
    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .select("status_separacao")
      .eq("id", pedidoId)
      .single();
    if (ped!.status_separacao === "aguardando_compra")
      throw new Error("pedido continuou preso em aguardando_compra após receber a OC");
  },
} satisfies Cenario<TSetup>;
```

> **Nota:** ajustar os contratos de chamada (`ctx.http.post`, `ctx.comprar`, shape do body de `validar-oc-item` e de `/receber/oc/[id]`) aos helpers reais do harness ao implementar — conferir `_harness/types.ts` e um cenário existente que já chame esses endpoints. O assert essencial (não ficar em `aguardando_compra`) é o que importa.

- [ ] **Step 2: Rodar**

Run: `npm run scenarios:only "81 —"`
Expected: cenário 81 PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/wms/cenarios/catalogo/81-receber-oc-destrava-pedido.ts
git commit -m "test(wms): cenário 81 — receber via OC destrava o pedido"
```

---

## Task 7: Regressão dos fluxos OC existentes

**Files:** nenhum (só execução)

- [ ] **Step 1: Rodar a suíte de cenários OC/separação existente**

Run: `npm run scenarios -- --filter oc` (e também `--filter separacao`)
Expected: todos PASS — em especial os que cobrem validacao_oc, esgotado/encontrei e parcial (cenário 69). Nenhuma regressão do reconciliador disparando indevidamente.

- [ ] **Step 2: Rodar a unit suite**

Run: `npm test`
Expected: PASS (inclui `reconciliador-oc` e `distribuir-qty-pega`).

- [ ] **Step 3 (se algo quebrar):** abrir como bug, voltar pro systematic-debugging. Não seguir pra docs com cenário vermelho.

---

## Task 8: Documentação + erros-conhecidos

**Files:**
- Modify: `erros-conhecidos.yaml` · `CLAUDE.md` · `docs/fluxos-siso.md`

- [ ] **Step 1: Entrada em `erros-conhecidos.yaml`**

Adicionar (seguindo o formato do arquivo): `id: oc-item-preso-em-esgotado-mesmo-com-estoque`, `date: "2026-06-02"`, `source: wms.separacao / wms.compras`, `category: business_logic`, descrevendo (causa) a decisão OC congelada + os dois recebimentos divergentes, e (fix) o reconciliador event-driven (Mec. 1) + a unificação do recebimento (Mec. 2). `files:` os 3 arquivos tocados. `tags: [reconciliador, oc, esgotado, estoque, fifo, recebimento, release, wms]`.

- [ ] **Step 2: `CLAUDE.md`** — no bloco do pipeline (seção "Arquitetura & Pipeline") e/ou Gotchas, registrar: "Entrada de estoque (mov E) dispara o reconciliador (`reconciliador-oc.ts`): devolve ao picking, FIFO, pedidos OC parados cujo saldo livre cobre; receber via OC agora libera o pedido."

- [ ] **Step 3: `docs/fluxos-siso.md`** — acrescentar o passo de reconciliação no fluxo OC.

- [ ] **Step 4: Commit**

```bash
git add erros-conhecidos.yaml CLAUDE.md docs/fluxos-siso.md
git commit -m "docs(wms): reconciliador de saldo OC + unificação de recebimento"
```

---

## Self-Review (preenchido)

- **Cobertura do spec:** Mec. 1 (Tasks 1-4), Mec. 2 (Tasks 5-6), regressão (Task 7), docs (Task 8). FIFO por `criado_em`, reserva atômica, respeito a reservas (via `disponivel`), transição própria — todos cobertos.
- **Decisão "FIFO estrito" (para no 1º que não cabe):** travada na função pura (Task 1). Alternativa "greedy" (libera os menores que cabem, furando a fila) NÃO foi escolhida — se o usuário preferir, é trocar o `bloqueado` por um `continue` no seletor.
- **Limitação herdada:** a reserva usa **uma** loc (a de maior saldo), não fragmenta entre locs (igual `criarReservasPedido`/roteamento). Se o outstanding > maior loc mas o galpão soma o suficiente, a reserva falha e o item espera a próxima entrada. Documentado; fora de escopo consertar agora.
- **Ambiguidades resolvidas:** "data real" = `criado_em` (convenção do projeto, não `data` de marketplace). `compra_quantidade_solicitada` zerado com `0` (coluna NOT NULL — não usar `null`).
- **Tipos consistentes:** `selecionarLiberaveisFifo`, `reconciliarEntradaEstoque`, `transicionarPedidoSeReconciliado` batem entre tasks; status strings (`aguardando_nf`, `validacao_oc`, `aguardando_compra`, `em_separacao`) e `compra_status` conferidos contra `src/types/index.ts`.
