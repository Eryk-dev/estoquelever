import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { reverterCutoverSeRetrocedeu } from "../../src/lib/wms/cutover";

const sb = createServiceClient();
let galpaoId: string, locId: string, prodId: string, empresaId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
  const { data: p } = await sb.from("siso_produtos")
    .insert({ sku: `TEST-REVCUT-${Date.now()}`, descricao: "x", ativo: true }).select("id").single();
  prodId = p!.id;
});

async function pedidoComSaidaLancada(pedidoId: string, qty: number, saldoInicial: number) {
  // siso_pedidos: numero/data/filial_origem/cliente_nome são NOT NULL (legado);
  // filial_origem é enum siso_filial (CWB|SP) — fixtures diretos os incluem.
  await sb.from("siso_pedidos").insert({
    id: pedidoId, numero: pedidoId, data: new Date().toISOString(),
    filial_origem: "CWB", cliente_nome: "Teste reverter cutover atomico",
    status: "executando", estoque_lancado: true, nf_estoque_lancado: true,
  });
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "E", p_quantidade: saldoInicial, p_origem_tipo: "inventario_inicial", p_motivo: "seed",
  });
  // S nf_venda ligada ao pedido (origem_id=pedidoId)
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
    p_tipo: "S", p_quantidade: qty, p_origem_tipo: "nf_venda", p_origem_id: pedidoId,
    p_empresa_vendedora_id: empresaId, p_pedido_id: pedidoId, p_motivo: "cutover S",
  });
}

describe("wms_reverter_cutover_atomico", () => {
  it("estorna todas as S + recria R + flip da flag numa tx; idempotente na 2ª", async () => {
    const pedidoId = "710000001";
    await pedidoComSaidaLancada(pedidoId, 4, 10); // pós-S: saldo 6
    const { data, error } = await sb.rpc("wms_reverter_cutover_atomico", {
      p_pedido_id: pedidoId, p_motivo: "desfazer_bip", p_usuario_id: null,
    });
    expect(error).toBeNull();
    expect((data as { reverted: boolean }).reverted).toBe(true);
    const { data: est } = await sb.from("siso_estoque").select("saldo, reservado")
      .eq("produto_id", prodId).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(10);    // E counter recuperou
    expect(Number(est?.reservado)).toBe(4); // R recriada
    const { data: ped } = await sb.from("siso_pedidos").select("estoque_lancado").eq("id", pedidoId).single();
    expect((ped as { estoque_lancado: boolean }).estoque_lancado).toBe(false);
    // 2ª chamada: idempotente (S já estornadas → nenhuma nova E)
    const r2 = await sb.rpc("wms_reverter_cutover_atomico", { p_pedido_id: pedidoId, p_motivo: "desfazer_bip", p_usuario_id: null });
    expect(r2.error).toBeNull();
    expect((r2.data as { saidas_estornadas: number }).saidas_estornadas).toBe(0);
  });
});

describe("reverterCutoverSeRetrocedeu (wrapper → RPC)", () => {
  it("reverte quando saiu do forward e estoque_lancado=true", async () => {
    const pedidoId = "710000010";
    await pedidoComSaidaLancada(pedidoId, 3, 8);
    const r = await reverterCutoverSeRetrocedeu(pedidoId, "em_separacao", "desfazer_bip", undefined);
    expect(r.reverted).toBe(true);
    const { data: ped } = await sb.from("siso_pedidos").select("estoque_lancado").eq("id", pedidoId).single();
    expect((ped as { estoque_lancado: boolean }).estoque_lancado).toBe(false);
  });

  it("no-op quando ainda forward (separado)", async () => {
    const pedidoId = "710000011";
    await pedidoComSaidaLancada(pedidoId, 2, 8);
    const r = await reverterCutoverSeRetrocedeu(pedidoId, "separado", "desfazer_bip", undefined);
    expect(r.reverted).toBe(false);
    expect(r.motivo).toBe("ainda_forward");
  });

  // RED DETERMINÍSTICO via marker: o estorno-E da reversão carrega
  // 'reversal_cutover_rpc' SÓ quando sai pela RPC. O loop TS antigo grava o
  // estorno via inserirMovimentacao SEM esse marker → o assert falha contra ele.
  it("reverte via RPC: estorno-E carrega o marker distintivo", async () => {
    const pedidoId = "710000012";
    await pedidoComSaidaLancada(pedidoId, 4, 10);
    const r = await reverterCutoverSeRetrocedeu(pedidoId, "em_separacao", "desfazer_bip", undefined);
    expect(r.reverted).toBe(true);
    const { data: estornos } = await sb.from("siso_movimentacoes")
      .select("origem_detalhes")
      .eq("tipo", "E").eq("origem_tipo", "estorno").eq("origem_id", pedidoId);
    expect((estornos ?? []).length).toBe(1);
    expect((estornos![0] as { origem_detalhes: Record<string, unknown> }).origem_detalhes.reversal_cutover_rpc).toBe(true);
  });
});
