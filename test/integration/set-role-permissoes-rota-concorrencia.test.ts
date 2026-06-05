import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { PUT } from "../../src/app/api/wms/admin/roles/[id]/permissoes/route";

const sb = createServiceClient();
let roleId: string;
let sessionId: string;

beforeAll(async () => {
  // Role-alvo da edição.
  const { data: r } = await sb
    .from("siso_roles")
    .insert({ codigo: `test_rota_${Math.random().toString(36).slice(2, 8)}`, nome: "Rota Conc Role", sistema: false })
    .select("id")
    .single();
  roleId = r!.id;

  // Sessão válida do admin-runner. O globalSetup (test/integration/globalSetup.ts)
  // roda seedInicial → seedTestUsers, que cria 'admin-runner' (PIN 1001) com a
  // role 'admin' (cross-join de TODAS as permissões → inclui 'sistema.roles').
  // Logo o usuário e o vínculo de role já existem aqui.
  const { data: admin } = await sb
    .from("siso_usuarios").select("id").eq("nome", "admin-runner").single();
  const { data: sess } = await sb
    .from("siso_sessoes")
    .insert({ usuario_id: admin!.id, expira_em: new Date(Date.now() + 3600_000).toISOString() })
    .select("id")
    .single();
  sessionId = sess!.id;
});

afterAll(async () => {
  await sb.from("siso_sessoes").delete().eq("id", sessionId);
  await sb.from("siso_role_permissoes").delete().eq("role_id", roleId);
  await sb.from("siso_roles").delete().eq("id", roleId);
});

function reqPut(perms: string[]): Request {
  return new Request(`http://test/api/wms/admin/roles/${roleId}/permissoes`, {
    method: "PUT",
    headers: { "X-Session-Id": sessionId, "Content-Type": "application/json" },
    body: JSON.stringify({ permissoes: perms }),
  });
}

describe("rota PUT permissoes — serialização concorrente (P139)", () => {
  it("dois PUTs concorrentes resultam em EXATAMENTE um conjunto (nunca mesclado/vazio)", async () => {
    const A = ["separacao.executar", "separacao.ver"];
    const B = ["inventario.executar"];
    const params = Promise.resolve({ id: roleId });
    await Promise.all([
      PUT(reqPut(A), { params }),
      PUT(reqPut(B), { params }),
    ]);
    const { data: perms } = await sb
      .from("siso_role_permissoes").select("permissao_codigo").eq("role_id", roleId);
    const codigos = (perms ?? []).map((p) => p.permissao_codigo).sort();
    const isA = JSON.stringify(codigos) === JSON.stringify([...A].sort());
    const isB = JSON.stringify(codigos) === JSON.stringify([...B].sort());
    expect(isA || isB).toBe(true); // serializado, não mesclado (A∪B = 3 códigos)
    expect(codigos.length).toBeGreaterThan(0); // nunca vazio/parcial
  });
});
