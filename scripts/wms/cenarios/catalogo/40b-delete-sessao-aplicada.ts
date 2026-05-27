import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "40b — DELETE sessão aplicada retorna 409 (preserva ledger)",
  descricao:
    "Sessão de inventário em status='aplicada' tem movs no ledger. Tentar DELETE deve retornar 409 com code=SESSAO_APLICADA — caso contrário cancelaria sem reverter movs, deixando saldo inconsistente.",
  tags: ["p3", "inventario", "delete", "guard"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("40b");
    await ctx.criarProduto({ sku, descricao: "P3-40b DELETE sessão aplicada" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 10 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // Cria sessão, bipe com divergência, aprova divergência, fecha sessão, aplica.
    const sess = await ctx.criarSessaoInventario({
      galpao: "CWB",
      locs: ["A-01-01"],
      modo: "blind",
      tipo: "cycle_count",
    });
    await ctx.entrarParty(sess.id);
    await ctx.proximaLoc(sess.id);
    await ctx.bipeInventario({ sessao_id: sess.id, sku, loc: "A-01-01", qty: 8 });
    await ctx.finalizarLocInventario({ sessao_id: sess.id, loc: "A-01-01" });
    await ctx.aprovarInventario(sess.id);

    // Aprova divergência pendente.
    const { data: divs } = await ctx.sb
      .from("siso_inventario_divergencias")
      .select("id, delta")
      .eq("sessao_id", sess.id)
      .neq("delta", 0);
    const divRows = (divs ?? []) as Array<{ id: string; delta: number }>;
    if (divRows.length === 0) {
      throw new Error("setup: esperava 1 divergência pendente, achou 0");
    }
    await ctx.http.patch(`/api/wms/inventario/${sess.id}/divergencias`, {
      divergencia_ids: divRows.map((d) => d.id),
      acao: "aprovar",
    });
    await ctx.http.post(`/api/wms/inventario/${sess.id}/aprovar-sessao`);

    // Aplica — sessão fica em status='aplicada' com movs no ledger.
    await ctx.aplicarInventario(sess.id);

    // Confirma status='aplicada' antes do DELETE.
    const { data: pre } = await ctx.sb
      .from("siso_inventario_sessoes")
      .select("status")
      .eq("id", sess.id)
      .maybeSingle();
    const statusPre = (pre as { status?: string } | null)?.status;
    if (statusPre !== "aplicada") {
      throw new Error(`setup: esperava status='aplicada' antes do DELETE, achou ${statusPre}`);
    }

    // Tenta DELETE — DEVE falhar com 409 + code='SESSAO_APLICADA'.
    let erro: Error | null = null;
    try {
      await ctx.http.delete(`/api/wms/inventario/${sess.id}`);
    } catch (e) {
      erro = e as Error;
    }
    if (!erro) {
      throw new Error("DELETE deveria ter falhado com 409 mas não falhou");
    }
    // HttpError formato: "DELETE /path → HTTP 409: {\"error\":...,\"code\":\"SESSAO_APLICADA\"}"
    if (!/409/.test(erro.message)) {
      throw new Error(`DELETE falhou mas não com 409: ${erro.message}`);
    }
    if (!/SESSAO_APLICADA/.test(erro.message)) {
      throw new Error(`DELETE falhou com 409 mas sem code=SESSAO_APLICADA: ${erro.message}`);
    }

    // Guarda o id pro assert.
    return { sessao_id: sess.id };
  },

  assertEsperado: async (ctx, { sku }) => {
    // Pega a sessão criada (única deste run, mesmo sku).
    const { data: prod } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: contagens } = await ctx.sb
      .from("siso_inventario_contagens")
      .select("sessao_id")
      .eq("produto_id", (prod as { id: string }).id)
      .limit(1);
    const sessaoId = ((contagens ?? [])[0] as { sessao_id?: string } | undefined)?.sessao_id;
    if (!sessaoId) throw new Error("assert: não achou sessao_id");

    // Status DEVE continuar 'aplicada' (não virou 'cancelada').
    const { data } = await ctx.sb
      .from("siso_inventario_sessoes")
      .select("status")
      .eq("id", sessaoId)
      .maybeSingle();
    const statusPos = (data as { status?: string } | null)?.status;
    if (statusPos !== "aplicada") {
      throw new Error(
        `esperava status='aplicada' (DELETE bloqueado), achou '${statusPos}' — guard #4.4 não funcionou`,
      );
    }

    // Sanity: saldo final é 8 (10 - 2 da divergência) e a mov de perda existe.
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 8);
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";
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
