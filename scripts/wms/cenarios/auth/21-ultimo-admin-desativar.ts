// scripts/wms/cenarios/auth/21-ultimo-admin-desativar.ts
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { createServiceClient } from "../../../../src/lib/supabase-server";
import { seedTestUsers } from "../_harness/seed-test-users";

loadEnv({ path: ".env.test", override: false });
loadEnv({ path: ".env.test.local", override: true });

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

/**
 * Cenário 21 — PUT /api/wms/admin/usuarios não pode desativar o último admin ativo (P136).
 *
 * RED hoje: PUT { id, ativo:false } no único admin retorna 200 e desativa → lockout.
 * Esperado: 4xx + admin permanece ativo. Com 2 admins, desativar 1 → 200.
 */

async function login(nome: string, pin: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome, pin }),
  });
  const j = (await r.json()) as { sessionId?: string };
  if (!j.sessionId) throw new Error(`login ${nome} sem sessionId: ${JSON.stringify(j)}`);
  return j.sessionId;
}

async function adminRoleId(sb: ReturnType<typeof createServiceClient>): Promise<string> {
  const { data } = await sb.from("siso_roles").select("id").eq("codigo", "admin").single();
  return (data as { id: string }).id;
}

async function ensureAdmin(sb: ReturnType<typeof createServiceClient>, nome: string, pin: string, roleId: string): Promise<string> {
  const { data: ex } = await sb.from("siso_usuarios").select("id").eq("nome", nome).maybeSingle();
  let id: string;
  if (ex) {
    id = (ex as { id: string }).id;
    await sb.from("siso_usuarios").update({ pin, ativo: true }).eq("id", id);
  } else {
    const { data } = await sb.from("siso_usuarios").insert({ nome, pin, cargo: "admin", ativo: true }).select("id").single();
    id = (data as { id: string }).id;
  }
  await sb.from("siso_usuario_roles").upsert({ usuario_id: id, role_id: roleId }, { onConflict: "usuario_id,role_id" });
  return id;
}

async function putAtivo(sid: string, id: string, ativo: boolean) {
  const r = await fetch(`${baseUrl}/api/wms/admin/usuarios`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Session-Id": sid },
    body: JSON.stringify({ id, ativo }),
  });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

async function isAtivo(sb: ReturnType<typeof createServiceClient>, id: string): Promise<boolean> {
  const { data } = await sb.from("siso_usuarios").select("ativo").eq("id", id).single();
  return (data as { ativo: boolean }).ativo;
}

async function main() {
  const sb = createServiceClient();
  await seedTestUsers(sb);
  const roleId = await adminRoleId(sb);
  let failures = 0;

  const soloAdmin = await ensureAdmin(sb, "solo-admin-runner", "2099", roleId);
  const { data: todosAdmins } = await sb
    .from("siso_usuario_roles")
    .select("usuario_id, siso_roles!inner(codigo)")
    .eq("siso_roles.codigo", "admin");
  for (const a of (todosAdmins ?? []) as Array<{ usuario_id: string }>) {
    if (a.usuario_id !== soloAdmin) {
      await sb.from("siso_usuarios").update({ ativo: false }).eq("id", a.usuario_id);
    }
  }

  const sid = await login("solo-admin-runner", "2099");

  // Caso 1: único admin ativo tenta se desativar → 4xx + permanece ativo
  const r1 = await putAtivo(sid, soloAdmin, false);
  const ainda1 = await isAtivo(sb, soloAdmin);
  const ok1 = r1.status >= 400 && r1.status < 500 && ainda1 === true;
  console.log(`[${ok1 ? "PASS" : "FAIL"}] desativar último admin: ${r1.status} (expected 4xx), ativo=${ainda1} (expected true) body=${r1.body}`);
  if (!ok1) failures++;

  // Caso 2: cria 2º admin ativo, agora desativar o solo → 200
  const segundo = await ensureAdmin(sb, "segundo-admin-runner", "2098", roleId);
  const r2 = await putAtivo(sid, soloAdmin, false);
  const ainda2 = await isAtivo(sb, soloAdmin);
  const ok2 = r2.status === 200 && ainda2 === false;
  console.log(`[${ok2 ? "PASS" : "FAIL"}] desativar 1 de 2 admins: ${r2.status} (expected 200), ativo=${ainda2} (expected false) body=${r2.body}`);
  if (!ok2) failures++;

  // cleanup: reativa solo + remove 2º
  await sb.from("siso_usuarios").update({ ativo: true }).eq("id", soloAdmin);
  await sb.from("siso_usuario_roles").delete().eq("usuario_id", segundo);
  await sb.from("siso_usuarios").update({ ativo: false }).eq("id", segundo);

  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
