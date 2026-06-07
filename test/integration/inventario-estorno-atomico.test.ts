import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, usuarioId: string;
let prodA: string, prodB: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: a } = await sb.from("siso_produtos").insert({ sku: `ESTSESS-A-${RND}`, descricao: "estorno A", ativo: true }).select("id").single();
  const { data: b } = await sb.from("siso_produtos").insert({ sku: `ESTSESS-B-${RND}`, descricao: "estorno B", ativo: true }).select("id").single();
  prodA = a!.id; prodB = b!.id;
});

describe("wms_estornar_sessao_inventario", () => {
  it("tudo-ou-nada: se um estorno deixaria saldo negativo, NENHUM é desfeito e nomeia o produto", async () => {
    const { data: sess } = await sb.from("siso_inventario_sessoes")
      .insert({ galpao_id: galpaoId, tipo: "cycle_count", modo_contagem: "aberto", status: "aplicada", criada_por: usuarioId, aplicada_em: new Date().toISOString() })
      .select("id").single();
    const sessaoId = sess!.id;

    async function ganho(prod: string, qty: number) {
      const { data: movId } = await sb.rpc("wms_inserir_movimentacao", {
        p_produto_id: prod, p_galpao_id: galpaoId, p_localizacao_id: locId,
        p_tipo: "E", p_quantidade: qty, p_origem_tipo: "inventario_ganho",
        p_origem_id: sessaoId, p_usuario_id: usuarioId, p_motivo: "seed",
      });
      await sb.from("siso_inventario_divergencias").insert({
        sessao_id: sessaoId, localizacao_id: locId, produto_id: prod,
        saldo_sistema: 0, qty_contada_final: qty, status: "aplicada", mov_aplicada_id: movId as unknown as string,
      });
    }
    await ganho(prodA, 20);
    await ganho(prodB, 5);

    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodA, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "S", p_quantidade: 15, p_origem_tipo: "venda_manual", p_origem_id: null,
      p_usuario_id: usuarioId, p_motivo: "consumo",
    });

    const { error } = await sb.rpc("wms_estornar_sessao_inventario", {
      p_sessao: sessaoId, p_usuario: usuarioId, p_motivo: "teste tudo-ou-nada",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(new RegExp(`ESTSESS-A-${RND}|${prodA}`));

    const { data: estA } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodA).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    const { data: estB } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodB).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(estA?.saldo)).toBe(5);
    expect(Number(estB?.saldo)).toBe(5);
    const { count } = await sb.from("siso_inventario_divergencias").select("id", { count: "exact", head: true }).eq("sessao_id", sessaoId).eq("status", "aplicada");
    expect(count).toBe(2);

    // Libera o índice único uq_inv_sessao_galpao_dia (galpao+dia) p/ o próximo teste.
    await sb.from("siso_inventario_sessoes").update({ status: "cancelada" }).eq("id", sessaoId);
  });

  it("caminho feliz: estorna todas as divergências e volta sessão pra revisao", async () => {
    const { data: sess } = await sb.from("siso_inventario_sessoes")
      .insert({ galpao_id: galpaoId, tipo: "cycle_count", modo_contagem: "aberto", status: "aplicada", criada_por: usuarioId, aplicada_em: new Date().toISOString() })
      .select("id").single();
    const sessaoId = sess!.id;
    const { data: movId } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodB, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_tipo: "E", p_quantidade: 3, p_origem_tipo: "inventario_ganho", p_origem_id: sessaoId, p_usuario_id: usuarioId, p_motivo: "seed2",
    });
    await sb.from("siso_inventario_divergencias").insert({
      sessao_id: sessaoId, localizacao_id: locId, produto_id: prodB,
      saldo_sistema: 5, qty_contada_final: 8, status: "aplicada", mov_aplicada_id: movId as unknown as string,
    });
    const { data, error } = await sb.rpc("wms_estornar_sessao_inventario", { p_sessao: sessaoId, p_usuario: usuarioId, p_motivo: "undo feliz" });
    expect(error).toBeNull();
    expect((data as { movs_estornadas: number }).movs_estornadas).toBe(1);
    const { data: ss } = await sb.from("siso_inventario_sessoes").select("status").eq("id", sessaoId).single();
    expect((ss as { status: string }).status).toBe("revisao");
  });
});
