import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let galpaoId: string, locId: string, quarentenaId: string, usuarioId: string, prodId: string;
const RND = Math.random().toString(36).slice(2, 7);

// siso_devolucoes_pendentes NÃO tem produto_id/galpao_id/qty — esses viajam
// como params da RPC, não como colunas. O insert da devolução só seta status
// (resto tem DEFAULT). Igual ao padrão de devolucoes-classificar-concorrente.test.ts.
async function novaDevolucao(): Promise<string> {
  const { data: d } = await sb
    .from("siso_devolucoes_pendentes")
    .insert({ status: "aguardando_classificacao" })
    .select("id")
    .single();
  return d!.id;
}

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: q } = await sb.from("siso_localizacoes")
    .upsert({ galpao_id: galpaoId, codigo: `QUAR-${RND}`, tipo: "quarentena", ativo: true }, { onConflict: "galpao_id,codigo" })
    .select("id").single();
  quarentenaId = q!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: p } = await sb.from("siso_produtos").insert({ sku: `DEVCLA-${RND}`, descricao: "dev cla", ativo: true }).select("id").single();
  prodId = p!.id;
});

describe("wms_classificar_devolucao — atômico [P049/P050/P054]", () => {
  it("avariado: E na loc + par S+E pra quarentena + status classificada, tudo numa tx", async () => {
    const devId = await novaDevolucao();
    const { data, error } = await sb.rpc("wms_classificar_devolucao", {
      p_devolucao_id: devId, p_classificacao: "avariado",
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_qty: 2, p_loc_quarentena_id: quarentenaId, p_usuario_id: usuarioId,
      p_origem_compartilhado: crypto.randomUUID(),
      p_nota_fiscal_id: null, p_empresa_referencia_id: null,
      p_fornecedor_id: null, p_custo_unitario: null, p_observacoes: "batido",
    });
    expect(error).toBeNull();
    expect((data as { status: string }).status).toBe("classificada");
    const { data: eOrig } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", locId).maybeSingle();
    const { data: eQuar } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).eq("localizacao_id", quarentenaId).single();
    expect(Number(eOrig?.saldo ?? 0)).toBe(0);
    expect(Number(eQuar?.saldo)).toBe(2);
    const { data: dd } = await sb.from("siso_devolucoes_pendentes").select("status").eq("id", devId).single();
    expect((dd as { status: string }).status).toBe("classificada");
  });

  it("re-classificar a mesma devolução (já classificada) é no-op idempotente (não duplica)", async () => {
    const devId = await novaDevolucao();
    const params = {
      p_devolucao_id: devId, p_classificacao: "integro",
      p_produto_id: prodId, p_galpao_id: galpaoId, p_localizacao_id: locId,
      p_qty: 1, p_loc_quarentena_id: null, p_usuario_id: usuarioId,
      p_origem_compartilhado: crypto.randomUUID(), p_nota_fiscal_id: null, p_empresa_referencia_id: null,
      p_fornecedor_id: null, p_custo_unitario: null, p_observacoes: null,
    };
    await sb.rpc("wms_classificar_devolucao", params);
    const { data: again } = await sb.rpc("wms_classificar_devolucao", { ...params, p_origem_compartilhado: crypto.randomUUID() });
    expect((again as { status: string; ja_classificada?: boolean })?.ja_classificada).toBe(true);
    // Isolamos pelo produto único deste teste (gerado no beforeAll): só o 1º
    // classify íntegro gera 1 mov E 'devolucao_cliente_integra'; o re-run é
    // no-op idempotente, então não duplica.
    const { count } = await sb.from("siso_movimentacoes").select("id", { count: "exact", head: true })
      .eq("produto_id", prodId).eq("origem_tipo", "devolucao_cliente_integra");
    expect(count).toBe(1);
  });
});
