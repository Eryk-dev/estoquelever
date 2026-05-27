import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Seeded test users for P4 auth tests. PINs match TEST_USERS table:
 *   admin-runner / 1001 → role 'admin'
 *   op-runner    / 1002 → role 'operador'
 *   vendor-runner/ 1003 → role 'vendedor'
 *   buyer-runner / 1004 → role 'comprador'
 *
 * Idempotent — re-running upserts row + role mapping without duplicating.
 * Trigger `trg_sync_cargos_after_roles` keeps siso_usuarios.cargos[] in
 * sync after we insert siso_usuario_roles rows.
 */
export interface TestUser {
  nome: string;
  pin: string;
  cargo: string; // legacy fallback; trigger overwrites from roles[]
  role_codigo: "admin" | "operador" | "vendedor" | "comprador";
}

export const TEST_USERS: TestUser[] = [
  { nome: "admin-runner",  pin: "1001", cargo: "admin",     role_codigo: "admin"     },
  { nome: "op-runner",     pin: "1002", cargo: "operador",  role_codigo: "operador"  },
  { nome: "vendor-runner", pin: "1003", cargo: "vendedor",  role_codigo: "vendedor"  },
  { nome: "buyer-runner",  pin: "1004", cargo: "comprador", role_codigo: "comprador" },
];

export async function seedTestUsers(sb: SupabaseClient): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const u of TEST_USERS) {
    // Upsert user
    const { data: existente } = await sb
      .from("siso_usuarios")
      .select("id")
      .eq("nome", u.nome)
      .maybeSingle();
    let id: string;
    if (existente) {
      await sb.from("siso_usuarios").update({ pin: u.pin, cargo: u.cargo, ativo: true }).eq("id", existente.id);
      id = (existente as { id: string }).id;
    } else {
      const { data, error } = await sb
        .from("siso_usuarios")
        .insert({ nome: u.nome, pin: u.pin, cargo: u.cargo, ativo: true })
        .select("id")
        .single();
      if (error) throw new Error(`seedTestUsers(${u.nome}): ${error.message}`);
      id = (data as { id: string }).id;
    }
    ids[u.nome] = id;

    // Resolve role_id
    const { data: role } = await sb
      .from("siso_roles")
      .select("id")
      .eq("codigo", u.role_codigo)
      .maybeSingle();
    if (!role) throw new Error(`seedTestUsers: role '${u.role_codigo}' não existe — rode migration 20260521_roles_permissoes.sql primeiro`);

    // Upsert user→role mapping (PK = usuario_id+role_id)
    await sb.from("siso_usuario_roles").upsert(
      { usuario_id: id, role_id: (role as { id: string }).id },
      { onConflict: "usuario_id,role_id" },
    );
  }
  return ids;
}

/**
 * Login helper for P4 tests. Returns sessionId for the given test user
 * by POSTing /api/auth/login with their PIN. Caller passes baseUrl from
 * the dev server.
 */
export async function loginTestUser(opts: { baseUrl: string; nome: string }): Promise<string> {
  const user = TEST_USERS.find((u) => u.nome === opts.nome);
  if (!user) throw new Error(`loginTestUser: ${opts.nome} não está em TEST_USERS`);
  const res = await fetch(`${opts.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome: user.nome, pin: user.pin }),
  });
  if (!res.ok) throw new Error(`loginTestUser ${opts.nome}: HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { sessionId?: string; sessao_id?: string; session_id?: string };
  const sid = data.sessionId ?? data.sessao_id ?? data.session_id;
  if (!sid) throw new Error(`loginTestUser ${opts.nome}: response sem session id`);
  return sid;
}
