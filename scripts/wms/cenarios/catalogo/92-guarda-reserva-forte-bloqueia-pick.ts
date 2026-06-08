/**
 * 92 — Guarda reserva forte bloqueia pick concorrente
 *
 * Prova que iniciar a guarda RESERVA o saldo físico ainda na loc de
 * recebimento ("reserva forte"), zerando o disponível. Com disponível=0, o
 * roteamento de um pedido novo do mesmo SKU NÃO separa direto do recebimento:
 * decide OC (sem cobertura). Cancelar a guarda libera a reserva.
 *
 * A peça física continua na loc (saldo=10) — só fica indisponível pro pick
 * enquanto a guarda está em andamento. O efeito observável é a DECISÃO de
 * roteamento (sugestao='oc'), não o saldo: sem a reserva forte, o roteador
 * separaria direto do recebimento (propria).
 *
 * Fluxo:
 *   1. Receber 10 un → pendência (RECEBIMENTO saldo=10, reservado=0)
 *   2. POST /guarda/[id]/iniciar → reserva 10 (RECEBIMENTO reservado=10, disponivel=0)
 *   3. Webhook NetAir qty=10 → disponível=0 → roteia OC (sugestao='oc'),
 *      NÃO separa do recebimento.
 *   4. POST /guarda/[id]/cancelar → libera a R (RECEBIMENTO reservado=0)
 */

import type { Cenario, Ctx } from "../_harness/types";

// Aguarda a coluna `sugestao` do pedido virar o valor esperado. O webhook é
// fire-and-forget e o processor faz round-trips Tiny (mesmo no stub), então a
// sugestão de roteamento leva alguns segundos pra materializar.
async function aguardarSugestao(
  ctx: Ctx,
  pedidoId: string,
  sugestao: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let ultima: string | undefined;
  while (Date.now() < deadline) {
    const { data } = await ctx.sb
      .from("siso_pedidos")
      .select("sugestao")
      .eq("id", pedidoId)
      .maybeSingle();
    ultima = (data as { sugestao?: string } | null)?.sugestao;
    if (ultima === sugestao) return;
    await ctx.aguardar(200);
  }
  throw new Error(
    `aguardarSugestao: ${pedidoId} esperava sugestao=${sugestao} em ${timeoutMs}ms; última=${ultima}`,
  );
}

export default {
  nome: "92 — Guarda reserva forte bloqueia pick concorrente",
  descricao:
    "Receber 10 + iniciar guarda reserva os 10 (disponivel=0). Pedido do mesmo SKU vai pra OC (sem disponível). Cancelar guarda libera a R.",
  tags: ["guarda", "reserva-forte", "oc", "fase6"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("92");
    await ctx.criarProduto({ sku, descricao: "Reserva forte bloqueia pick 92" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1. Recebe 10 → pendência em RECEBIMENTO.
    const res = await ctx.receber({ galpao: "CWB", items: [{ sku, qty: 10 }] });
    const pendId = res.pendencias[0];
    if (!pendId) throw new Error("setup: pendência não criada");
    await ctx.assertReservado(sku, "CWB", "RECEBIMENTO", 0);

    // 2. Inicia a guarda → reserva forte trava os 10 (disponivel=0).
    await ctx.http.post(`/api/wms/guarda/${pendId}/iniciar`, {});
    await ctx.aguardarPendenciaGuarda(pendId, "em_guarda");
    await ctx.assertReservado(sku, "CWB", "RECEBIMENTO", 10);

    // 3. Pedido do mesmo SKU/galpão. Como disponivel=0 (reserva forte), o
    //    roteamento decide OC (sem cobertura) — NÃO separa do recebimento.
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 10 }],
    });
    ctx.log("pedido roteado", { id: pedido.id });
    // Efeito da reserva forte: a sugestão de roteamento é OC. Sem a reserva, o
    // roteador teria escolhido 'propria' (separar do recebimento). Aguardamos a
    // sugestão materializar (webhook é fire-and-forget).
    await aguardarSugestao(ctx, pedido.id, "oc", 15_000);

    // 4. Cancela a guarda → libera a reserva forte; disponivel volta.
    await ctx.http.post(`/api/wms/guarda/${pendId}/cancelar`, {
      motivo: "cenário 92 libera reserva forte",
    });
    await ctx.aguardarPendenciaGuarda(pendId, "cancelada");

    return { pedidoId: pedido.id };
  },

  assertEsperado: async (ctx, { sku }) => {
    // Reserva liberada: reservado de volta a 0; saldo físico intacto (10).
    await ctx.assertReservado(sku, "CWB", "RECEBIMENTO", 0);
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 10);
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";

// ESM-puro: roda só se invocado direto via `tsx <arquivo.ts>`.
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
