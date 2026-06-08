import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { iniciarGuarda, confirmarGuarda } from "../../src/lib/wms/guarda";

// FASE 6 — follow-up (LEDGER review, FIX 1).
// A loc de recebimento pode carregar uma reserva ALHEIA (um pedido reservando
// estoque do recebimento). Se confirmarGuarda for chamado com qty excedendo o
// saldo FÍSICO livre, a perna S do replenishment empurraria saldo abaixo do
// reservado alheio → CHECK(reservado<=saldo) → erro opaco do Postgres.
// O RPC agora valida ANTES e levanta 'qty (%) excede saldo livre (%)' — erro
// LIMPO, não a violação crua do CHECK.

const sb = createServiceClient();
let galpaoId: string, locId: string, locDestId: string, op1: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoId)
    .eq("tipo", "recebimento")
    .eq("ativo", true)
    .limit(1)
    .single();
  locId = l!.id;
  const { data: ld } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoId)
    .eq("codigo", "A-01-01")
    .single();
  locDestId = ld!.id;
  const { data: us } = await sb.from("siso_usuarios").select("id").limit(1);
  op1 = us![0].id;
});

describe("confirmarGuarda valida saldo livre (reserva alheia)", () => {
  it("qty excedendo o saldo físico livre lança erro LIMPO 'excede saldo livre' (não CHECK violation)", async () => {
    // Produto fresco isola saldo/reservado da loc de recebimento.
    const { data: p } = await sb
      .from("siso_produtos")
      .insert({
        sku: `TEST-GD-SL-${Math.random().toString(36).slice(2, 8)}`,
        descricao: "saldo livre test",
        ativo: true,
      })
      .select("id")
      .single();
    const produtoId = p!.id as string;

    // saldo 10 na loc de recebimento.
    const { data: mov, error: movErr } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: produtoId,
      p_galpao_id: galpaoId,
      p_localizacao_id: locId,
      p_tipo: "E",
      p_quantidade: 10,
      p_origem_tipo: "inventario_inicial",
      p_origem_id: null,
      p_custo_unitario: 1,
      p_motivo: "saldo livre seed",
    });
    if (movErr) throw movErr;
    const movId = mov as unknown as string;

    // Reserva ALHEIA de 4 (um pedido reservando estoque do recebimento).
    const fakePedidoId = `FAKE-PED-${Math.random().toString(36).slice(2, 8)}`;
    const { error: resErr } = await sb.rpc("wms_reservar_atomico", {
      p_produto_id: produtoId,
      p_galpao_id: galpaoId,
      p_localizacao_id: locId,
      p_quantidade: 4,
      p_pedido_id: fakePedidoId,
      p_ttl_horas: 720,
      p_usuario_id: op1,
    });
    if (resErr) throw resErr;

    const { data: pend, error: pendErr } = await sb
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
    if (pendErr) throw pendErr;
    const pid = pend!.id;

    // iniciarGuarda reserva o LIVRE remanescente (10 - 4 = 6) como R própria.
    await iniciarGuarda({ pendencia_id: pid, usuario_id: op1 });

    // Estado: saldo=10, reservado=10 (4 alheia + 6 própria), livre real = 6.
    // confirmar com qty=8 > 6 → erro LIMPO, não CHECK violation crua.
    await expect(
      confirmarGuarda({
        pendencia_id: pid,
        qty: 8,
        localizacao_destino_id: locDestId,
        usuario_id: op1,
      }),
    ).rejects.toThrow(/excede saldo livre/);

    // Saldo/reservado intactos (rollback limpo, nada movido).
    const { data: est } = await sb
      .from("siso_estoque")
      .select("saldo, reservado")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locId)
      .single();
    expect(Number(est!.saldo)).toBe(10);
    expect(Number(est!.reservado)).toBe(10);

    // qty=6 (== livre) confirma OK: libera a R própria (6), move o par S+E.
    const r = await confirmarGuarda({
      pendencia_id: pid,
      qty: 6,
      localizacao_destino_id: locDestId,
      usuario_id: op1,
    });
    expect(r.origem_id).toBeTruthy();

    const { data: estDepois } = await sb
      .from("siso_estoque")
      .select("saldo, reservado")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locId)
      .single();
    // saldo 10 - 6 = 4; reservado 10 - 6 (R própria liberada) = 4 (só a alheia).
    expect(Number(estDepois!.saldo)).toBe(4);
    expect(Number(estDepois!.reservado)).toBe(4);
  });
});
