import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { createServiceClient } from "../../../../src/lib/supabase-server";
import { loginTestUser } from "../_harness/seed-test-users";

loadEnv({ path: ".env.test", override: false });
loadEnv({ path: ".env.test.local", override: true });

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

async function fetchStatus(path: string, sessionId?: string) {
  const headers: Record<string, string> = {};
  if (sessionId) headers["X-Session-Id"] = sessionId;
  const r = await fetch(`${baseUrl}${path}`, { headers });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

async function main() {
  const sb = createServiceClient();

  // Seed extra vendedor V2 (P4 standard vendor-runner is V1; we need a
  // second vendedor with their own pedido).
  const v2nome = "vendor2-runner";
  const v2pin = "1005";
  const { data: ex } = await sb.from("siso_usuarios").select("id").eq("nome", v2nome).maybeSingle();
  let v2Id: string;
  if (ex) {
    v2Id = (ex as { id: string }).id;
    await sb.from("siso_usuarios").update({ pin: v2pin, ativo: true, cargo: "vendedor" }).eq("id", v2Id);
  } else {
    const { data } = await sb.from("siso_usuarios").insert({ nome: v2nome, pin: v2pin, cargo: "vendedor", ativo: true }).select("id").single();
    v2Id = (data as { id: string }).id;
  }
  const { data: roleV } = await sb.from("siso_roles").select("id").eq("codigo", "vendedor").single();
  await sb.from("siso_usuario_roles").upsert(
    { usuario_id: v2Id, role_id: (roleV as { id: string }).id },
    { onConflict: "usuario_id,role_id" },
  );

  // Login V2 ad hoc
  const loginV2 = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome: v2nome, pin: v2pin }),
  });
  const v2Session = (await loginV2.json() as { sessionId?: string }).sessionId!;

  // Get vendor-runner (V1) id
  const { data: v1Row } = await sb.from("siso_usuarios").select("id").eq("nome", "vendor-runner").single();
  const _v1Id = (v1Row as { id: string }).id;

  // Insert a pedido owned by V2 (origem_pedido='manual' so it's a venda
  // direta and the existing vendedor check passes; ownership is the
  // additional gate).
  const { data: emp } = await sb.from("siso_empresas").select("id").limit(1).single();
  const empresaId = (emp as { id: string }).id;
  const pedidoFakeId = `auth-test-${Date.now()}`;
  const { data: pedidoRow, error: insertErr } = await sb.from("siso_pedidos").insert({
    id: pedidoFakeId,
    numero: pedidoFakeId,
    empresa_origem_id: empresaId,
    filial_origem: "CWB",
    cliente_nome: "Auth Test",
    origem_pedido: "manual",
    status: "concluido",
    vendedor_id: v2Id,
    vendedor_nome: v2nome,
    data: new Date().toISOString().slice(0, 10),
    processado_em: new Date().toISOString(),
    criado_em: new Date().toISOString(),
  }).select("id").single();
  if (insertErr) {
    console.error("Insert pedido error:", insertErr);
    process.exit(2);
  }
  const pedidoId = (pedidoRow as { id: string }).id;

  let failures = 0;

  // V1 trying to access V2's pedido → 403
  const sidV1 = await loginTestUser({ baseUrl, nome: "vendor-runner" });
  const r1 = await fetchStatus(`/api/wms/vendas/${pedidoId}`, sidV1);
  const ok1 = r1.status === 403;
  console.log(`[${ok1 ? "PASS" : "FAIL"}] vendedor V1 → V2 pedido: ${r1.status} (expected 403) body=${r1.body}`);
  if (!ok1) failures++;

  // V2 acessando o próprio → 200
  const r2 = await fetchStatus(`/api/wms/vendas/${pedidoId}`, v2Session);
  const ok2 = r2.status === 200;
  console.log(`[${ok2 ? "PASS" : "FAIL"}] vendedor V2 → V2 pedido: ${r2.status} (expected 200) body=${r2.body}`);
  if (!ok2) failures++;

  // Admin acessando o pedido → 200 (bypass)
  const sidAdmin = await loginTestUser({ baseUrl, nome: "admin-runner" });
  const r3 = await fetchStatus(`/api/wms/vendas/${pedidoId}`, sidAdmin);
  const ok3 = r3.status === 200;
  console.log(`[${ok3 ? "PASS" : "FAIL"}] admin → V2 pedido: ${r3.status} (expected 200) body=${r3.body}`);
  if (!ok3) failures++;

  // Operador acessando → 200 (separacao.executar bypass)
  const sidOp = await loginTestUser({ baseUrl, nome: "op-runner" });
  const r4 = await fetchStatus(`/api/wms/vendas/${pedidoId}`, sidOp);
  const ok4 = r4.status === 200;
  console.log(`[${ok4 ? "PASS" : "FAIL"}] operador → V2 pedido: ${r4.status} (expected 200) body=${r4.body}`);
  if (!ok4) failures++;

  // Cleanup
  await sb.from("siso_pedidos").delete().eq("id", pedidoId);

  if (failures) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(2); });
