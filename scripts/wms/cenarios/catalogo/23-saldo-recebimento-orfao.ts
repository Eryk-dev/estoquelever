import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "23 — Saldo recebimento órfão detectado após cancelar pendência",
  descricao:
    "Recebe 7 no dock CWB, cancela a pendência sem mover o saldo (saldo fica fantasma em RECEBIMENTO) e confirma que GET /api/wms/saldo-recebimento-orfao retorna o item com saldo=7.",
  tags: ["recebimento", "guarda", "saldo-fantasma", "p6", "p5"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("23");
    await ctx.criarProduto({ sku, descricao: "Saldo órfão recebimento 23" });

    // Receber 7 no dock CWB — gera 1 pendência em RECEBIMENTO.
    const rec = await ctx.receber({ galpao: "CWB", items: [{ sku, qty: 7 }] });
    const pendId = rec.pendencias[0];
    if (!pendId) throw new Error("setup: pendência não criada pelo receber");

    // Cancela a pendência (não mexe no estoque — saldo fica fantasma na loc).
    await ctx.http.post(`/api/wms/guarda/${pendId}/cancelar`, {
      motivo: "teste cenário 23",
    });

    // Sanity: saldo de 7 deve estar parado em RECEBIMENTO no CWB.
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 7);

    return { sku, pendId };
  },

  run: async (ctx, { sku }) => {
    const galpaoCwbId = ctx.staging.galpoes.cwb.id;

    type ItemOrfao = {
      produto_id: string;
      sku: string;
      descricao: string;
      galpao_id: string;
      localizacao_id: string;
      localizacao_codigo: string;
      saldo: number;
      pendente_total: number;
      orfao: number;
    };

    const res = await ctx.http.get<{ itens: ItemOrfao[] }>(
      `/api/wms/saldo-recebimento-orfao?galpao_id=${galpaoCwbId}`,
    );

    if (!res || !Array.isArray(res.itens)) {
      throw new Error(`resposta inesperada: ${JSON.stringify(res)}`);
    }
    if (res.itens.length === 0) {
      throw new Error("esperava ≥1 saldo órfão, recebeu lista vazia");
    }

    const meu = res.itens.find((i) => i.sku === sku);
    if (!meu) {
      throw new Error(`esperava item órfão pro SKU ${sku} na resposta`);
    }
    if (Number(meu.saldo) !== 7) {
      throw new Error(`saldo=${meu.saldo}, esperado 7`);
    }
    if (Number(meu.orfao) !== 7) {
      throw new Error(`orfao=${meu.orfao}, esperado 7 (sem pendência ativa)`);
    }
    if (Number(meu.pendente_total) !== 0) {
      throw new Error(
        `pendente_total=${meu.pendente_total}, esperado 0 (pendência foi cancelada)`,
      );
    }
    if (meu.galpao_id !== galpaoCwbId) {
      throw new Error(`galpao_id divergente: ${meu.galpao_id} ≠ ${galpaoCwbId}`);
    }
    if (meu.localizacao_codigo !== "RECEBIMENTO") {
      throw new Error(
        `localizacao_codigo=${meu.localizacao_codigo}, esperado RECEBIMENTO`,
      );
    }
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo continua parado em RECEBIMENTO (endpoint é read-only).
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 7);
  },
} satisfies Cenario<{ sku: string; pendId: string }>;

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
