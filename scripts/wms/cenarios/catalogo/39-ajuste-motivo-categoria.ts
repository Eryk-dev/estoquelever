import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 39 — Ajuste manual exige `motivo_categoria` e grava no ledger.
 *
 * Antes (até 2026-05-27 D.1.4) `motivo` era texto livre — útil pra contexto
 * mas inviabilizava filtro/apuração. Solução: enum estruturado
 * `wms_motivo_categoria_enum` + obrigatoriedade no endpoint /api/wms/ajuste.
 *
 * Garante:
 *   1) POST sem `motivo_categoria` → 400.
 *   2) POST com categoria fora do enum → 400.
 *   3) POST com categoria válida → 200 + mov grava `motivo_categoria='perda'`.
 */
export default {
  nome: "39 — ajuste manual exige motivo_categoria e grava no ledger",
  descricao:
    "Endpoint /api/wms/ajuste rejeita request sem motivo_categoria, rejeita " +
    "valor fora do enum e aceita as 6 categorias válidas, gravando em " +
    "siso_movimentacoes.motivo_categoria.",
  tags: ["ajuste", "manual", "motivo_categoria", "validacao"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("39");
    await ctx.criarProduto({ sku, descricao: "Ajuste motivo_categoria 39" });
    await ctx.semearSaldo({
      produto: sku,
      galpao: "CWB",
      loc: "B-02-05",
      qty: 10,
    });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const { data: prod } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: loc } = await ctx.sb
      .from("siso_localizacoes")
      .select("id")
      .eq("galpao_id", ctx.staging.galpoes.cwb.id)
      .eq("codigo", "B-02-05")
      .single();
    const tripla = {
      produto_id: prod!.id,
      galpao_id: ctx.staging.galpoes.cwb.id,
      localizacao_id: loc!.id,
    };

    // 1) Sem motivo_categoria → erro 400.
    let resp1Status = 0;
    try {
      await ctx.http.post("/api/wms/ajuste", {
        tripla,
        qty: 1,
        direcao: "saida",
        motivo: "teste cenário 39 sem categoria",
      });
    } catch (e) {
      const msg = (e as Error).message;
      const m = /\b(\d{3})\b/.exec(msg);
      resp1Status = m ? Number(m[1]) : 0;
    }
    if (resp1Status !== 400) {
      throw new Error(
        `esperava 400 ao omitir motivo_categoria, recebi ${resp1Status}`,
      );
    }

    // 2) Categoria inválida → erro 400.
    let resp2Status = 0;
    try {
      await ctx.http.post("/api/wms/ajuste", {
        tripla,
        qty: 1,
        direcao: "saida",
        motivo: "teste cenário 39 categoria invalida",
        motivo_categoria: "categoria_que_nao_existe",
      });
    } catch (e) {
      const msg = (e as Error).message;
      const m = /\b(\d{3})\b/.exec(msg);
      resp2Status = m ? Number(m[1]) : 0;
    }
    if (resp2Status !== 400) {
      throw new Error(
        `esperava 400 com categoria inválida, recebi ${resp2Status}`,
      );
    }

    // 3) Categoria válida → 200.
    await ctx.http.post("/api/wms/ajuste", {
      tripla,
      qty: 1,
      direcao: "saida",
      motivo: "perda física - cenário 39",
      motivo_categoria: "perda",
    });
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "B-02-05", 9);

    const { data: prod } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: movs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("motivo_categoria, origem_tipo, tipo")
      .eq("produto_id", prod!.id)
      .eq("origem_tipo", "ajuste_manual")
      .order("criado_em", { ascending: false })
      .limit(1);
    const mov = (movs ?? [])[0] as
      | { motivo_categoria: string | null; origem_tipo: string; tipo: string }
      | undefined;
    if (!mov) {
      throw new Error("nenhuma mov ajuste_manual encontrada após o POST 200");
    }
    if (mov.motivo_categoria !== "perda") {
      throw new Error(
        `mov.motivo_categoria=${mov.motivo_categoria}, esperado 'perda'`,
      );
    }
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
