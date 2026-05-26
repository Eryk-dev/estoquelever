import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "19 — Aprovar sem cobertura devolve 409",
  descricao:
    "Pedido entra sem saldo, operador tenta aprovar via API direta como " +
    "propria sem ter adicionado estoque — backend devolve 409, pedido " +
    "continua pendente, nenhuma R órfã.",
  tags: ["pedido", "aprovar", "reserva", "wms-as-source", "falha"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("19");
    await ctx.criarProduto({ sku, descricao: "Aprovar sem cobertura 19" });
    // Intencionalmente NÃO semeia saldo — o cenário valida o caminho de falha.
    return { sku };
  },

  run: async (ctx: Ctx, { sku }: { sku: string }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 5 }],
    });
    // Pedido deve aparecer pendente (sem saldo → sugestao='oc', mas pode
    // ser propria se o algoritmo não tiver estoque de outros galpões
    // também — o importante é que esteja pendente pra manual).
    await ctx.aguardarStatus(pedido.id, "pendente", { decisao: undefined });

    // Tenta aprovar como propria SEM ter adicionado saldo.
    // ctx.aprovar lança HttpError em qualquer 4xx — capturar e validar.
    let erro: Error | null = null;
    try {
      await ctx.aprovar(pedido.id, "propria");
    } catch (e) {
      erro = e as Error;
    }
    if (!erro) {
      throw new Error("aprovar deveria ter falhado com 409 mas não falhou");
    }
    // HttpError formata como: "POST /path → HTTP 409: {\"error\":\"reserva_falhou\"...}"
    // O status 409 ou o campo error da resposta estão na mensagem.
    if (!/409|reserva_falhou|sem_saldo/i.test(erro.message)) {
      throw new Error(
        `aprovar falhou mas mensagem inesperada: ${erro.message}`,
      );
    }
  },

  assertEsperado: async (ctx: Ctx, { sku }: { sku: string }) => {
    // Busca o pedido_id via siso_pedido_itens (ctx.sb disponível no Ctx).
    const { data: itemRow } = await ctx.sb
      .from("siso_pedido_itens")
      .select("pedido_id")
      .eq("sku", sku)
      .maybeSingle();
    if (itemRow?.pedido_id) {
      // Pedido deve continuar pendente — aprovação falhou antes de transitar.
      await ctx.assertPedidoStatus(String(itemRow.pedido_id), "pendente");
    }
    // Nenhuma reserva R órfã deve existir — rollback funcionou (ou nada foi criado).
    await ctx.assertSemReservasOrfas();
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
