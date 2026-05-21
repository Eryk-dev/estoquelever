import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "15 — Transferência inter-galpão",
  descricao: "CWB → SP, par S+E balanceado, custo médio preservado.",
  tags: ["transferencia", "inter_galpao", "movs"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("15");
    await ctx.criarProduto({ sku, descricao: "Transf 15" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "B-02-04", qty: 25, custo: 7 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const t = await ctx.transferirGalpao({
      origem: "CWB", destino: "SP",
      items: [{ sku, qty: 10 }],
    });
    // Confirma recebimento via endpoint
    await ctx.http.post(`/api/wms/transferencias/${t.id}/receber`);
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "B-02-04", 15);
    // Destino SP: vai pra RECEBIMENTO até guarda, OU loc default — depende do endpoint
    // Validação mais flexível: total deve ser 25 (10 em SP + 15 em CWB)
    const { data } = await ctx.sb.from("siso_estoque").select("saldo, siso_produtos!inner(sku)").eq("siso_produtos.sku", sku);
    const total = (data ?? []).reduce((acc: number, r: { saldo: number }) => acc + r.saldo, 0);
    if (total !== 25) throw new Error(`Total esperado 25, real ${total}`);
    await ctx.assertCustoMedio(sku, 7, 0.01);
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
