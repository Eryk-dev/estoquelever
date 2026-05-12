/**
 * Onda 2 — fake-webhook: dispara UM cenário sintético.
 *
 * Uso:
 *   npm run fake:webhook -- propria-auto-1
 *   npm run fake:webhook -- propria-auto-1 --base http://localhost:3000
 *   npm run fake:webhook -- cancel-pre-1 --cancelar
 *
 * Fluxo:
 *   1. Procura cenário em CENARIOS
 *   2. UPSERT payload Tiny-shape em siso_stub_pedidos (pra getPedido stub responder)
 *   3. POST /api/webhook/tiny com trigger payload
 *   4. (opcional) Espera N segundos e dispara webhook de cancelamento
 *
 * Pré-requisito: `npm run dev` rodando em outra aba com TINY_DISABLED=true.
 */

import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { CENARIOS, buildWebhookPayload, buildPedidoFullPayload } from "./cenarios";

function parseArgs() {
  const args = process.argv.slice(2);
  const cenarioId = args[0];
  if (!cenarioId) {
    console.error("Uso: npm run fake:webhook -- <cenario-id> [--base URL] [--cancelar]");
    console.error("Cenários disponíveis:");
    for (const c of CENARIOS) console.error(`  ${c.id} — ${c.descricao}`);
    process.exit(1);
  }
  const baseIdx = args.indexOf("--base");
  const base =
    baseIdx >= 0 && args[baseIdx + 1]
      ? args[baseIdx + 1]
      : process.env.WEBHOOK_BASE_URL ?? "http://localhost:3000";
  const cancelar = args.includes("--cancelar");
  return { cenarioId, base, cancelar };
}

export async function dispararCenario(
  cenarioId: string,
  base: string,
  cancelar: boolean = false,
): Promise<{ ok: boolean; status: string; pedidoId: string }> {
  const cenario = CENARIOS.find((c) => c.id === cenarioId);
  if (!cenario) throw new Error(`Cenário '${cenarioId}' não encontrado`);

  const sb = createServiceClient();
  const pedidoFull = buildPedidoFullPayload(cenario);

  // 1. UPSERT em siso_stub_pedidos pra o stub do getPedido encontrar
  const { error: upsertErr } = await sb.from("siso_stub_pedidos").upsert(
    {
      id: cenario.pedidoTinyId,
      empresa_id: pedidoFull._empresa_origem_id,
      payload: pedidoFull,
      cenario: cenario.id,
    },
    { onConflict: "id" },
  );
  if (upsertErr) {
    throw new Error(`Falha ao gravar stub_pedido: ${upsertErr.message}`);
  }

  // 2. POST /api/webhook/tiny
  const trigger = buildWebhookPayload(cenario, cancelar ? "cancelado" : "aprovado");
  const url = `${base}/api/webhook/tiny`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(trigger),
  });

  const bodyText = await res.text();
  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(bodyText);
  } catch {
    bodyJson = bodyText;
  }

  if (!res.ok) {
    console.error(`  ❌ ${cenario.id}: HTTP ${res.status}`, bodyJson);
    return { ok: false, status: String(res.status), pedidoId: cenario.pedidoTinyId };
  }

  const status = (bodyJson as { status?: string })?.status ?? "ok";
  return { ok: true, status, pedidoId: cenario.pedidoTinyId };
}

async function main() {
  const { cenarioId, base, cancelar } = parseArgs();
  console.log(`→ Disparando ${cenarioId} (cancelar=${cancelar}) em ${base}`);
  const r = await dispararCenario(cenarioId, base, cancelar);
  console.log(`✓ status=${r.status} pedido=${r.pedidoId}`);
}

// Permite import sem rodar (usado por seed-cenarios.ts)
if (process.argv[1]?.endsWith("fake-webhook.ts")) {
  main().catch((err) => {
    console.error("\n💥", err);
    process.exit(1);
  });
}
