import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { estornarDivergenciaInventario } from "../../src/lib/wms/inventario";

const sb = createServiceClient();
let galpaoId: string, locId: string, usuarioId: string, prod1: string, prod2: string;
const RND = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: a } = await sb.from("siso_produtos").insert({ sku: `ESTIND-1-${RND}`, descricao: "ind 1", ativo: true }).select("id").single();
  const { data: b } = await sb.from("siso_produtos").insert({ sku: `ESTIND-2-${RND}`, descricao: "ind 2", ativo: true }).select("id").single();
  prod1 = a!.id; prod2 = b!.id;
});

describe("estornarDivergenciaInventario", () => {
  it("estorna SÓ a divergência alvo; as outras seguem aplicadas e sessão não vira revisao se restam aplicadas", async () => {
    const { data: sess } = await sb.from("siso_inventario_sessoes")
      .insert({ galpao_id: galpaoId, tipo: "cycle_count", modo_contagem: "aberto", status: "aplicada", criada_por: usuarioId, aplicada_em: new Date().toISOString() })
      .select("id").single();
    const sessaoId = sess!.id;
    async function ganho(prod: string, qty: number): Promise<string> {
      const { data: movId } = await sb.rpc("wms_inserir_movimentacao", {
        p_produto_id: prod, p_galpao_id: galpaoId, p_localizacao_id: locId,
        p_tipo: "E", p_quantidade: qty, p_origem_tipo: "inventario_ganho", p_origem_id: sessaoId, p_usuario_id: usuarioId, p_motivo: "seed",
      });
      const { data: div } = await sb.from("siso_inventario_divergencias")
        .insert({ sessao_id: sessaoId, localizacao_id: locId, produto_id: prod, saldo_sistema: 0, qty_contada_final: qty, status: "aplicada", mov_aplicada_id: movId as unknown as string })
        .select("id").single();
      return (div as { id: string }).id;
    }
    const div1 = await ganho(prod1, 4);
    await ganho(prod2, 2);

    await estornarDivergenciaInventario({ divergencia_id: div1, usuario_id: usuarioId, motivo: "errei só essa" });

    const { data: d1 } = await sb.from("siso_inventario_divergencias").select("status, mov_aplicada_id").eq("id", div1).single();
    expect((d1 as { status: string }).status).toBe("pendente");
    expect((d1 as { mov_aplicada_id: string | null }).mov_aplicada_id).toBeNull();
    const { count: aplicadas } = await sb.from("siso_inventario_divergencias").select("id", { count: "exact", head: true }).eq("sessao_id", sessaoId).eq("status", "aplicada");
    expect(aplicadas).toBe(1); // prod2 segue aplicada
    const { data: e1 } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prod1).eq("localizacao_id", locId).single();
    expect(Number(e1?.saldo)).toBe(0);

    // Libera o índice único uq_inv_sessao_galpao_dia (galpao+dia) p/ outros testes.
    await sb.from("siso_inventario_sessoes").update({ status: "cancelada" }).eq("id", sessaoId);
  });
});
