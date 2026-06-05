import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 82 — desfazer-bip concorrente decrementa exatamente 1 cada.
 *
 * Dois POSTs concorrentes em /api/wms/separacao/desfazer-bip com o MESMO
 * (pedido_id, produto_id). Com read-modify-write ambos lêem 3 e gravam 2
 * (FAIL). Com a RPC wms_desfazer_bip_atomico cada um decrementa atômico → 1.
 *
 * Gateia a mudança de produção da ROTA (read-modify-write → RPC), não só a RPC.
 */

type Setup = { pedidoId: string; produtoTiny: number; galpaoId: string };

export default {
  nome: "82 — desfazer-bip concorrente decrementa exatamente 1 cada (3 → 1)",
  descricao:
    "Dois POSTs concorrentes em /api/wms/separacao/desfazer-bip com o mesmo " +
    "(pedido_id, produto_id), item bipada=3/5. Esperado quantidade_bipada=1 " +
    "(read-modify-write deixaria 2).",
  tags: ["separacao", "desfazer-bip", "concorrencia", "P021"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const galpaoId = ctx.staging.galpoes.cwb.id;
    const produtoTiny = 999004;
    // siso_pedidos: numero/data/filial_origem/cliente_nome são NOT NULL (legado);
    // filial_origem é enum siso_filial (CWB|SP) — incluir no insert direto.
    // separacao_galpao_id = CWB pra a rota validar ownership contra X-Galpao-Id.
    const pedidoId = `DESF-BIP-E2E-${Math.random().toString(36).slice(2, 8)}`;
    await ctx.sb.from("siso_pedidos").insert({
      id: pedidoId,
      numero: pedidoId,
      data: new Date().toISOString(),
      filial_origem: "CWB",
      cliente_nome: "Teste desfazer bip concorrente",
      status: "executando",
      status_separacao: "em_separacao",
      separacao_galpao_id: galpaoId,
    });
    // siso_pedido_itens: sku/descricao NOT NULL — incluir no insert direto.
    await ctx.sb.from("siso_pedido_itens").insert({
      pedido_id: pedidoId,
      produto_id: produtoTiny,
      sku: `DESF-BIP-E2E-SKU-${Math.random().toString(36).slice(2, 8)}`,
      descricao: "Desfazer bip concorrente",
      quantidade_pedida: 5,
      quantidade_bipada: 3,
      bipado_completo: false,
    });
    return { pedidoId, produtoTiny, galpaoId };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const body = { pedido_id: setup.pedidoId, produto_id: setup.produtoTiny };
    // X-Galpao-Id = CWB → session.galpaoId casa com separacao_galpao_id (ownership OK).
    const headers = { "X-Galpao-Id": setup.galpaoId };
    await Promise.all([
      ctx.http.post("/api/wms/separacao/desfazer-bip", body, headers),
      ctx.http.post("/api/wms/separacao/desfazer-bip", body, headers),
    ]);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .select("quantidade_bipada")
      .eq("pedido_id", setup.pedidoId)
      .eq("produto_id", setup.produtoTiny)
      .single();
    const v = Number((item as { quantidade_bipada: number } | null)?.quantidade_bipada);
    if (v !== 1) {
      throw new Error(
        `desfazer-bip concorrente: quantidade_bipada deveria ser 1 (3 - 2), foi ${v} ` +
          `(read-modify-write deixaria 2 — lost decrement).`,
      );
    }
  },
} satisfies Cenario<Setup>;

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
