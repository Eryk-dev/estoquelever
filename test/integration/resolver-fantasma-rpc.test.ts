import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, empresaId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
});

// Cada cenário usa produto próprio pra isolar o saldo (os dois testes
// compartilham galpão/loc, então sem produto distinto o estoque vazaria entre eles).
async function pedidoComReservaViva(pedidoId: string, qty: number, statusSep: string): Promise<string> {
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-FANT-${pedidoId}-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  const prodId = p!.id as string;
  // siso_pedidos tem NOT-NULL em numero/data/filial_origem/cliente_nome além de id.
  await sb.from("siso_pedidos").insert({
    id: pedidoId,
    numero: pedidoId,
    data: new Date().toISOString().slice(0, 10),
    filial_origem: "CWB",
    cliente_nome: "Teste Fantasma",
    status: "executando",
    status_separacao: statusSep,
  });
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: qty + 5, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
  const expira = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "R", p_quantidade: qty, p_origem_tipo: "reserva_pedido", p_origem_id: pedidoId,
    p_expira_em: expira, p_pedido_id: pedidoId, p_motivo: "reserva",
  });
  return prodId;
}

describe("wms_resolver_pedido_fantasma", () => {
  it("acao='saiu': converte R→L+S (reservado zera, saldo baixa)", async () => {
    const pedidoId = "730000001";
    const prodId = await pedidoComReservaViva(pedidoId, 4, "embalado");
    const { error } = await sb.rpc("wms_resolver_pedido_fantasma", {
      p_pedido_id: pedidoId, p_acao: "saiu", p_empresa_vendedora_id: empresaId, p_usuario_id: null,
    });
    expect(error).toBeNull();
    const { data: est } = await sb.from("siso_estoque").select("saldo, reservado")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.reservado)).toBe(0);
    expect(Number(est?.saldo)).toBe(5); // 9 - 4
  });

  it("acao='cancelado': devolve à prateleira (R→L, reservado zera, saldo intacto)", async () => {
    const pedidoId = "730000002";
    const prodId = await pedidoComReservaViva(pedidoId, 3, "separado");
    const { error } = await sb.rpc("wms_resolver_pedido_fantasma", {
      p_pedido_id: pedidoId, p_acao: "cancelado", p_empresa_vendedora_id: empresaId, p_usuario_id: null,
    });
    expect(error).toBeNull();
    const { data: est } = await sb.from("siso_estoque").select("saldo, reservado")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.reservado)).toBe(0);
    expect(Number(est?.saldo)).toBe(8); // 8 - 0 (não saiu)
  });
});
