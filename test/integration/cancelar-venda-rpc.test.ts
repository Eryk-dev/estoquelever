import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { cancelarVendaManual } from "../../src/lib/wms/vendas-cancelamento";

const sb = createServiceClient();
let galpaoId: string, locId: string, prodId: string, empresaId: string;
// uuid de usuário real pro p_usuario_id (não reusar empresaId).
let userId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  userId = u!.id;
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-CANC-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  prodId = p!.id;
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: 10, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
});

describe("wms_cancelar_venda_atomico", () => {
  it("estorna todas as S da venda + marca pedido cancelado numa tx; idempotente", async () => {
    const pedidoId = "MAN-cancel-1";
    const origemId = crypto.randomUUID();
    await sb.from("siso_pedidos").insert({
      id: pedidoId, status: "concluido",
      numero: pedidoId, data: "2026-06-09", filial_origem: "CWB", cliente_nome: "Cli",
    });
    // 2 S da mesma venda (origem_detalhes.pedido_id_manual)
    for (const q of [3, 2]) {
      await sb.rpc("wms_inserir_movimentacao", {
        p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
        p_tipo: "S", p_quantidade: q, p_origem_tipo: "venda_manual", p_origem_id: origemId,
        p_origem_detalhes: { pedido_id_manual: pedidoId }, p_empresa_vendedora_id: empresaId,
        p_pedido_id: pedidoId, p_motivo: "venda",
      });
    }
    // pós-vendas: saldo 5
    const { data, error } = await sb.rpc("wms_cancelar_venda_atomico", {
      p_pedido_id: pedidoId, p_usuario_id: null, p_motivo: "cancelamento teste",
    });
    expect(error).toBeNull();
    expect((data as { movs_estornadas: number }).movs_estornadas).toBe(2);
    const { data: est } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(10); // devolvido
    const { data: ped } = await sb.from("siso_pedidos").select("status").eq("id", pedidoId).single();
    expect((ped as { status: string }).status).toBe("cancelado");
    // 2ª chamada: idempotente
    const r2 = await sb.rpc("wms_cancelar_venda_atomico", { p_pedido_id: pedidoId, p_usuario_id: null, p_motivo: "x" });
    expect((r2.data as { movs_estornadas: number }).movs_estornadas).toBe(0);
  });
});

describe("cancelarVendaManual modo separação (caminho aguardando_separacao → RPC)", () => {
  it("tira o pedido da separação: status cancelado + status_separacao NULL", async () => {
    const pedidoId = "MAN-cancel-sep1";
    await sb.from("siso_pedidos").insert({
      id: pedidoId, status: "executando", status_separacao: "aguardando_separacao",
      numero: pedidoId, data: "2026-06-24", filial_origem: "CWB", cliente_nome: "Cli",
    });
    await cancelarVendaManual({ pedido_id: pedidoId, usuario_id: userId, motivo: "cancela sep" });
    const { data: ped } = await sb.from("siso_pedidos")
      .select("status, status_separacao").eq("id", pedidoId).single();
    expect((ped as { status: string }).status).toBe("cancelado");
    // BUG fix: antes ficava 'aguardando_separacao' → pedido travado na fila.
    expect((ped as { status_separacao: string | null }).status_separacao).toBeNull();
  });
});

describe("cancelarVendaManual baixa_direta (wrapper → RPC)", () => {
  it("estorna via RPC (marker distintivo) + marca cancelado", async () => {
    const pedidoId = "MAN-cancel-w1";
    const origemId = crypto.randomUUID();
    await sb.from("siso_pedidos").insert({
      id: pedidoId, status: "concluido",
      numero: pedidoId, data: "2026-06-09", filial_origem: "CWB", cliente_nome: "Cli",
    });
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 4, p_origem_tipo: "venda_manual", p_origem_id: origemId,
      p_origem_detalhes: { pedido_id_manual: pedidoId }, p_empresa_vendedora_id: empresaId,
      p_pedido_id: pedidoId, p_motivo: "venda",
    });
    const r = await cancelarVendaManual({ pedido_id: pedidoId, usuario_id: userId, motivo: "cancela wrapper" });
    expect(r.movsEstornadas).toBe(1); // 1 mov S estornada
    const { data: ped } = await sb.from("siso_pedidos").select("status").eq("id", pedidoId).single();
    expect((ped as { status: string }).status).toBe("cancelado");
    // RED DISTINTIVO: o estorno-E carrega o marker que SÓ a RPC grava.
    const { data: estornos } = await sb.from("siso_movimentacoes")
      .select("origem_detalhes")
      .eq("tipo", "E").eq("origem_tipo", "estorno").eq("pedido_id", pedidoId);
    expect((estornos ?? []).length).toBe(1);
    expect((estornos![0] as { origem_detalhes: Record<string, unknown> }).origem_detalhes.cancelamento_rpc).toBe(true);
  });
});
