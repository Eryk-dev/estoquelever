import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 84 — [P029] guarda valida produto bipado (cross-check produto↔loc).
 *
 * `criarLocalizacao` retorna o ID da loc (não o código), então guardamos o id
 * direto em setup.locId. `ctx.receber({items,galpao})` devolve { pendencias:
 * string[] } com os ids das pendências de guarda criadas.
 */
type Setup = {
  skuCerto: string;
  gtinErrado: string;
  locId: string;
  pendenciaId: string;
};

export default {
  nome: "84 — [P029] guarda rejeita GTIN de produto diferente; aceita correto/manual",
  descricao: "Cross-check produto bipado na confirmação de guarda + escape-hatch manual.",
  tags: ["guarda", "putaway", "cross-check", "P029"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const skuCerto = ctx.skuUnico("84C");
    const skuErrado = ctx.skuUnico("84E");
    const gtinErrado = `789${Math.floor(Math.random() * 1e10)}`;
    await ctx.criarProduto({ sku: skuCerto, descricao: "guarda certo 84" });
    // Produto diferente, com GTIN próprio — bipá-lo na pendência do skuCerto
    // deve falhar o cross-check.
    await ctx.criarProduto({ sku: skuErrado, descricao: "guarda errado 84", gtin: gtinErrado });
    const locId = await ctx.criarLocalizacao({ galpao: "CWB", codigo: "GUARDA84-01", tipo: "picking" });
    return { skuCerto, gtinErrado, locId, pendenciaId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { pendencias } = await ctx.receber({ items: [{ sku: setup.skuCerto, qty: 4 }], galpao: "CWB" });
    setup.pendenciaId = pendencias[0];
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const locId = setup.locId;

    // 1) GTIN de produto ERRADO → 400, sem mov
    let status = 0;
    try {
      await ctx.http.post(`/api/wms/guarda/${setup.pendenciaId}/confirmar`, {
        qty: 4,
        localizacao_destino_id: locId,
        gtin_bipado: setup.gtinErrado,
      });
    } catch (e) {
      const m = String(e instanceof Error ? e.message : e);
      const mm = m.match(/HTTP (\d+)/);
      status = mm ? Number(mm[1]) : 0;
      if (!/produto bipado não bate|gtin|sku/i.test(m)) {
        throw new Error(`mensagem não cita o cross-check: ${m}`);
      }
    }
    if (status !== 400) throw new Error(`esperava 400 com GTIN errado, recebeu ${status}`);

    // 2) confirmar_manual=true (escape-hatch) → confirma
    await ctx.http.post(`/api/wms/guarda/${setup.pendenciaId}/confirmar`, {
      qty: 4,
      localizacao_destino_id: locId,
      confirmar_manual: true,
    });
    const { data: pend } = await ctx.sb
      .from("siso_wms_pendencias_guarda")
      .select("status")
      .eq("id", setup.pendenciaId)
      .single();
    if ((pend as { status: string }).status !== "guardada") {
      throw new Error(`confirmar_manual não guardou a pendência (status ${(pend as { status: string }).status})`);
    }
  },
} satisfies Cenario<Setup>;

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
