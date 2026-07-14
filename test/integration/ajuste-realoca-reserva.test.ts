import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
const run = Math.random().toString(36).slice(2, 8).toUpperCase();

let galpaoId: string;
let produtoId: string;
let origemLocId: string;
let destinoLocId: string;

beforeEach(async () => {
  const { data: galpao, error: galpaoError } = await sb
    .from("siso_galpoes")
    .select("id")
    .eq("nome", "CWB")
    .single();
  expect(galpaoError).toBeNull();
  galpaoId = galpao!.id;

  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const { data: locs, error: locsError } = await sb
    .from("siso_localizacoes")
    .insert([
      { galpao_id: galpaoId, codigo: `TEST-AR-${run}-${suffix}-O`, tipo: "picking" },
      { galpao_id: galpaoId, codigo: `TEST-AR-${run}-${suffix}-D`, tipo: "picking" },
    ])
    .select("id, codigo");
  expect(locsError).toBeNull();
  origemLocId = locs!.find((l) => l.codigo.endsWith("-O"))!.id;
  destinoLocId = locs!.find((l) => l.codigo.endsWith("-D"))!.id;

  const { data: produto, error: produtoError } = await sb
    .from("siso_produtos")
    .insert({
      sku: `TEST-AJUSTE-RES-${run}-${suffix}`,
      descricao: "ajuste realoca reserva",
      ativo: true,
    })
    .select("id")
    .single();
  expect(produtoError).toBeNull();
  produtoId = produto!.id;
});

afterEach(async () => {
  if (produtoId) {
    await sb.from("siso_movimentacoes").delete().eq("produto_id", produtoId);
    await sb.from("siso_estoque").delete().eq("produto_id", produtoId);
    await sb.from("siso_produtos").delete().eq("id", produtoId);
  }
  const locIds = [origemLocId, destinoLocId].filter(Boolean);
  if (locIds.length) {
    await sb.from("siso_localizacoes").delete().in("id", locIds);
  }
});

async function entrada(localizacaoId: string, qty: number) {
  const { error } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId,
    p_galpao_id: galpaoId,
    p_localizacao_id: localizacaoId,
    p_tipo: "E",
    p_quantidade: qty,
    p_origem_tipo: "inventario_inicial",
    p_motivo: "fixture ajuste realoca reserva",
  });
  expect(error).toBeNull();
}

async function reservar(qty: number, pedidoId: string): Promise<string> {
  const { data, error } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId,
    p_galpao_id: galpaoId,
    p_localizacao_id: origemLocId,
    p_tipo: "R",
    p_quantidade: qty,
    p_origem_tipo: "reserva_pedido",
    p_origem_id: pedidoId,
    p_pedido_id: pedidoId,
    p_expira_em: new Date(Date.now() + 86_400_000).toISOString(),
    p_motivo: "fixture reserva",
  });
  expect(error).toBeNull();
  return data as string;
}

async function ajustarSaida(qty: number) {
  return sb.rpc("wms_ajustar_estoque_realocando_reservas", {
    p_produto_id: produtoId,
    p_galpao_id: galpaoId,
    p_localizacao_id: origemLocId,
    p_quantidade: qty,
    p_direcao: "saida",
    p_motivo: "contagem real da posição",
    p_motivo_categoria: "correcao_inventario",
    p_usuario_id: null,
    p_localizacoes_saida: [origemLocId],
  });
}

describe("wms_ajustar_estoque_realocando_reservas", () => {
  it("move a reserva inteira para outra loc antes de zerar a origem", async () => {
    await entrada(origemLocId, 23);
    await entrada(destinoLocId, 38);
    const pedidoId = `FULL-TEST-${crypto.randomUUID()}`;
    const reservaOriginalId = await reservar(23, pedidoId);

    const { data, error } = await ajustarSaida(23);
    expect(error).toBeNull();
    expect(data).toMatchObject({
      reservas_realocadas: 1,
      quantidade_realocada: 23,
    });

    const { data: estoque } = await sb
      .from("siso_estoque")
      .select("localizacao_id, saldo, reservado")
      .eq("produto_id", produtoId);
    const origem = estoque!.find((e) => e.localizacao_id === origemLocId)!;
    const destino = estoque!.find((e) => e.localizacao_id === destinoLocId)!;
    expect({ saldo: Number(origem.saldo), reservado: Number(origem.reservado) }).toEqual({
      saldo: 0,
      reservado: 0,
    });
    expect({ saldo: Number(destino.saldo), reservado: Number(destino.reservado) }).toEqual({
      saldo: 38,
      reservado: 23,
    });

    const { data: liberacao } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("tipo", "L")
      .eq("estorno_de", reservaOriginalId)
      .single();
    expect(liberacao).toBeTruthy();

    const { data: novaReserva } = await sb
      .from("siso_movimentacoes")
      .select("localizacao_id, quantidade, origem_id, pedido_id")
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido")
      .eq("origem_id", pedidoId)
      .eq("localizacao_id", destinoLocId)
      .single();
    expect(novaReserva).toMatchObject({
      localizacao_id: destinoLocId,
      origem_id: pedidoId,
      pedido_id: pedidoId,
    });
    expect(Number(novaReserva!.quantidade)).toBe(23);
  });

  it("faz rollback quando nenhuma loc comporta a reserva inteira", async () => {
    await entrada(origemLocId, 10);
    await entrada(destinoLocId, 9);
    const reservaOriginalId = await reservar(10, `FULL-TEST-${crypto.randomUUID()}`);

    const { error } = await ajustarSaida(10);
    expect(error?.message).toMatch(/nenhuma outra localizacao ativa/i);

    const { data: estoque } = await sb
      .from("siso_estoque")
      .select("localizacao_id, saldo, reservado")
      .eq("produto_id", produtoId);
    const origem = estoque!.find((e) => e.localizacao_id === origemLocId)!;
    const destino = estoque!.find((e) => e.localizacao_id === destinoLocId)!;
    expect({ saldo: Number(origem.saldo), reservado: Number(origem.reservado) }).toEqual({
      saldo: 10,
      reservado: 10,
    });
    expect({ saldo: Number(destino.saldo), reservado: Number(destino.reservado) }).toEqual({
      saldo: 9,
      reservado: 0,
    });

    const { count } = await sb
      .from("siso_movimentacoes")
      .select("id", { count: "exact", head: true })
      .eq("tipo", "L")
      .eq("estorno_de", reservaOriginalId);
    expect(count).toBe(0);
  });
});
