import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { iniciarGuarda } from "../../src/lib/wms/guarda";

// FASE 6 — F2-guarda: reserva forte ao iniciar.
// iniciarGuarda deve criar uma reserva (R origem_tipo='reserva_guarda') que
// trava o saldo físico presente na loc de recebimento (disponivel → 0),
// impedindo que um pick concorrente consuma a peça antes do put-away.

const sb = createServiceClient();
let galpaoId: string, locId: string, op1: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  // loc tipo='recebimento' do galpão — origem da guarda.
  const { data: l } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoId)
    .eq("tipo", "recebimento")
    .eq("ativo", true)
    .limit(1)
    .single();
  locId = l!.id;
  const { data: us } = await sb.from("siso_usuarios").select("id").limit(1);
  op1 = us![0].id;
});

// Produto fresco por teste — isola o saldo/reservado da loc de recebimento
// entre casos (a suíte só trunca no globalSetup, 1x por run). Sem isso, a R
// criada pelo 1º teste deixa livre=0 pro 2º e falseia a aritmética.
async function novaPendencia(): Promise<{ pid: string; produtoId: string }> {
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({
      sku: `TEST-GD-RF-${Math.random().toString(36).slice(2, 8)}`,
      descricao: "reserva forte test",
      ativo: true,
    })
    .select("id")
    .single();
  const produtoId = p!.id as string;
  // saldo 10 na loc de recebimento (mov E real satisfaz o FK mov_entrada_id).
  const { data: mov, error: movErr } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId,
    p_galpao_id: galpaoId,
    p_localizacao_id: locId,
    p_tipo: "E",
    p_quantidade: 10,
    p_origem_tipo: "inventario_inicial",
    p_origem_id: null,
    p_custo_unitario: 1,
    p_motivo: "reserva forte seed",
  });
  if (movErr) throw movErr;
  const movId = mov as unknown as string;
  const { data: pend, error } = await sb
    .from("siso_wms_pendencias_guarda")
    .insert({
      produto_id: produtoId,
      galpao_id: galpaoId,
      localizacao_origem_id: locId,
      mov_entrada_id: movId,
      origem_tipo: "nf_compra",
      qty_inicial: 10,
      qty_guardada: 0,
      status: "pendente",
    })
    .select("id")
    .single();
  if (error) throw error;
  return { pid: pend!.id, produtoId };
}

describe("iniciarGuarda reserva forte", () => {
  it("reserva todo o saldo presente na loc de recebimento (disponivel → 0) + 1 mov R reserva_guarda", async () => {
    const { pid, produtoId } = await novaPendencia();
    const { data: estAntes } = await sb
      .from("siso_estoque")
      .select("saldo, reservado, disponivel")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locId)
      .single();
    expect(Number(estAntes!.saldo)).toBe(10);
    expect(Number(estAntes!.reservado)).toBe(0);

    await iniciarGuarda({ pendencia_id: pid, usuario_id: op1 });

    const { data: estDepois } = await sb
      .from("siso_estoque")
      .select("saldo, reservado, disponivel")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locId)
      .single();
    // reservado subiu de 0 → 10; disponivel caiu pra 0; saldo intacto.
    expect(Number(estDepois!.reservado)).toBe(10);
    expect(Number(estDepois!.disponivel)).toBe(0);
    expect(Number(estDepois!.saldo)).toBe(10);

    // exatamente 1 mov R origem_tipo='reserva_guarda' p/ esta pendência.
    const { data: movsR } = await sb
      .from("siso_movimentacoes")
      .select("id, quantidade")
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_guarda")
      .eq("origem_id", pid);
    expect(movsR?.length).toBe(1);
    expect(Number(movsR![0].quantidade)).toBe(10);
  });

  it("idempotente: re-chamar iniciarGuarda do mesmo operador não duplica a R", async () => {
    const { pid } = await novaPendencia();
    await iniciarGuarda({ pendencia_id: pid, usuario_id: op1 });
    await iniciarGuarda({ pendencia_id: pid, usuario_id: op1 });
    const { data: movsR } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_guarda")
      .eq("origem_id", pid);
    expect(movsR?.length).toBe(1);
  });
});
