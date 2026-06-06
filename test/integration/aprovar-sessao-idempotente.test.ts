import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { aprovarSessao } from "../../src/lib/wms/inventario";

const sb = createServiceClient();
let galpaoId: string, op1: string, op2: string;

async function novaSessaoEmRevisao(): Promise<string> {
  // tipo é NOT NULL (CHECK cycle_count|completo); status 'revisao' é válido.
  const { data: s } = await sb
    .from("siso_inventario_sessoes")
    .insert({ tipo: "cycle_count", galpao_id: galpaoId, status: "revisao", criada_por: op1 })
    .select("id")
    .single();
  return s!.id;
}

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  // P055: o harness trunca 1x por run, mas vários arquivos de teste criam sessão de
  // inventário no mesmo galpão+dia → colidem no uq_inv_sessao_galpao_dia. Limpa as
  // sessões não-contínuas do galpão usado pra este arquivo ser ordem-independente
  // (FK ON DELETE CASCADE cuida dos filhos).
  await sb.from("siso_inventario_sessoes")
    .delete()
    .eq("galpao_id", galpaoId)
    .eq("continua", false);
  const { data: us } = await sb.from("siso_usuarios").select("id").limit(2);
  op1 = us![0].id;
  op2 = us![1]?.id ?? us![0].id;
});

describe("aprovarSessao idempotente (compare-and-set revisao)", () => {
  it("2ª aprovação é no-op e NÃO sobrescreve aprovada_por", async () => {
    const sid = await novaSessaoEmRevisao();
    await aprovarSessao(sid, op1); // 1ª: revisao → aprovada
    const { data: depois1 } = await sb
      .from("siso_inventario_sessoes").select("status, aprovada_por").eq("id", sid).single();
    expect(depois1?.status).toBe("aprovada");
    expect(depois1?.aprovada_por).toBe(op1);

    // 2ª aprovação por outro operador: deve ser recusada/no-op.
    await expect(aprovarSessao(sid, op2)).rejects.toThrow(/aprovada|revisão|revisao/i);
    const { data: depois2 } = await sb
      .from("siso_inventario_sessoes").select("aprovada_por").eq("id", sid).single();
    expect(depois2?.aprovada_por).toBe(op1); // não sobrescrito
  });
});
