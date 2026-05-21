import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "17 — Ajuste manual com motivo",
  descricao: "Ajuste manual com observações obrigatórias; gera mov ajuste_manual.",
  tags: ["ajuste", "manual", "movs"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("17");
    await ctx.criarProduto({ sku, descricao: "Ajuste 17" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "B-02-05", qty: 20 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // Ajuste positivo (achou 3 unidades a mais)
    await ctx.ajusteManual({ sku, galpao: "CWB", loc: "B-02-05", delta: 3, motivo: "Achado físico em recontagem" });
    // Ajuste negativo (faltam 2)
    await ctx.ajusteManual({ sku, galpao: "CWB", loc: "B-02-05", delta: -2, motivo: "Quebra inadvertida" });
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "B-02-05", 21);
    // 1 E seed + 1 E ajuste + 1 S ajuste
    await ctx.assertMovsCount(sku, 3);

    // Verifica que ambas têm observações preenchidas
    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sku).single();
    const { data: movs } = await ctx.sb.from("siso_movimentacoes")
      .select("origem_tipo, observacoes")
      .eq("produto_id", prod!.id)
      .eq("origem_tipo", "ajuste_manual");
    if ((movs ?? []).some((m: { observacoes: string | null }) => !m.observacoes)) throw new Error("ajuste manual sem observacoes");
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";

// ESM-puro: roda só se invocado direto via `tsx <arquivo.ts>`.
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  const mod = await import(import.meta.url);
  await runStandalone(mod.default);
}
