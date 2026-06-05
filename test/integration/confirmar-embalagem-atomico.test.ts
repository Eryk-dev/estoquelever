import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
const PEDIDO_ID = `EMB-ATOM-${Math.random().toString(36).slice(2, 8)}`;

// UNIQUE(pedido_id, produto_id) em siso_pedido_itens (idx_siso_pedido_itens_pedido_produto)
// → cada item de teste precisa de um produto_id distinto.
let seqProduto = 999001;

async function novoItem(qtdPedida: number): Promise<number> {
  const { data, error } = await sb
    .from("siso_pedido_itens")
    .insert({
      pedido_id: PEDIDO_ID,
      produto_id: seqProduto++,
      sku: `EMB-ATOM-SKU-${Math.random().toString(36).slice(2, 8)}`,
      descricao: "Embalagem atomico",
      quantidade_pedida: qtdPedida,
      quantidade_bipada: 0,
      bipado_completo: false,
    })
    .select("id")
    .single();
  if (error) throw new Error(`novoItem falhou: ${error.message}`);
  return data!.id as number;
}

beforeAll(async () => {
  // siso_pedidos: numero/data/filial_origem/cliente_nome são NOT NULL (legado);
  // filial_origem é enum siso_filial (CWB|SP) — fixtures diretos os incluem.
  // siso_pedido_itens tem FK pedido_id -> siso_pedidos.id, então o pai precisa existir.
  const { error } = await sb.from("siso_pedidos").insert({
    id: PEDIDO_ID,
    numero: PEDIDO_ID,
    data: new Date().toISOString(),
    filial_origem: "CWB",
    cliente_nome: "Teste embalagem atomico",
    status: "executando",
  });
  if (error) throw new Error(`beforeAll pedido insert falhou: ${error.message}`);
});

describe("wms_confirmar_item_embalagem_atomico", () => {
  it("soma atômica: dois incrementos concorrentes não perdem nenhum (+3 e +2 → 5)", async () => {
    const itemId = await novoItem(10);
    await Promise.all([
      sb.rpc("wms_confirmar_item_embalagem_atomico", {
        p_item_id: itemId, p_delta: 3, p_client_request_id: randomUUID(),
      }),
      sb.rpc("wms_confirmar_item_embalagem_atomico", {
        p_item_id: itemId, p_delta: 2, p_client_request_id: randomUUID(),
      }),
    ]);
    const { data: item } = await sb
      .from("siso_pedido_itens").select("quantidade_bipada").eq("id", itemId).single();
    expect(Number(item?.quantidade_bipada)).toBe(5);
  });

  it("dedup: mesmo client_request_id em 2 chamadas não reaplica o delta", async () => {
    const itemId = await novoItem(11);
    await sb.rpc("wms_confirmar_item_embalagem_atomico", {
      p_item_id: itemId, p_delta: 10, p_client_request_id: randomUUID(),
    });
    const reqId = randomUUID();
    const r1 = await sb.rpc("wms_confirmar_item_embalagem_atomico", {
      p_item_id: itemId, p_delta: 1, p_client_request_id: reqId,
    });
    const r2 = await sb.rpc("wms_confirmar_item_embalagem_atomico", {
      p_item_id: itemId, p_delta: 1, p_client_request_id: reqId,
    });
    const { data: item } = await sb
      .from("siso_pedido_itens").select("quantidade_bipada").eq("id", itemId).single();
    expect(Number(item?.quantidade_bipada)).toBe(11); // não 12
    // ambas as chamadas retornam o mesmo estado final
    expect(Number((r1.data as any)?.quantidade_bipada)).toBe(11);
    expect(Number((r2.data as any)?.quantidade_bipada)).toBe(11);
  });

  it("clamp >=0: delta negativo não deixa negativo", async () => {
    const itemId = await novoItem(5);
    await sb.rpc("wms_confirmar_item_embalagem_atomico", {
      p_item_id: itemId, p_delta: -3, p_client_request_id: randomUUID(),
    });
    const { data: item } = await sb
      .from("siso_pedido_itens").select("quantidade_bipada").eq("id", itemId).single();
    expect(Number(item?.quantidade_bipada)).toBe(0);
  });
});
