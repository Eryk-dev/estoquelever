import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { desfazerRecebimentoTransferencia } from "../../src/lib/wms/transferencias";

const sb = createServiceClient();
let galpaoO: string, galpaoD: string, locO: string, locD: string, usuarioId: string, prodId: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: cwb } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  const { data: spg } = await sb.from("siso_galpoes").select("id").eq("nome", "SP").single();
  galpaoO = cwb!.id; galpaoD = spg!.id;
  // CWB tem picking A-01-XX; SP tem picking C-01-XX (ver seed do harness).
  const { data: lo } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoO).eq("codigo", "A-01-01").single();
  locO = lo!.id;
  const { data: ld } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoD).eq("codigo", "C-01-01").single();
  locD = ld!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: p } = await sb.from("siso_produtos").insert({ sku: `TRDESF-${RND}`, descricao: "transf desf", ativo: true }).select("id").single();
  prodId = p!.id;
});

describe("desfazerRecebimentoTransferencia — preflight [P065]", () => {
  it("recebido 50, vendido 10 (destino=40): retorna 409 estruturado 'desfazível 40 de 50' SEM mutar", async () => {
    await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoO, p_localizacao_id: locO, p_tipo: "E", p_quantidade: 50, p_origem_tipo: "inventario_inicial", p_origem_id: null, p_custo_unitario: 1, p_motivo: "seed" });
    const { data: head } = await sb.from("siso_transferencias_galpao").insert({ galpao_origem_id: galpaoO, galpao_destino_id: galpaoD, status: "recebida", recebida_em: new Date().toISOString(), criada_por: usuarioId }).select("id").single();
    const transfId = head!.id;
    const { data: movS } = await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoO, p_localizacao_id: locO, p_tipo: "S", p_quantidade: 50, p_origem_tipo: "transferencia_galpao", p_origem_id: transfId, p_usuario_id: usuarioId, p_motivo: "saida" });
    const { data: movE } = await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoD, p_localizacao_id: locD, p_tipo: "E", p_quantidade: 50, p_origem_tipo: "transferencia_galpao", p_origem_id: transfId, p_usuario_id: usuarioId, p_motivo: "entrada" });
    await sb.from("siso_transferencia_galpao_itens").insert({ transferencia_id: transfId, produto_id: prodId, localizacao_origem_id: locO, qty: 50, localizacao_destino_id: locD, mov_saida_id: movS as unknown as string, mov_entrada_id: movE as unknown as string });
    await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoD, p_localizacao_id: locD, p_tipo: "S", p_quantidade: 10, p_origem_tipo: "venda_manual", p_origem_id: null, p_usuario_id: usuarioId, p_motivo: "venda" });

    await expect(
      desfazerRecebimentoTransferencia({ transferencia_id: transfId, usuario_id: usuarioId, motivo: "undo total" }),
    ).rejects.toThrow(/desfazível 40 de 50|só pode devolver 40/i);

    const { data: h } = await sb.from("siso_transferencias_galpao").select("status").eq("id", transfId).single();
    expect((h as { status: string }).status).toBe("recebida");
    const { data: e } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locD).single();
    expect(Number(e?.saldo)).toBe(40);
  });
});
