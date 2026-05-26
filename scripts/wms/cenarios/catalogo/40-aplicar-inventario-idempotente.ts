import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "40 — Aplicar inventário 2× simultâneo gera 1 conjunto de movs",
  descricao: "Sessão com 1 divergência aplicada. Duas chamadas /aplicar em paralelo devem resultar em exatamente 1 mov de inventário (UNIQUE constraint + idempotência).",
  tags: ["p3", "inventario", "idempotencia", "race"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("40");
    await ctx.criarProduto({ sku, descricao: "P3-40 idempotência aplicar" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 10 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const sess = await ctx.criarSessaoInventario({
      galpao: "CWB",
      locs: ["A-01-01"],
      modo: "blind",
      tipo: "cycle_count",
    });
    await ctx.entrarParty(sess.id);
    await ctx.proximaLoc(sess.id);
    // Conta 8 — gera divergência de -2
    await ctx.bipeInventario({ sessao_id: sess.id, sku, loc: "A-01-01", qty: 8 });
    await ctx.finalizarLocInventario({ sessao_id: sess.id, loc: "A-01-01" });
    // /aprovar computa divergências (status='pendente') → sessão fica em 'revisao'
    await ctx.aprovarInventario(sess.id);

    // Supervisor aprova a divergência pendente (PATCH /divergencias) e fecha sessão
    const { data: divs } = await ctx.sb
      .from("siso_inventario_divergencias")
      .select("id, status, delta")
      .eq("sessao_id", sess.id)
      .neq("delta", 0);
    const divRows = (divs ?? []) as Array<{ id: string; status: string; delta: number }>;
    if (divRows.length === 0) throw new Error("setup: esperava 1 divergência pendente, achou 0");
    await ctx.http.patch(`/api/wms/inventario/${sess.id}/divergencias`, {
      divergencia_ids: divRows.map((d) => d.id),
      acao: "aprovar",
    });
    // Agora todas divs estão 'aprovada' → fecha sessão (revisao → aprovada)
    await ctx.http.post(`/api/wms/inventario/${sess.id}/aprovar-sessao`);

    // 2 chamadas paralelas pro endpoint /aplicar
    const [r1, r2] = await Promise.allSettled([
      ctx.http.post(`/api/wms/inventario/${sess.id}/aplicar`),
      ctx.http.post(`/api/wms/inventario/${sess.id}/aplicar`),
    ]);
    ctx.log("aplicar-idempotente", {
      r1: r1.status,
      r2: r2.status,
      r1_reason: r1.status === "rejected" ? String(r1.reason) : undefined,
      r2_reason: r2.status === "rejected" ? String(r2.reason) : undefined,
    });
    // No mínimo uma das duas tem que ter passado. Idempotência: ambas
    // podem passar (2ª é no-op) OU uma passa + 1 falha graceful.
    const okCount = [r1, r2].filter((r) => r.status === "fulfilled").length;
    if (okCount === 0) throw new Error("nenhuma chamada de aplicar passou");
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo final: 8 (10 - 2 da divergência)
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 8);
    // EXATAMENTE 1 mov de inventario_perda (não 2!)
    const { count } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id", { count: "exact", head: true })
      .eq("origem_tipo", "inventario_perda");
    if ((count ?? 0) !== 1) {
      throw new Error(`esperava 1 mov inventario_perda, achou ${count}`);
    }
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
