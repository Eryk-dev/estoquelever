import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let galpaoId: string;
let userId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: gSp } = await sb.from("siso_galpoes").select("id").eq("nome", "SP").single();
  // Limpa sessões não-contínuas do(s) galpão(ões) usado(s) pra este arquivo ser
  // ordem-independente (FK ON DELETE CASCADE cuida dos filhos). Sem isso, keys
  // de idempotência de runs anteriores poderiam colidir no índice global.
  await sb.from("siso_inventario_sessoes")
    .delete()
    .in("galpao_id", [galpaoId, gSp!.id])
    .eq("continua", false);
  const { data: u } = await sb.from("siso_usuarios").select("id").limit(1).single();
  userId = u!.id;
});

describe("guarda anti-duplo-clique por idempotency_key", () => {
  it("permite N sessões no mesmo galpão+dia (sem o limite P055)", async () => {
    const base = {
      tipo: "cycle_count", galpao_id: galpaoId, modo_contagem: "blind",
      criada_por: userId, continua: false, status: "planejada",
    };
    const { error: e1 } = await sb.from("siso_inventario_sessoes").insert(base);
    expect(e1).toBeNull();
    const { error: e2 } = await sb.from("siso_inventario_sessoes").insert(base);
    expect(e2).toBeNull();
  });

  it("dedup: 2ª sessão com a MESMA idempotency_key colide com 23505", async () => {
    const key = crypto.randomUUID();
    const base = {
      tipo: "cycle_count", galpao_id: galpaoId, modo_contagem: "blind",
      criada_por: userId, continua: false, status: "planejada",
      idempotency_key: key,
    };
    const { error: e1 } = await sb.from("siso_inventario_sessoes").insert(base);
    expect(e1).toBeNull();

    const { error: e2 } = await sb.from("siso_inventario_sessoes").insert(base);
    expect(e2).not.toBeNull();
    expect(e2?.code).toBe("23505");
  });

  it("idempotency_key distintas no mesmo galpão+dia não colidem", async () => {
    const base = {
      tipo: "cycle_count", galpao_id: galpaoId, modo_contagem: "blind",
      criada_por: userId, continua: false, status: "planejada",
    };
    const { error: e1 } = await sb
      .from("siso_inventario_sessoes")
      .insert({ ...base, idempotency_key: crypto.randomUUID() });
    expect(e1).toBeNull();
    const { error: e2 } = await sb
      .from("siso_inventario_sessoes")
      .insert({ ...base, idempotency_key: crypto.randomUUID() });
    expect(e2).toBeNull();
  });
});
