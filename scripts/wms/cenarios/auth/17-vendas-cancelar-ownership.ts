import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { createServiceClient } from "../../../../src/lib/supabase-server";
import { loginTestUser } from "../_harness/seed-test-users";

loadEnv({ path: ".env.test", override: false });
loadEnv({ path: ".env.test.local", override: true });

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

/**
 * Cenário 17 — POST /api/wms/vendas/[id]/cancelar ownership gate
 *
 * Cobre P0 re-audit #7.NEW1: endpoint criado em P3 #7.13 pra auto-serviço
 * do vendedor estava gated por requireWarehouseAccess (whitelist sem
 * vendas.*) — persona-alvo nunca conseguia cancelar a própria venda.
 *
 * Fix: helper requireWarehouseAccessOrOwnVenda permite vendedor dono.
 *
 * Casos:
 *   - V1 (vendedor) tenta cancelar pedido de V2 → 403
 *   - V2 (vendedor dono) cancela próprio → 200
 *   - admin cancela qualquer → 200
 *   - operador cancela qualquer → 200 (warehouse fast-path)
 */

async function fetchCancelar(pedidoId: string, sessionId: string, motivo: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Session-Id": sessionId,
  };
  const r = await fetch(`${baseUrl}/api/wms/vendas/${pedidoId}/cancelar`, {
    method: "POST",
    headers,
    body: JSON.stringify({ motivo }),
  });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

async function seedPedidoV2(sb: ReturnType<typeof createServiceClient>, v2Id: string, v2nome: string): Promise<string> {
  const { data: emp } = await sb.from("siso_empresas").select("id").limit(1).single();
  const empresaId = (emp as { id: string }).id;
  const pedidoFakeId = `auth-test-cancelar-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { data: pedidoRow, error } = await sb.from("siso_pedidos").insert({
    id: pedidoFakeId,
    numero: pedidoFakeId,
    empresa_origem_id: empresaId,
    filial_origem: "CWB",
    cliente_nome: "Auth Test Cancelar",
    origem_pedido: "manual",
    status: "concluido",
    status_separacao: "aguardando_separacao",
    vendedor_id: v2Id,
    vendedor_nome: v2nome,
    data: new Date().toISOString().slice(0, 10),
    processado_em: new Date().toISOString(),
    criado_em: new Date().toISOString(),
  }).select("id").single();
  if (error) throw new Error(`seed pedido failed: ${error.message}`);
  return (pedidoRow as { id: string }).id;
}

async function main() {
  const sb = createServiceClient();

  // Seed V2 (segundo vendedor — vendor-runner é V1)
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

  let failures = 0;

  // Caso 1: V1 (vendor-runner) tenta cancelar pedido de V2 → 403
  const pedido1 = await seedPedidoV2(sb, v2Id, v2nome);
  const sidV1 = await loginTestUser({ baseUrl, nome: "vendor-runner" });
  const r1 = await fetchCancelar(pedido1, sidV1, "tentativa cross-vendor");
  const ok1 = r1.status === 403;
  console.log(`[${ok1 ? "PASS" : "FAIL"}] V1 → cancelar V2 pedido: ${r1.status} (expected 403) body=${r1.body}`);
  if (!ok1) failures++;
  await sb.from("siso_pedidos").delete().eq("id", pedido1);

  // Caso 2: V2 (dono) cancela próprio → 200
  const pedido2 = await seedPedidoV2(sb, v2Id, v2nome);
  const r2 = await fetchCancelar(pedido2, v2Session, "errei o cliente");
  const ok2 = r2.status === 200;
  console.log(`[${ok2 ? "PASS" : "FAIL"}] V2 → cancelar próprio: ${r2.status} (expected 200) body=${r2.body}`);
  if (!ok2) failures++;
  await sb.from("siso_pedidos").delete().eq("id", pedido2);

  // Caso 3: admin cancela pedido de V2 → 200 (warehouse fast-path — admin tem todas perms)
  const pedido3 = await seedPedidoV2(sb, v2Id, v2nome);
  const sidAdmin = await loginTestUser({ baseUrl, nome: "admin-runner" });
  const r3 = await fetchCancelar(pedido3, sidAdmin, "admin override");
  const ok3 = r3.status === 200;
  console.log(`[${ok3 ? "PASS" : "FAIL"}] admin → cancelar V2 pedido: ${r3.status} (expected 200) body=${r3.body}`);
  if (!ok3) failures++;
  await sb.from("siso_pedidos").delete().eq("id", pedido3);

  // Caso 4: operador cancela pedido de V2 → 200 (warehouse fast-path)
  const pedido4 = await seedPedidoV2(sb, v2Id, v2nome);
  const sidOp = await loginTestUser({ baseUrl, nome: "op-runner" });
  const r4 = await fetchCancelar(pedido4, sidOp, "operador override");
  const ok4 = r4.status === 200;
  console.log(`[${ok4 ? "PASS" : "FAIL"}] operador → cancelar V2 pedido: ${r4.status} (expected 200) body=${r4.body}`);
  if (!ok4) failures++;
  await sb.from("siso_pedidos").delete().eq("id", pedido4);

  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
