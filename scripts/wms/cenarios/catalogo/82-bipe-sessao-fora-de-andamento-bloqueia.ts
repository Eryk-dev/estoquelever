import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 82 — [P058] Bipe rejeitado quando a sessão saiu de em_andamento.
 *
 * Operador entra numa loc, a sessão é movida pra 'revisao' (via computar/finalizar),
 * mas a loc fica com lock órfão (status != contada/aprovada). Tentar bipar deve
 * retornar 409 citando que a sessão já saiu da fase em andamento.
 */
type Setup = { sku: string; loc: string; sessaoId: string; locId: string };

export default {
  nome: "82 — [P058] bipe em sessão fora de em_andamento é bloqueado (409)",
  descricao:
    "Sessão movida pra 'revisao' com loc de lock órfão: POST contagens deve dar 409.",
  tags: ["inventario", "guard", "sessao", "P058"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("82");
    await ctx.criarProduto({ sku, descricao: "Guard sessão 82" });
    const loc = "INV82-01";
    await ctx.criarLocalizacao({ galpao: "CWB", codigo: loc, tipo: "picking" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc, qty: 5 });
    const { id: sessaoId } = await ctx.criarSessaoInventario({ galpao: "CWB", locs: [loc], modo: "aberto" });
    return { sku, loc, sessaoId, locId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    await ctx.entrarParty(setup.sessaoId);
    // proxima-loc retorna o id físico da loc em `loc_id` (não `localizacao_id`,
    // que é o nome no type frouxo do harness). Usa o id real pra montar o body.
    const prox = (await ctx.proximaLoc(setup.sessaoId)) as { loc_id?: string };
    setup.locId = String(prox.loc_id);

    // Força a sessão pra 'revisao' SEM finalizar a loc → loc fica com lock órfão
    // (status 'em_contagem'), sessão != em_andamento.
    await ctx.sb
      .from("siso_inventario_sessoes")
      .update({ status: "revisao" })
      .eq("id", setup.sessaoId);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: prod } = await ctx.sb
      .from("siso_produtos").select("id").eq("sku", setup.sku).single();
    let status = 0;
    try {
      await ctx.http.post(`/api/wms/inventario/${setup.sessaoId}/contagens`, {
        localizacao_id: setup.locId,
        produto_id: (prod as { id: string }).id,
        qty_contada: 5,
      });
    } catch (e) {
      const m = String(e instanceof Error ? e.message : e);
      const mm = m.match(/HTTP (\d+)/);
      status = mm ? Number(mm[1]) : 0;
      if (!/em andamento|saiu da fase/i.test(m)) {
        throw new Error(`mensagem não cita a fase da sessão: ${m}`);
      }
    }
    if (status !== 409) {
      throw new Error(`esperava 409, recebeu ${status} — guard de sessão ausente`);
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; }
})();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
