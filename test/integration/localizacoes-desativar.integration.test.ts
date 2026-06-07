import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { desativarLocalizacao } from "../../src/lib/wms/localizacoes";

const sb = createServiceClient();
let galpaoId: string, galpaoDestId: string, usuarioId: string, prodId: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: gd } = await sb.from("siso_galpoes").select("id").eq("nome", "SP").single();
  galpaoDestId = gd!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: p } = await sb.from("siso_produtos").insert({ sku: `LOCDES-${RND}`, descricao: "loc des", ativo: true }).select("id").single();
  prodId = p!.id;
});

async function novaLoc(codigo: string, galpao = galpaoId): Promise<string> {
  const { data } = await sb.from("siso_localizacoes").insert({ galpao_id: galpao, codigo, tipo: "picking", ativo: true }).select("id").single();
  return (data as { id: string }).id;
}

describe("desativarLocalizacao — guards [P115/P063]", () => {
  it("[P115] reserva VENCIDA + saldo: auto-limpa reserva (reservado→0) e segue bloqueando por saldo>0", async () => {
    const loc = await novaLoc(`LOCDES-VENC-${RND}`);
    await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: loc, p_tipo: "E", p_quantidade: 50, p_origem_tipo: "inventario_inicial", p_origem_id: null, p_custo_unitario: 1, p_motivo: "seed" });
    await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: loc, p_tipo: "R", p_quantidade: 50, p_origem_tipo: "reserva_pedido", p_origem_id: `MAN-RES-${RND}`, p_expira_em: new Date(Date.now() - 3600_000).toISOString(), p_usuario_id: usuarioId, p_motivo: "reserva vencida" });
    await expect(desativarLocalizacao(loc)).rejects.toThrow(/saldo/i);
    const { data: est } = await sb.from("siso_estoque").select("saldo, reservado").eq("localizacao_id", loc).single();
    expect(Number((est as { reservado: number }).reservado)).toBe(0);
  });

  it("[P063] loc destino de transferência em_transito (saldo 0) é bloqueada", async () => {
    const loc = await novaLoc(`LOCDES-TRANSF-${RND}`, galpaoDestId);
    const { data: head } = await sb.from("siso_transferencias_galpao").insert({ galpao_origem_id: galpaoId, galpao_destino_id: galpaoDestId, status: "em_transito", criada_por: usuarioId }).select("id").single();
    const { data: locO } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
    await sb.from("siso_transferencia_galpao_itens").insert({ transferencia_id: head!.id, produto_id: prodId, localizacao_origem_id: (locO as { id: string }).id, qty: 5, localizacao_destino_id: loc });
    await expect(desativarLocalizacao(loc)).rejects.toThrow(/transferência|em trânsito|substituir/i);
  });

  it("[P063] loc com pendência de guarda aberta (saldo 0) é bloqueada", async () => {
    const loc = await novaLoc(`LOCDES-GUARDA-${RND}`);
    const { data: recLoc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("tipo", "recebimento").limit(1).single();
    const recLocId = (recLoc as { id: string }).id;
    // mov_entrada_id é NOT NULL (FK em siso_movimentacoes) — semeia a entrada na RECEBIMENTO.
    const { data: movE } = await sb.rpc("wms_inserir_movimentacao", { p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: recLocId, p_tipo: "E", p_quantidade: 3, p_origem_tipo: "nf_compra", p_origem_id: `MAN-GUARDA-${RND}`, p_custo_unitario: 1, p_motivo: "seed guarda" });
    const { error: pendErr } = await sb.from("siso_wms_pendencias_guarda").insert({ produto_id: prodId, galpao_id: galpaoId, localizacao_origem_id: recLocId, localizacao_destino_id: loc, mov_entrada_id: movE as unknown as string, origem_tipo: "nf_compra", qty_inicial: 3, qty_guardada: 0, status: "pendente", criada_por: usuarioId });
    expect(pendErr).toBeNull();
    await expect(desativarLocalizacao(loc)).rejects.toThrow(/guarda|pendência|substituir/i);
  });
});
