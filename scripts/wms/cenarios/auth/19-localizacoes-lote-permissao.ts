// scripts/wms/cenarios/auth/19-localizacoes-lote-permissao.ts
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { createServiceClient } from "../../../../src/lib/supabase-server";
import { seedTestUsers } from "../_harness/seed-test-users";

loadEnv({ path: ".env.test", override: false });
loadEnv({ path: ".env.test.local", override: true });

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

/**
 * Cenário 19 — POST /api/wms/localizacoes/lote exige localizacoes.editar (P116).
 *
 * RED hoje: rota usa só requireAuth — qualquer logado cria N prateleiras.
 * Esperado: user sem localizacoes.editar → 403 e nenhuma loc criada.
 *
 * Casos:
 *  - vendor-runner (vendedor, sem localizacoes.editar) → POST lote → 403, 0 criadas
 *  - op-runner (operador, tem localizacoes.editar) → POST lote → 200, cria
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

async function postLote(sid: string, galpaoId: string, prefixo: string) {
  const r = await fetch(`${baseUrl}/api/wms/localizacoes/lote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": sid },
    body: JSON.stringify({
      galpao_id: galpaoId,
      prefixo,
      h_inicio: 1,
      h_fim: 2,
      v_inicio: 1,
      v_fim: 2,
      tipo: "picking",
      preview: false,
    }),
  });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

async function main() {
  const sb = createServiceClient();
  await seedTestUsers(sb);
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  const galpaoId = (g as { id: string }).id;
  let failures = 0;

  // Caso 1: vendedor (sem localizacoes.editar) → 403, nenhuma loc criada
  const prefixoV = `AV${Math.floor(Math.random() * 9000 + 1000)}`;
  const sidV = await login("vendor-runner", "1003");
  const r1 = await postLote(sidV, galpaoId, prefixoV);
  const ok1Status = r1.status === 403;
  const { count: criadasV } = await sb
    .from("siso_localizacoes")
    .select("id", { count: "exact", head: true })
    .eq("galpao_id", galpaoId)
    .like("codigo", `${prefixoV}%`);
  const ok1 = ok1Status && (criadasV ?? 0) === 0;
  console.log(`[${ok1 ? "PASS" : "FAIL"}] vendedor → lote: ${r1.status} (expected 403), criadas=${criadasV} (expected 0) body=${r1.body}`);
  if (!ok1) failures++;

  // Caso 2: operador (tem localizacoes.editar) → 200, cria
  const prefixoO = `AO${Math.floor(Math.random() * 9000 + 1000)}`;
  const sidO = await login("op-runner", "1002");
  const r2 = await postLote(sidO, galpaoId, prefixoO);
  const ok2Status = r2.status === 200;
  const { count: criadasO } = await sb
    .from("siso_localizacoes")
    .select("id", { count: "exact", head: true })
    .eq("galpao_id", galpaoId)
    .like("codigo", `${prefixoO}%`);
  const ok2 = ok2Status && (criadasO ?? 0) > 0;
  console.log(`[${ok2 ? "PASS" : "FAIL"}] operador → lote: ${r2.status} (expected 200), criadas=${criadasO} (expected >0) body=${r2.body}`);
  if (!ok2) failures++;

  // cleanup
  await sb.from("siso_localizacoes").delete().eq("galpao_id", galpaoId).like("codigo", `${prefixoO}%`);

  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
