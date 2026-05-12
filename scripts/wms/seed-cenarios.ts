/**
 * Onda 2 — seed-cenarios: dispara TODOS os cenários em sequência.
 *
 * Estratégia:
 *   - Roda cenários "normais" (não-cancelados) em ordem
 *   - Para cenários `cancelarApos: pre-separado`: dispara aprovado + cancela imediatamente
 *   - Para `cancelarApos: pos-separado`: dispara aprovado + aguarda processamento + cancela
 *
 * Pré-requisito: `npm run dev` rodando com TINY_DISABLED=true.
 *
 * Uso:
 *   npm run seed:cenarios
 *   npm run seed:cenarios -- --base http://localhost:3000
 */

import "dotenv/config";
import { CENARIOS } from "./cenarios";
import { dispararCenario } from "./fake-webhook";

function getBase(): string {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf("--base");
  if (baseIdx >= 0 && args[baseIdx + 1]) return args[baseIdx + 1];
  return process.env.WEBHOOK_BASE_URL ?? "http://localhost:3000";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const base = getBase();
  console.log("=".repeat(60));
  console.log(`  Disparando ${CENARIOS.length} cenários em ${base}`);
  console.log("=".repeat(60));

  const summary: Array<{ id: string; status: string; ok: boolean }> = [];

  for (const cenario of CENARIOS) {
    // Disparar aprovação
    const r = await dispararCenario(cenario.id, base, false);
    summary.push({ id: cenario.id, status: r.status, ok: r.ok });
    console.log(`  ${r.ok ? "✓" : "✗"} ${cenario.id.padEnd(22)} → ${r.status}`);

    // Throttling pra não saturar processWebhook async
    await sleep(800);

    // Cancelamento se configurado
    if (cenario.cancelarApos === "pre-separado") {
      await sleep(3_500); // dá tempo do processWebhook (assíncrono) gravar pedido
      const rc = await dispararCenario(cenario.id, base, true);
      summary.push({ id: `${cenario.id} (cancel)`, status: rc.status, ok: rc.ok });
      console.log(
        `  ${rc.ok ? "✓" : "✗"} ${(cenario.id + " (cancel)").padEnd(22)} → ${rc.status}`,
      );
      await sleep(500);
    }

    if (cenario.cancelarApos === "pos-separado") {
      // Aguarda processamento até o estado "concluido" ou similar (poll simples)
      await sleep(4_000);
      const rc = await dispararCenario(cenario.id, base, true);
      summary.push({ id: `${cenario.id} (cancel-pos)`, status: rc.status, ok: rc.ok });
      console.log(
        `  ${rc.ok ? "✓" : "✗"} ${(cenario.id + " (cancel-pos)").padEnd(22)} → ${rc.status}`,
      );
      await sleep(500);
    }
  }

  const okCount = summary.filter((s) => s.ok).length;
  console.log("\n— Resumo —");
  console.log(`  ${okCount}/${summary.length} disparos OK`);
  console.log("\n✅ Aguarde 5-10s pro processWebhook async terminar, depois rode:");
  console.log("   npm run verificar:saldos\n");
}

main().catch((err) => {
  console.error("\n💥", err);
  process.exit(1);
});
