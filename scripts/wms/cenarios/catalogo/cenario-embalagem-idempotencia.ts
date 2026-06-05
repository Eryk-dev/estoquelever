import type { Cenario, Ctx } from "../_harness/types";
import { randomUUID } from "node:crypto";

/**
 * Cenário — idempotência da confirmação de item de embalagem.
 * Dois POSTs com o MESMO client_request_id em <60s não devem somar 2x.
 */
type Setup = { sku: string; itemId: number };

export default {
  nome: "embalagem-idempotencia — dois cliques com mesmo client_request_id contam 1x",
  descricao:
    "POST /api/wms/separacao/confirmar-item-embalagem duas vezes com o mesmo " +
    "client_request_id (delta=+1, item bipada=10 de 12) → quantidade_bipada=11, não 12.",
  tags: ["embalagem", "idempotencia", "confirmar-item", "P129", "P131"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("emb-idem");
    await ctx.criarProduto({ sku, descricao: "Embalagem idempotencia" });
    return { sku, itemId: 0 };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    // Monta um item de pedido em estado 'separado' com bipada=10 de 12.
    // 10+1=11 < 12 → o item NÃO completa: o pedido segue 'separado' e a SEGUNDA
    // chamada (sequencial) continua passando o guard de status da rota. Sem dedup
    // ficaria 12 (= completo); com dedup fica 11.
    // siso_pedidos: numero/data/filial_origem/cliente_nome são NOT NULL (legado);
    // filial_origem é enum siso_filial (CWB|SP). siso_pedido_itens: sku/descricao
    // são NOT NULL e há UNIQUE(pedido_id, produto_id). id de pedido gerado local.
    const pedidoId = `EMB-${Math.random().toString(36).slice(2, 8)}`;
    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .insert({
        id: pedidoId, numero: pedidoId, data: new Date().toISOString(),
        filial_origem: "CWB", cliente_nome: "Embalagem idempotencia",
        status: "executando", status_separacao: "separado",
      })
      .select("id").single();
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens")
      .insert({
        pedido_id: (ped as { id: string }).id, produto_id: 999002,
        sku: setup.sku, descricao: "Embalagem idempotencia",
        quantidade_pedida: 12, quantidade_bipada: 10, bipado_completo: false,
      })
      .select("id").single();
    setup.itemId = (item as { id: number }).id;

    const reqId = randomUUID();
    // pedido_item_id como string do bigint do item (a rota faz .eq('id', pedido_item_id);
    // o supabase-js coerce a string pro bigint da coluna). client_request_id por clique.
    const body = {
      pedido_item_id: String(setup.itemId),
      quantidade: 1,
      client_request_id: reqId,
    };
    await ctx.http.post("/api/wms/separacao/confirmar-item-embalagem", body);
    await ctx.http.post("/api/wms/separacao/confirmar-item-embalagem", body);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { data: item } = await ctx.sb
      .from("siso_pedido_itens").select("quantidade_bipada").eq("id", setup.itemId).single();
    const v = Number((item as { quantidade_bipada: number } | null)?.quantidade_bipada);
    if (v !== 11) {
      throw new Error(
        `quantidade_bipada deveria ser 11 (dois cliques com mesmo client_request_id = 1×), foi ${v}.`,
      );
    }
  },
} satisfies Cenario<Setup>;
