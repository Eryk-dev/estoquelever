import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { createServiceClient } from "../../../../src/lib/supabase-server";
import { loginTestUser } from "../_harness/seed-test-users";

loadEnv({ path: ".env.test", override: false });
loadEnv({ path: ".env.test.local", override: true });

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

async function patch(path: string, body: unknown, sessionId: string) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

async function main() {
  const sb = createServiceClient();
  const adminSid = await loginTestUser({ baseUrl, nome: "admin-runner" });

  // Setup: criar pedido manual sem vendedor
  const { data: emp } = await sb.from("siso_empresas").select("id").limit(1).single();
  const pedidoFakeId = `auth-target-${Date.now()}`;
  const { error: insertErr } = await sb.from("siso_pedidos").insert({
    id: pedidoFakeId,
    numero: pedidoFakeId,
    empresa_origem_id: (emp as { id: string }).id,
    filial_origem: "CWB",
    cliente_nome: "Auth Test",
    origem_pedido: "manual",
    status: "concluido",
    data: new Date().toISOString().slice(0, 10),
    processado_em: new Date().toISOString(),
    criado_em: new Date().toISOString(),
  });
  if (insertErr) {
    console.error("Insert pedido error:", insertErr);
    process.exit(2);
  }

  // IDs dos test users seeded
  const { data: vendor } = await sb.from("siso_usuarios").select("id").eq("nome", "vendor-runner").single();
  const { data: comprador } = await sb.from("siso_usuarios").select("id").eq("nome", "buyer-runner").single();
  const { data: admin } = await sb.from("siso_usuarios").select("id").eq("nome", "admin-runner").single();
  const vendorId = (vendor as { id: string }).id;
  const compradorId = (comprador as { id: string }).id;
  const adminId = (admin as { id: string }).id;

  let failures = 0;

  // Case 1: target = vendor (has cargo vendedor) → 200
  {
    const r = await patch(`/api/wms/vendas/${pedidoFakeId}/vendedor`, { vendedor_id: vendorId }, adminSid);
    const ok = r.status === 200;
    console.log(`[${ok ? "PASS" : "FAIL"}] target vendedor → ${r.status} (expected 200) body=${r.body}`);
    if (!ok) failures++;
  }

  // Case 2: target = comprador (no vendedor/operador role) → 400
  {
    const r = await patch(`/api/wms/vendas/${pedidoFakeId}/vendedor`, { vendedor_id: compradorId }, adminSid);
    const ok = r.status === 400;
    console.log(`[${ok ? "PASS" : "FAIL"}] target comprador → ${r.status} (expected 400; comprador não tem cargo vendedor/operador) body=${r.body}`);
    if (!ok) failures++;
  }

  // Case 3: target = admin (admin role doesn't have vendedor/operador*; we
  // still allow because admin sometimes acts as vendedor; documenting:
  // admin should be valid). We accept either 200 OR 400 — this case is
  // about documenting intent, not strict assertion. Default: 200 if admin
  // is whitelisted, 400 if strict.
  //
  // Decision: admin IS whitelisted (it's effectively a super-role). Expect 200.
  {
    const r = await patch(`/api/wms/vendas/${pedidoFakeId}/vendedor`, { vendedor_id: adminId }, adminSid);
    const ok = r.status === 200;
    console.log(`[${ok ? "PASS" : "FAIL"}] target admin → ${r.status} (expected 200; admin é super-role) body=${r.body}`);
    if (!ok) failures++;
  }

  // Case 4: target = null (desatribuir) → 200
  {
    const r = await patch(`/api/wms/vendas/${pedidoFakeId}/vendedor`, { vendedor_id: null }, adminSid);
    const ok = r.status === 200;
    console.log(`[${ok ? "PASS" : "FAIL"}] target null → ${r.status} (expected 200) body=${r.body}`);
    if (!ok) failures++;
  }

  // Cleanup
  await sb.from("siso_pedidos").delete().eq("id", pedidoFakeId);

  if (failures) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(2); });
