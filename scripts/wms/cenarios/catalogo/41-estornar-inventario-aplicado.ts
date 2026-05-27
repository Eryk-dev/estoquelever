import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "41 — Estornar sessão inventário aplicada recoloca divergências pendentes",
  descricao:
    "Após aplicar sessão com 1 divergência E (ganho de 2), chamar /estornar reverte a mov no ledger, divergência volta pra status='pendente', sessão volta pra 'revisao'. 2ª chamada é idempotente (retorna 400 porque status != 'aplicada').",
  tags: ["p3", "inventario", "reverse"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("41");
    await ctx.criarProduto({ sku, descricao: "P3-41 estorno inventário" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-02", qty: 5 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // Cria sessão, bipa qty=7 (esperava 5 → divergência E +2), aprova divergência,
    // fecha sessão, aplica. Saldo final = 7.
    const sess = await ctx.criarSessaoInventario({
      galpao: "CWB",
      locs: ["A-01-02"],
      modo: "blind",
      tipo: "cycle_count",
    });
    await ctx.entrarParty(sess.id);
    await ctx.proximaLoc(sess.id);
    await ctx.bipeInventario({ sessao_id: sess.id, sku, loc: "A-01-02", qty: 7 });
    await ctx.finalizarLocInventario({ sessao_id: sess.id, loc: "A-01-02" });
    await ctx.aprovarInventario(sess.id);

    // Aprova divergência pendente antes de fechar a sessão.
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
    await ctx.aplicarInventario(sess.id);

    // Saldo agora é 7 (5 inicial + 2 do ganho).
    await ctx.assertSaldo(sku, "CWB", "A-01-02", 7);

    // Estorna a sessão.
    const r = await ctx.estornarInventario(sess.id, "teste cenário 41");
    ctx.log("estornar-resultado", { ...r });
    if (r.movsEstornadas !== 1) {
      throw new Error(`esperava 1 mov estornada, achou ${r.movsEstornadas}`);
    }

    // Idempotência: 2ª chamada deve falhar com 400 (status != 'aplicada').
    let erro2: Error | null = null;
    try {
      await ctx.estornarInventario(sess.id, "teste cenário 41 - 2ª chamada");
    } catch (e) {
      erro2 = e as Error;
    }
    if (!erro2) {
      throw new Error("2ª chamada de /estornar deveria ter falhado mas não falhou");
    }
    if (!/400/.test(erro2.message)) {
      throw new Error(`2ª /estornar falhou mas não com 400: ${erro2.message}`);
    }
    if (!/apenas 'aplicada'/.test(erro2.message)) {
      throw new Error(
        `2ª /estornar falhou com 400 mas sem mensagem esperada: ${erro2.message}`,
      );
    }
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo volta pra 5 (estorno cria S contra-mov, anulando o +2).
    await ctx.assertSaldo(sku, "CWB", "A-01-02", 5);

    // Localiza a sessão criada via produto_id → contagens.
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
    if (!sessaoId) throw new Error("assert: não achou sessao_id via contagens");

    // Sessão deve estar em 'revisao' (não 'aplicada' nem 'cancelada').
    const { data: s } = await ctx.sb
      .from("siso_inventario_sessoes")
      .select("status, aplicada_em")
      .eq("id", sessaoId)
      .maybeSingle();
    const sessRow = s as { status?: string; aplicada_em?: string | null } | null;
    if (sessRow?.status !== "revisao") {
      throw new Error(
        `esperava sessão.status='revisao' pós-estorno, achou '${sessRow?.status}'`,
      );
    }
    if (sessRow?.aplicada_em !== null) {
      throw new Error(
        `esperava sessão.aplicada_em=null pós-estorno, achou '${sessRow?.aplicada_em}'`,
      );
    }

    // Divergência deve estar de volta em status='pendente' com mov_aplicada_id=null.
    const { data: divs } = await ctx.sb
      .from("siso_inventario_divergencias")
      .select("status, mov_aplicada_id")
      .eq("sessao_id", sessaoId);
    const divsRows = (divs ?? []) as Array<{
      status: string;
      mov_aplicada_id: string | null;
    }>;
    const found = divsRows.find(
      (d) => d.status === "pendente" && d.mov_aplicada_id === null,
    );
    if (!found) {
      throw new Error(
        `nenhuma divergência voltou pra status='pendente'+mov_aplicada_id=null. Linhas: ${JSON.stringify(divsRows)}`,
      );
    }
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
