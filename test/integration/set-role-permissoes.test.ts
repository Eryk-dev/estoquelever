import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
let roleId: string;

beforeAll(async () => {
  const { data: r } = await sb
    .from("siso_roles")
    .insert({ codigo: `test_role_${Math.random().toString(36).slice(2, 8)}`, nome: "Test Role", sistema: false })
    .select("id")
    .single();
  roleId = r!.id;
  // semeia 2 permissões existentes (códigos reais do registry)
  await sb.from("siso_role_permissoes").insert([
    { role_id: roleId, permissao_codigo: "separacao.executar" },
    { role_id: roleId, permissao_codigo: "separacao.ver" },
  ]);
});

afterAll(async () => {
  await sb.from("siso_role_permissoes").delete().eq("role_id", roleId);
  await sb.from("siso_roles").delete().eq("id", roleId);
});

describe("wms_set_role_permissoes — replace tudo-ou-nada", () => {
  it("replace substitui o conjunto inteiro", async () => {
    const { error } = await sb.rpc("wms_set_role_permissoes", {
      p_role_id: roleId,
      p_codigos: ["operacoes.guarda", "inventario.executar"],
    });
    expect(error).toBeNull();
    const { data: perms } = await sb
      .from("siso_role_permissoes").select("permissao_codigo").eq("role_id", roleId);
    const codigos = (perms ?? []).map((p) => p.permissao_codigo).sort();
    expect(codigos).toEqual(["inventario.executar", "operacoes.guarda"]);
  });

  it("role inexistente → erro, e NÃO esvazia nada", async () => {
    const { error } = await sb.rpc("wms_set_role_permissoes", {
      p_role_id: "00000000-0000-0000-0000-000000000000",
      p_codigos: ["operacoes.guarda"],
    });
    expect(error).not.toBeNull();
    // o role real continua com suas permissões do teste anterior
    const { data: perms } = await sb
      .from("siso_role_permissoes").select("permissao_codigo").eq("role_id", roleId);
    expect((perms ?? []).length).toBe(2);
  });

  it("replace com array vazio zera (caminho válido)", async () => {
    const { error } = await sb.rpc("wms_set_role_permissoes", {
      p_role_id: roleId,
      p_codigos: [],
    });
    expect(error).toBeNull();
    const { data: perms } = await sb
      .from("siso_role_permissoes").select("permissao_codigo").eq("role_id", roleId);
    expect((perms ?? []).length).toBe(0);
  });
});
