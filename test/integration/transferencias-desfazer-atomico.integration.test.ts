import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoO: string, galpaoD: string, locO: string, locD: string, usuarioId: string, prodId: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: cwb } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  const { data: spg } = await sb.from("siso_galpoes").select("id").eq("nome", "SP").single();
  galpaoO = cwb!.id; galpaoD = spg!.id;
  const { data: lo } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoO).eq("codigo", "A-01-01").single();
  locO = lo!.id;
  const { data: ld } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoD).eq("codigo", "C-01-01").single();
  locD = ld!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: p } = await sb.from("siso_produtos").insert({ sku: `TRATOM-${RND}`, descricao: "transf atom", ativo: true }).select("id").single();
  prodId = p!.id;
});

describe("wms_desfazer_recebimento_transferencia — atômico [P067]", () => {
  it("desfaz: estorna legs E + reseta itens + header em_transito, numa tx", async () => {
    await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoO, p_localizacao_id: locO, p_tipo: "E", p_quantidade: 30, p_origem_tipo: "inventario_inicial", p_origem_id: null, p_custo_unitario: 1, p_motivo: "seed" });
    const { data: head } = await sb.from("siso_transferencias_galpao").insert({ galpao_origem_id: galpaoO, galpao_destino_id: galpaoD, status: "recebida", recebida_em: new Date().toISOString(), recebida_por: usuarioId, criada_por: usuarioId }).select("id").single();
    const transfId = head!.id;
    const { data: movS } = await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoO, p_localizacao_id: locO, p_tipo: "S", p_quantidade: 30, p_origem_tipo: "transferencia_galpao", p_origem_id: transfId, p_usuario_id: usuarioId, p_motivo: "saida" });
    const { data: movE } = await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoD, p_localizacao_id: locD, p_tipo: "E", p_quantidade: 30, p_origem_tipo: "transferencia_galpao", p_origem_id: transfId, p_usuario_id: usuarioId, p_motivo: "entrada" });
    const { data: item } = await sb.from("siso_transferencia_galpao_itens").insert({ transferencia_id: transfId, produto_id: prodId, localizacao_origem_id: locO, qty: 30, localizacao_destino_id: locD, mov_saida_id: movS as unknown as string, mov_entrada_id: movE as unknown as string }).select("id").single();

    const { data, error } = await sb.rpc("wms_desfazer_recebimento_transferencia", { p_transferencia_id: transfId, p_usuario_id: usuarioId, p_motivo: "undo atomico" });
    expect(error).toBeNull();
    expect((data as { movs_estornadas: number }).movs_estornadas).toBe(1);
    const { data: h } = await sb.from("siso_transferencias_galpao").select("status").eq("id", transfId).single();
    expect((h as { status: string }).status).toBe("em_transito");
    const { data: it } = await sb.from("siso_transferencia_galpao_itens").select("mov_entrada_id, localizacao_destino_id").eq("id", item!.id).single();
    expect((it as { mov_entrada_id: string | null }).mov_entrada_id).toBeNull();
    expect((it as { localizacao_destino_id: string | null }).localizacao_destino_id).toBeNull();
    const { data: e } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locD).single();
    expect(Number(e?.saldo)).toBe(0);
  });

  it("re-desfazer (header já em_transito) é no-op idempotente", async () => {
    const { data: head } = await sb.from("siso_transferencias_galpao").insert({ galpao_origem_id: galpaoO, galpao_destino_id: galpaoD, status: "em_transito", criada_por: usuarioId }).select("id").single();
    const { error } = await sb.rpc("wms_desfazer_recebimento_transferencia", { p_transferencia_id: head!.id, p_usuario_id: usuarioId, p_motivo: "ja em transito" });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/recebid/i);
  });
});
