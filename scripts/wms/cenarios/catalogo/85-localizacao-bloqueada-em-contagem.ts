import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 85 — [P113] loc em contagem ativa não pode trocar tipo nem desativar.
 *
 * criarSessaoInventario chama /iniciar, que cria o lock ATIVO em
 * siso_localizacao_locks (finalizado_em IS NULL) pras locs da sessão. Com o lock
 * vivo, PATCH de tipo e DELETE da loc devem retornar 409 citando contagem.
 */
type Setup = { sku: string; loc: string; sessaoId: string; locId: string };

export default {
  nome: "85 — [P113] loc em contagem ativa bloqueia PATCH tipo / DELETE (409)",
  descricao: "Lock de contagem ativa impede alterar tipo/desativar a localização.",
  tags: ["localizacoes", "inventario", "lock", "P113"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("85");
    await ctx.criarProduto({ sku, descricao: "loc lock 85" });
    const loc = "LOCK85-01";
    await ctx.criarLocalizacao({ galpao: "CWB", codigo: loc, tipo: "picking" });
    // siso_localizacoes é CATÁLOGO (não truncado entre runs): garante baseline
    // tipo=picking/ativo=true mesmo se uma run anterior tiver poluído a row.
    await ctx.sb.from("siso_localizacoes").update({ tipo: "picking", ativo: true }).eq("codigo", loc);
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc, qty: 3 });
    const { id: sessaoId } = await ctx.criarSessaoInventario({ galpao: "CWB", locs: [loc], modo: "aberto" });
    return { sku, loc, sessaoId, locId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: locRow } = await ctx.sb.from("siso_localizacoes").select("id").eq("codigo", setup.loc).single();
    setup.locId = (locRow as { id: string }).id;

    // Precondição do guard: lock ATIVO na loc (criado pelo /iniciar da sessão).
    const { data: lock } = await ctx.sb
      .from("siso_localizacao_locks")
      .select("id")
      .eq("localizacao_id", setup.locId)
      .is("finalizado_em", null)
      .limit(1);
    if (!lock || lock.length === 0) {
      throw new Error("precondição falhou: nenhum lock de contagem ativo na loc");
    }
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // PATCH tipo → 409
    let patchStatus = 0;
    try {
      await ctx.http.patch(`/api/wms/localizacoes/${setup.locId}`, { tipo: "quarentena" });
    } catch (e) {
      const m = String(e instanceof Error ? e.message : e);
      patchStatus = Number((m.match(/HTTP (\d+)/) ?? [])[1] ?? 0);
      if (!/contagem/i.test(m)) throw new Error(`PATCH não cita contagem: ${m}`);
    }
    if (patchStatus !== 409) throw new Error(`PATCH tipo esperava 409, recebeu ${patchStatus}`);
    const { data: l1 } = await ctx.sb.from("siso_localizacoes").select("tipo").eq("id", setup.locId).single();
    if ((l1 as { tipo: string }).tipo !== "picking") throw new Error("tipo mudou apesar do lock");

    // DELETE → 409
    let delStatus = 0;
    try {
      await ctx.http.delete(`/api/wms/localizacoes/${setup.locId}`);
    } catch (e) {
      const m = String(e instanceof Error ? e.message : e);
      delStatus = Number((m.match(/HTTP (\d+)/) ?? [])[1] ?? 0);
    }
    if (delStatus !== 409) throw new Error(`DELETE esperava 409, recebeu ${delStatus}`);
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => { try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; } })();
if (_isMain) { void (async () => { const mod = await import(import.meta.url); await runStandalone(mod.default); })(); }
