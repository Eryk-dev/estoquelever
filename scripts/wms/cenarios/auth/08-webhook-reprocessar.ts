import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { createServiceClient } from "../../../../src/lib/supabase-server";
import { loginTestUser } from "../_harness/seed-test-users";

loadEnv({ path: ".env.test", override: false });
loadEnv({ path: ".env.test.local", override: true });

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

async function fetchJson(method: string, path: string, opts: { sessionId?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.sessionId) headers["X-Session-Id"] = opts.sessionId;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.text() };
}

async function main() {
  const sb = createServiceClient();
  let failures = 0;

  // ── Case 1: no session → 401 ──
  {
    const r = await fetchJson("POST", "/api/wms/webhook/reprocessar", { body: { pedidoId: "X" } });
    const ok = r.status === 401;
    console.log(`[${ok ? "PASS" : "FAIL"}] no session → ${r.status} (expected 401)`);
    if (!ok) failures++;
  }

  // ── Case 2: vendedor session → 403 (not admin) ──
  {
    const sid = await loginTestUser({ baseUrl, nome: "vendor-runner" });
    const r = await fetchJson("POST", "/api/wms/webhook/reprocessar", { sessionId: sid, body: { pedidoId: "X" } });
    const ok = r.status === 403;
    console.log(`[${ok ? "PASS" : "FAIL"}] vendedor → ${r.status} (expected 403)`);
    if (!ok) failures++;
  }

  // ── Case 3: operador → 403 (admin only — requireAdmin) ──
  {
    const sid = await loginTestUser({ baseUrl, nome: "op-runner" });
    const r = await fetchJson("POST", "/api/wms/webhook/reprocessar", { sessionId: sid, body: { pedidoId: "X" } });
    const ok = r.status === 403;
    console.log(`[${ok ? "PASS" : "FAIL"}] operador → ${r.status} (expected 403; admin-only)`);
    if (!ok) failures++;
  }

  // ── Case 4: admin sem body → 400 (Zod) ──
  {
    const sid = await loginTestUser({ baseUrl, nome: "admin-runner" });
    const r = await fetchJson("POST", "/api/wms/webhook/reprocessar", { sessionId: sid });
    const ok = r.status === 400;
    console.log(`[${ok ? "PASS" : "FAIL"}] admin sem body → ${r.status} (expected 400)`);
    if (!ok) failures++;
  }

  // ── Case 5: admin com pedidoId desconhecido → 404 ──
  {
    const sid = await loginTestUser({ baseUrl, nome: "admin-runner" });
    const r = await fetchJson("POST", "/api/wms/webhook/reprocessar", {
      sessionId: sid,
      body: { pedidoId: "9999999999" },
    });
    const ok = r.status === 404;
    console.log(`[${ok ? "PASS" : "FAIL"}] admin pedidoId desconhecido → ${r.status} (expected 404)`);
    if (!ok) failures++;
  }

  // ── Case 6: isolation — outras rows pendentes NÃO são reprocessadas ──
  // Setup: insere 2 rows pendentes em siso_webhook_logs com IDs distintos.
  // Chama o endpoint passando só o ID 1. Asserta que o ID 2 ainda está
  // status='pendente' depois (não foi tocado).
  {
    const sid = await loginTestUser({ baseUrl, nome: "admin-runner" });
    const id1 = `p4-isolation-${Date.now()}-1`;
    const id2 = `p4-isolation-${Date.now()}-2`;
    const { data: emp } = await sb.from("siso_empresas").select("id, cnpj").limit(1).single();
    const cnpj = (emp as { cnpj: string }).cnpj;

    // Reset/insert 2 logs (dedup_key is GENERATED ALWAYS — omit from insert)
    const ins = await sb.from("siso_webhook_logs").insert([
      { tiny_pedido_id: id1, cnpj, tipo: "inclusao_pedido", codigo_situacao: "aprovado", status: "pendente", payload: { iso_test: true } },
      { tiny_pedido_id: id2, cnpj, tipo: "inclusao_pedido", codigo_situacao: "aprovado", status: "pendente", payload: { iso_test: true } },
    ]);
    if (ins.error) {
      console.log(`[FAIL] isolation setup: insert error: ${ins.error.message}`);
      failures++;
    }

    const r = await fetchJson("POST", "/api/wms/webhook/reprocessar", { sessionId: sid, body: { pedidoId: id1 } });
    // Status pode ser 200 ou 500 (depende se webhook-processor consegue resolver empresa);
    // o ponto da isolation é: id2 não foi mexido.
    const { data: row2 } = await sb.from("siso_webhook_logs").select("status").eq("tiny_pedido_id", id2).maybeSingle();
    const ok = (row2 as { status?: string } | null)?.status === "pendente";
    console.log(`[${ok ? "PASS" : "FAIL"}] isolation: id2 still pendente (got status=${(row2 as { status?: string } | null)?.status}) — endpoint reply status=${r.status}`);
    if (!ok) failures++;

    // Cleanup
    await sb.from("siso_webhook_logs").delete().in("tiny_pedido_id", [id1, id2]);
  }

  if (failures) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(2); });
