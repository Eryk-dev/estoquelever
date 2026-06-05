import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
const PEDIDO_ID = `DESF-BIP-${Math.random().toString(36).slice(2, 8)}`;
const PRODUTO_TINY = 999003;

beforeAll(async () => {
  // siso_pedidos: numero/data/filial_origem/cliente_nome são NOT NULL (legado);
  // filial_origem é enum siso_filial (CWB|SP) — fixtures diretos os incluem.
  await sb.from("siso_pedidos").insert({
    id: PEDIDO_ID,
    numero: PEDIDO_ID,
    data: new Date().toISOString(),
    filial_origem: "CWB",
    cliente_nome: "Teste desfazer bip atomico",
    status: "executando",
  });
  // siso_pedido_itens: sku/descricao NOT NULL — incluir no insert direto.
  await sb.from("siso_pedido_itens").insert({
    pedido_id: PEDIDO_ID,
    produto_id: PRODUTO_TINY,
    sku: `DESF-BIP-SKU-${Math.random().toString(36).slice(2, 8)}`,
    descricao: "Desfazer bip atomico",
    quantidade_pedida: 5,
    quantidade_bipada: 3,
    bipado_completo: false,
  });
});

describe("wms_desfazer_bip_atomico", () => {
  it("dois desfazer concorrentes decrementam exatamente 1 cada (3 → 1)", async () => {
    await Promise.all([
      sb.rpc("wms_desfazer_bip_atomico", { p_pedido_id: PEDIDO_ID, p_produto_id: PRODUTO_TINY }),
      sb.rpc("wms_desfazer_bip_atomico", { p_pedido_id: PEDIDO_ID, p_produto_id: PRODUTO_TINY }),
    ]);
    const { data: item } = await sb
      .from("siso_pedido_itens")
      .select("quantidade_bipada")
      .eq("pedido_id", PEDIDO_ID)
      .eq("produto_id", PRODUTO_TINY)
      .single();
    expect(Number(item?.quantidade_bipada)).toBe(1);
  });

  it("não desce abaixo de 0 (clamp)", async () => {
    // de 1 → 0 → 0 (segunda chamada não muda)
    await sb.rpc("wms_desfazer_bip_atomico", { p_pedido_id: PEDIDO_ID, p_produto_id: PRODUTO_TINY });
    await sb.rpc("wms_desfazer_bip_atomico", { p_pedido_id: PEDIDO_ID, p_produto_id: PRODUTO_TINY });
    const { data: item } = await sb
      .from("siso_pedido_itens")
      .select("quantidade_bipada")
      .eq("pedido_id", PEDIDO_ID)
      .eq("produto_id", PRODUTO_TINY)
      .single();
    expect(Number(item?.quantidade_bipada)).toBe(0);
  });
});
