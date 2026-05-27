import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "38 — Pendência guarda carrega criada_por + guardada_por",
  descricao:
    "Receber 5; pendência nasce com criada_por populado e guardada_por NULL. Após confirmar, guardada_por = usuário que confirmou.",
  tags: ["guarda", "auditoria", "criada_por"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("38");
    await ctx.criarProduto({ sku, descricao: "Auditoria criada_por 38" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const res = await ctx.receber({
      galpao: "CWB",
      items: [{ sku, qty: 5 }],
    });
    const pendId = res.pendencias[0];

    // Verifica criada_por populado e guardada_por ainda null logo após criar.
    const { data: p1, error: e1 } = await ctx.sb
      .from("siso_wms_pendencias_guarda")
      .select("criada_por, guardada_por")
      .eq("id", pendId)
      .single();
    if (e1) throw e1;
    if (!p1?.criada_por) {
      throw new Error("criada_por deveria estar populado após criarPendencia");
    }
    if (p1.guardada_por) {
      throw new Error("guardada_por deveria ser NULL antes da guarda");
    }

    // Confirma guarda integral.
    await ctx.guardar({
      pendencia_id: pendId,
      loc_destino: "A-01-08",
      qty: 5,
    });
    await ctx.aguardarPendenciaGuarda(pendId, "guardada");

    // Verifica guardada_por populado após confirmação.
    const { data: p2, error: e2 } = await ctx.sb
      .from("siso_wms_pendencias_guarda")
      .select("guardada_por")
      .eq("id", pendId)
      .single();
    if (e2) throw e2;
    if (!p2?.guardada_por) {
      throw new Error(
        "guardada_por deveria estar populado após confirmar guarda",
      );
    }
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-08", 5);
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 0);
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
