import type { Cenario, Ctx } from "../_harness/types";

/**
 * P3 #2.10 reverse — Reiniciar etapa='embalagem' reverte o cutover.
 *
 * Pedido propria com saldo 10, qty=3. Webhook auto-aprova → R criada
 * (saldo 10, reservado 3). Bipar + concluirSeparacao transita pra `separado`
 * e dispara o cutover (R→L+S): saldo 7, reservado 0, estoque_lancado=true.
 *
 * Chamar POST /api/wms/separacao/reiniciar com etapa='embalagem' deve:
 *   - Estornar todas as S do pedido via reverterCutoverSeRetrocedeu
 *   - Recriar reservas R nas mesmas triplas
 *   - Setar estoque_lancado=false no pedido
 *   - Zerar quantidade_bipada / bipado_completo dos itens
 *
 * Estado final: saldo 10 (restaurado), reservado 3 (R recriada), pedido
 * permanece em status_separacao='separado' (operador pode embalar de novo).
 */
export default {
  nome: "49 — Reiniciar embalagem reverte cutover (saldo + reserva restaurados)",
  descricao:
    "Pedido propria qty=3 com saldo 10. Após concluirSeparacao cutover " +
    "fira S movs (saldo 7, estoque_lancado=true). Reiniciar etapa='embalagem' " +
    "estorna S, recria R: saldo volta 10, reservado 3, estoque_lancado=false.",
  tags: ["p3", "reiniciar", "embalagem", "cutover", "reverse", "wms-as-source"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("49");
    await ctx.criarProduto({ sku, descricao: "P3-49 reiniciar embalagem" });
    await ctx.semearSaldo({
      produto: sku,
      galpao: "CWB",
      loc: "A-01-01",
      qty: 10,
      custo: 15,
    });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1) Webhook propria auto-aprova → R criada
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 3 }],
    });
    await ctx.aguardarStatus(pedido.id, "concluido", undefined, {
      timeout_ms: 10_000,
    });
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao");

    // R viva: saldo 10, reservado 3
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 10);
    await ctx.assertReservado(sku, "CWB", "A-01-01", 3);

    // 2) Picking
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 3 });
    await ctx.concluirSeparacao(pedido.id);
    await ctx.aguardarStatusSeparacao(pedido.id, "separado");

    // 3) Espera cutover ser enfileirado (dispararCutoverSePronto é fire-and-forget
    // em concluir/route.ts). Dá um polling curto pra fila aparecer.
    const cutoverEnqueueDeadline = Date.now() + 5_000;
    let cutoverJobFound = false;
    while (Date.now() < cutoverEnqueueDeadline) {
      const { count } = await ctx.sb
        .from("siso_fila_execucao")
        .select("id", { count: "exact", head: true })
        .eq("pedido_id", pedido.id)
        .eq("tipo", "lancar_estoque_pos_nf");
      if ((count ?? 0) > 0) {
        cutoverJobFound = true;
        break;
      }
      await ctx.aguardar(150);
    }
    if (!cutoverJobFound) {
      throw new Error(
        `cutover job lancar_estoque_pos_nf não apareceu na fila pra pedido ${pedido.id} em 5s`,
      );
    }

    // Trigger explícito do worker (kickWorker fire-and-forget pode ficar travado
    // no _draining se HMR reload o módulo). Limite=0 dispara drain assíncrono;
    // depois aguardamos a fila vazia.
    const workerSecret = process.env.WORKER_SECRET ?? "test-worker-secret";
    await ctx.http.post(
      "/api/wms/worker/processar?limit=0",
      {},
      { Authorization: `Bearer ${workerSecret}` },
    );
    await ctx.aguardarFilaVazia({ timeout_ms: 20_000 });

    // Sanity pré-reiniciar
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 7);
    await ctx.assertReservado(sku, "CWB", "A-01-01", 0);
    const { data: pedidoMid } = await ctx.sb
      .from("siso_pedidos")
      .select("estoque_lancado, status_separacao")
      .eq("id", pedido.id)
      .maybeSingle();
    const midRow = pedidoMid as
      | { estoque_lancado?: boolean; status_separacao?: string }
      | null;
    if (!midRow?.estoque_lancado) {
      throw new Error(
        `pré-condição: pedido ${pedido.id} deveria ter estoque_lancado=true após concluir (real=${midRow?.estoque_lancado})`,
      );
    }
    if (midRow.status_separacao !== "separado") {
      throw new Error(
        `pré-condição: pedido ${pedido.id} deveria estar em 'separado' (real=${midRow.status_separacao})`,
      );
    }
    ctx.log("pre-reiniciar", {
      pedido_id: pedido.id,
      saldo: 7,
      reservado: 0,
      estoque_lancado: true,
      status: "separado",
    });

    // 4) Reiniciar etapa='embalagem' — deve reverter cutover
    const r = await ctx.http.post<{
      ok: boolean;
      pedido_ids: string[];
      etapa: string;
    }>("/api/wms/separacao/reiniciar", {
      pedido_ids: [pedido.id],
      etapa: "embalagem",
    });
    if (!r?.ok) {
      throw new Error(
        `reiniciar respondeu falha: ${JSON.stringify(r)}`,
      );
    }
    ctx.log("reiniciar-embalagem", { pedido_id: pedido.id, response: r });
  },

  assertEsperado: async (ctx, { sku }) => {
    // Resolve pedido_id via item.sku → pedido_id (cenário cria 1 pedido único)
    const { data: pedidoIts } = await ctx.sb
      .from("siso_pedido_itens")
      .select("pedido_id")
      .eq("sku", sku)
      .limit(1);
    const pedidoId = (
      (pedidoIts as Array<{ pedido_id: string }> | null) ?? []
    )[0]?.pedido_id;
    if (!pedidoId) {
      throw new Error(`pedido_id não resolvido por sku=${sku}`);
    }

    // Saldo restaurado pro valor pré-cutover
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 10);
    // Reserva recriada
    await ctx.assertReservado(sku, "CWB", "A-01-01", 3);

    // Pedido marcado como não-lançado novamente
    const { data: pedido } = await ctx.sb
      .from("siso_pedidos")
      .select("estoque_lancado, status_separacao")
      .eq("id", pedidoId)
      .maybeSingle();
    const row = pedido as
      | { estoque_lancado?: boolean; status_separacao?: string }
      | null;
    if (row?.estoque_lancado !== false) {
      throw new Error(
        `esperava estoque_lancado=false após reiniciar (real=${row?.estoque_lancado})`,
      );
    }
    if (row?.status_separacao !== "separado") {
      throw new Error(
        `esperava status_separacao='separado' (preservado) após reiniciar (real=${row?.status_separacao})`,
      );
    }

    // Itens com bipados zerados
    const { data: itens } = await ctx.sb
      .from("siso_pedido_itens")
      .select("quantidade_bipada, bipado_completo")
      .eq("pedido_id", pedidoId);
    const items = (itens ?? []) as Array<{
      quantidade_bipada: number | null;
      bipado_completo: boolean | null;
    }>;
    for (const it of items) {
      if ((it.quantidade_bipada ?? 0) !== 0 || it.bipado_completo) {
        throw new Error(
          `esperava quantidade_bipada=0 e bipado_completo=false; achou ${JSON.stringify(it)}`,
        );
      }
    }

    // Total de movs do produto:
    //   1 E seed +
    //   1 R inicial +
    //   1 L (cutover) + 1 S (cutover) +
    //   1 E (estorno do S) + 1 R (recriada) = 6
    await ctx.assertMovsCount(sku, 6);

    // Sem reservas órfãs
    await ctx.assertSemReservasOrfas();
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";

const _isMain = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
