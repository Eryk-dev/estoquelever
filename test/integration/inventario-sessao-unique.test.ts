import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let galpaoId: string;
let userId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: gSp } = await sb.from("siso_galpoes").select("id").eq("nome", "SP").single();
  // P055: o harness trunca 1x por run, mas vários arquivos de teste criam sessão de
  // inventário no mesmo galpão+dia → colidem no uq_inv_sessao_galpao_dia. Limpa as
  // sessões não-contínuas do(s) galpão(ões) usado(s) pra este arquivo ser ordem-independente
  // (FK ON DELETE CASCADE cuida dos filhos).
  await sb.from("siso_inventario_sessoes")
    .delete()
    .in("galpao_id", [galpaoId, gSp!.id])
    .eq("continua", false);
  const { data: u } = await sb.from("siso_usuarios").select("id").limit(1).single();
  userId = u!.id;
});

describe("UNIQUE parcial uq_inv_sessao_galpao_dia", () => {
  it("rejeita 2ª sessão cycle_count no mesmo galpão+dia com 23505", async () => {
    const base = {
      tipo: "cycle_count", galpao_id: galpaoId, modo_contagem: "blind",
      criada_por: userId, continua: false, status: "planejada",
    };
    const { error: e1 } = await sb.from("siso_inventario_sessoes").insert(base);
    expect(e1).toBeNull();

    const { error: e2 } = await sb.from("siso_inventario_sessoes").insert(base);
    expect(e2).not.toBeNull();
    expect(e2?.code).toBe("23505");
  });

  it("sessão cancelada anterior não bloqueia nova no mesmo dia", async () => {
    const { data: g2 } = await sb.from("siso_galpoes").select("id").eq("nome", "SP").single();
    const sp = g2!.id;
    await sb.from("siso_inventario_sessoes").insert({
      tipo: "cycle_count", galpao_id: sp, modo_contagem: "blind",
      criada_por: userId, continua: false, status: "cancelada",
    });
    const { error } = await sb.from("siso_inventario_sessoes").insert({
      tipo: "cycle_count", galpao_id: sp, modo_contagem: "blind",
      criada_por: userId, continua: false, status: "planejada",
    });
    expect(error).toBeNull();
  });
});
