import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { aplicarSessao } from "../../src/lib/wms/inventario";

const sb = createServiceClient();

let galpaoId: string;
let locId: string;
let prodOk: string;
let prodFail: string;
let userId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id")
    .eq("galpao_id", galpaoId).eq("codigo", "A-01-01").single();
  locId = l!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  userId = u!.id;
  const mk = async (sku: string) => {
    const { data } = await sb.from("siso_produtos").insert({ sku, descricao: sku, ativo: true }).select("id").single();
    return data!.id as string;
  };
  prodOk = await mk(`TEST-APL-OK-${Date.now()}`);
  prodFail = await mk(`TEST-APL-FAIL-${Date.now()}`);
});

async function criarSessaoComDivergencias(divs: Array<{ produto_id: string; delta: number }>) {
  // Schema-drift: o índice parcial uq_inv_sessao_galpao_dia é UNIQUE em
  // (galpao_id, criado_em::date) onde status<>'cancelada' AND continua=false.
  // Cada it() cria uma sessão no mesmo galpão+dia → colidiriam. Limpa a sessão
  // não-contínua anterior do galpão antes de inserir (FK ON DELETE CASCADE
  // remove divergências/locs filhas) pra este arquivo ser ordem-independente.
  await sb.from("siso_inventario_sessoes").delete().eq("galpao_id", galpaoId).eq("continua", false);
  const { data: sess } = await sb
    .from("siso_inventario_sessoes")
    .insert({
      galpao_id: galpaoId, tipo: "cycle_count", modo_contagem: "blind",
      status: "aprovada", tamanho_pool: divs.length, criada_por: userId,
    })
    .select("id").single();
  for (const d of divs) {
    // Schema-drift: siso_inventario_divergencias.delta é GENERATED ALWAYS
    // (qty_contada_final - saldo_sistema), ambos NOT NULL. Não dá pra inserir
    // delta direto. Mapeia o delta desejado pra (saldo_sistema, qty_contada_final)
    // mantendo o estoque LIVE em 0 (perda inviável p/ prodFail, ganho viável):
    //   delta>=0 → saldo_sistema=0, qty=delta ; delta<0 → saldo_sistema=-delta, qty=0.
    const saldoSistema = d.delta >= 0 ? 0 : -d.delta;
    const qtyContada = d.delta >= 0 ? d.delta : 0;
    await sb.from("siso_inventario_divergencias").insert({
      sessao_id: sess!.id, produto_id: d.produto_id, localizacao_id: locId,
      saldo_sistema: saldoSistema, qty_contada_final: qtyContada, status: "aprovada",
    });
  }
  return sess!.id as string;
}

describe("wms_aplicar_sessao_inventario", () => {
  it("aplica todas as divergências tudo-ou-nada e transiciona sessão→'aplicada'", async () => {
    const sessaoId = await criarSessaoComDivergencias([{ produto_id: prodOk, delta: 7 }]);
    const { data, error } = await sb.rpc("wms_aplicar_sessao_inventario", {
      p_sessao: sessaoId, p_usuario: userId,
    });
    expect(error).toBeNull();
    expect((data as { movs_geradas: number }).movs_geradas).toBe(1);
    const { data: est } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodOk).eq("galpao_id", galpaoId).eq("localizacao_id", locId).single();
    expect(Number(est?.saldo)).toBe(7);
    const { data: s2 } = await sb.from("siso_inventario_sessoes").select("status").eq("id", sessaoId).single();
    expect((s2 as { status: string }).status).toBe("aplicada");
  });

  it("aborta sem aplicar nada se uma divergência ficaria inviável (perda > saldo)", async () => {
    // prodFail tem saldo 0 → perda de 5 é inviável (saldo insuficiente). Junto com um ganho viável.
    const sessaoId = await criarSessaoComDivergencias([
      { produto_id: prodOk, delta: 3 },     // viável
      { produto_id: prodFail, delta: -5 },  // inviável (saldo 0)
    ]);
    const saldoOkAntes = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodOk).eq("galpao_id", galpaoId).eq("localizacao_id", locId).maybeSingle();
    const { error } = await sb.rpc("wms_aplicar_sessao_inventario", { p_sessao: sessaoId, p_usuario: userId });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/saldo|insuficiente|inviável/i);
    // rollback total: ganho do prodOk NÃO foi aplicado
    const { data: est } = await sb.from("siso_estoque").select("saldo")
      .eq("produto_id", prodOk).eq("galpao_id", galpaoId).eq("localizacao_id", locId).maybeSingle();
    expect(Number(est?.saldo ?? 0)).toBe(Number(saldoOkAntes.data?.saldo ?? 0));
    const { data: s2 } = await sb.from("siso_inventario_sessoes").select("status").eq("id", sessaoId).single();
    expect((s2 as { status: string }).status).toBe("aprovada"); // não transicionou
  });

  it("idempotente: 2ª chamada em sessão já 'aplicada' retorna movs existentes sem duplicar", async () => {
    const sessaoId = await criarSessaoComDivergencias([{ produto_id: prodOk, delta: 2 }]);
    const r1 = await sb.rpc("wms_aplicar_sessao_inventario", { p_sessao: sessaoId, p_usuario: userId });
    expect(r1.error).toBeNull();
    const r2 = await sb.rpc("wms_aplicar_sessao_inventario", { p_sessao: sessaoId, p_usuario: userId });
    expect(r2.error).toBeNull();
    expect((r2.data as { movs_geradas: number }).movs_geradas).toBe((r1.data as { movs_geradas: number }).movs_geradas);
  });
});

describe("aplicarSessao (wrapper TS → RPC)", () => {
  it("delega à RPC e retorna { movsGeradas }", async () => {
    const sessaoId = await criarSessaoComDivergencias([{ produto_id: prodOk, delta: 4 }]);
    const r = await aplicarSessao(sessaoId, userId);
    expect(r.movsGeradas).toBe(1);
    const { data: s2 } = await sb.from("siso_inventario_sessoes").select("status").eq("id", sessaoId).single();
    expect((s2 as { status: string }).status).toBe("aplicada");
  });

  // RED DETERMINÍSTICO: rollback total quando uma divergência é inviável.
  it("wrapper: rollback total quando uma divergência é inviável", async () => {
    const sessaoId = await criarSessaoComDivergencias([
      { produto_id: prodOk, delta: 6 },     // ganho viável (aplicado 1º pelo loop antigo)
      { produto_id: prodFail, delta: -9 },  // perda inviável (prodFail saldo 0)
    ]);
    // RPC nova: RAISE → wrapper rejeita E nenhuma mov do prodOk persiste.
    await expect(aplicarSessao(sessaoId, userId)).rejects.toThrow(/saldo|insuficiente|inviável/i);
    const { data: s2 } = await sb.from("siso_inventario_sessoes").select("status").eq("id", sessaoId).single();
    expect((s2 as { status: string }).status).toBe("aprovada"); // NÃO transicionou
    // E nenhuma mov de ganho do prodOk ficou para trás (rollback total).
    const { data: movs } = await sb.from("siso_movimentacoes").select("id")
      .eq("origem_id", sessaoId).eq("origem_tipo", "inventario_ganho");
    expect((movs ?? []).length).toBe(0);
  });
});
