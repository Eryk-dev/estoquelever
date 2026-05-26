import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "45 — PATCH modo_contagem em sessão em_andamento falha 409",
  descricao:
    "Sessão de inventário em status='em_andamento' não aceita PATCH de " +
    "modo_contagem (blind ↔ aberto) — alteração mid-flow corromperia a " +
    "semântica das contagens já registradas. Backend deve retornar 409. " +
    "(Coordinate-with-P3: guard adicionado em pickPatchFields.)",
  tags: ["inventario", "patch", "guard", "modo"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("45");
    await ctx.criarProduto({ sku, descricao: "Patch guard 45" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-45", qty: 5 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1. Cria sessão (cria + inicia → em_andamento) em modo 'blind'
    const sess = await ctx.criarSessaoInventario({
      galpao: "CWB",
      locs: ["A-01-45"],
      modo: "blind",
      tipo: "cycle_count",
    });

    // 2. Confirma estado em_andamento
    const { data: before } = await ctx.sb
      .from("siso_inventario_sessoes")
      .select("status, modo_contagem")
      .eq("id", sess.id)
      .single();
    const beforeRow = before as { status: string; modo_contagem: string } | null;
    if (!beforeRow || beforeRow.status !== "em_andamento") {
      throw new Error(
        `pré-condição falhou: sessão deveria estar em_andamento, está ${beforeRow?.status}`,
      );
    }

    // 3. Tenta PATCH modo_contagem → deve retornar 409
    let erro: Error | null = null;
    try {
      await ctx.http.patch(`/api/wms/inventario/${sess.id}`, {
        modo_contagem: "aberto",
      });
    } catch (e) {
      erro = e as Error;
    }

    if (!erro) {
      throw new Error(
        "PATCH modo_contagem em sessão em_andamento deveria ter falhado com 409",
      );
    }
    if (!/409/.test(erro.message)) {
      throw new Error(
        `PATCH falhou mas status inesperado (esperava 409): ${erro.message}`,
      );
    }

    // Suprime warning do parâmetro
    void sku;
  },

  assertEsperado: async (ctx, { sku }) => {
    // modo_contagem permanece 'blind' (PATCH foi rejeitado)
    const { data: after } = await ctx.sb
      .from("siso_inventario_sessoes")
      .select("modo_contagem, status")
      .order("criado_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    const afterRow = after as { modo_contagem: string; status: string } | null;
    if (!afterRow) {
      throw new Error("sessão sumiu");
    }
    if (afterRow.modo_contagem !== "blind") {
      throw new Error(
        `modo_contagem mudou apesar do 409: esperava 'blind', achou '${afterRow.modo_contagem}'`,
      );
    }
    void sku;
  },
} satisfies Cenario<{ sku: string }>;

import { runStandalone } from "../_harness/standalone";

// ESM-puro: roda só se invocado direto via `tsx <arquivo.ts>`.
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
