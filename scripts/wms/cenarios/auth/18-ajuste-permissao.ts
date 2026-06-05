// scripts/wms/cenarios/auth/18-ajuste-permissao.ts
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { createServiceClient } from "../../../../src/lib/supabase-server";
import { seedTestUsers } from "../_harness/seed-test-users";

loadEnv({ path: ".env.test", override: false });
loadEnv({ path: ".env.test.local", override: true });

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

/**
 * Cenário 18 — POST /api/wms/ajuste exige operacoes.ajuste_manual no backend (P069).
 *
 * RED hoje: user com inventario.executar (passa requireWarehouseAccess) mas SEM
 * operacoes.ajuste_manual consegue ajustar via API (200). Esperado: 403.
 *
 * Casos:
 *  - noperm-user (só inventario.executar) → POST /ajuste → 403, nenhuma mov criada
 *  - op-runner (operador, tem operacoes.ajuste_manual) → POST /ajuste → 200
 */

async function ensureRoleComPerms(
  sb: ReturnType<typeof createServiceClient>,
  codigo: string,
  nome: string,
  perms: string[],
): Promise<string> {
  const { data: ex } = await sb.from("siso_roles").select("id").eq("codigo", codigo).maybeSingle();
  let roleId: string;
  if (ex) {
    roleId = (ex as { id: string }).id;
  } else {
    const { data, error } = await sb
      .from("siso_roles")
      .insert({ codigo, nome, descricao: nome, sistema: false })
      .select("id")
      .single();
    if (error) throw new Error(`criar role ${codigo}: ${error.message}`);
    roleId = (data as { id: string }).id;
  }
  await sb.from("siso_role_permissoes").delete().eq("role_id", roleId);
  await sb
    .from("siso_role_permissoes")
    .insert(perms.map((p) => ({ role_id: roleId, permissao_codigo: p })));
  return roleId;
}

async function ensureUserComRole(
  sb: ReturnType<typeof createServiceClient>,
  nome: string,
  pin: string,
  roleId: string,
): Promise<string> {
  const { data: ex } = await sb.from("siso_usuarios").select("id").eq("nome", nome).maybeSingle();
  let userId: string;
  if (ex) {
    userId = (ex as { id: string }).id;
    await sb.from("siso_usuarios").update({ pin, ativo: true }).eq("id", userId);
  } else {
    const { data, error } = await sb
      .from("siso_usuarios")
      .insert({ nome, pin, cargo: "operador", ativo: true })
      .select("id")
      .single();
    if (error) throw new Error(`criar user ${nome}: ${error.message}`);
    userId = (data as { id: string }).id;
  }
  await sb.from("siso_usuario_roles").delete().eq("usuario_id", userId);
  await sb.from("siso_usuario_roles").insert({ usuario_id: userId, role_id: roleId });
  return userId;
}

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

async function seedTripla(sb: ReturnType<typeof createServiceClient>) {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  const galpaoId = (g as { id: string }).id;
  const { data: l } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoId)
    .eq("tipo", "picking")
    .limit(1)
    .single();
  const locId = (l as { id: string }).id;
  const sku = `AUTH-AJUSTE-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku, descricao: "auth ajuste test", ativo: true })
    .select("id")
    .single();
  return { produtoId: (p as { id: string }).id, galpaoId, locId };
}

async function postAjuste(sid: string, tripla: { produto_id: string; galpao_id: string; localizacao_id: string }) {
  const r = await fetch(`${baseUrl}/api/wms/ajuste`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": sid },
    body: JSON.stringify({
      tripla,
      qty: 1,
      direcao: "entrada",
      motivo: "teste de permissao",
      motivo_categoria: "achado",
    }),
  });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

async function main() {
  const sb = createServiceClient();
  let failures = 0;

  await seedTestUsers(sb);

  const roleId = await ensureRoleComPerms(
    sb,
    "ajuste-test-noperm",
    "Ajuste Test No-Perm",
    ["inventario.executar"], // passa requireWarehouseAccess, sem operacoes.ajuste_manual
  );
  await ensureUserComRole(sb, "ajuste-noperm-runner", "2010", roleId);

  const tripla = await seedTripla(sb);

  const triplaBody = { produto_id: tripla.produtoId, galpao_id: tripla.galpaoId, localizacao_id: tripla.locId };

  // Caso 1: noperm (só inventario.executar) → 403
  const sidNoperm = await login("ajuste-noperm-runner", "2010");
  const r1 = await postAjuste(sidNoperm, triplaBody);
  const ok1 = r1.status === 403;
  console.log(`[${ok1 ? "PASS" : "FAIL"}] noperm → POST /ajuste: ${r1.status} (expected 403) body=${r1.body}`);
  if (!ok1) failures++;

  // Caso 2: operador (tem operacoes.ajuste_manual) → 200
  const sidOp = await login("op-runner", "1002");
  const r2 = await postAjuste(sidOp, triplaBody);
  const ok2 = r2.status === 200;
  console.log(`[${ok2 ? "PASS" : "FAIL"}] operador → POST /ajuste: ${r2.status} (expected 200) body=${r2.body}`);
  if (!ok2) failures++;

  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
