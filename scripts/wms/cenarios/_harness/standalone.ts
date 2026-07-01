import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { randomUUID } from "crypto";
import { createServiceClient } from "../../../../src/lib/supabase-server";
import type { Cenario } from "./types";
import { createContext } from "./context";
import { createHttp } from "./http";
import { seedInicial } from "./seed";
import { loginTestRunner, waitForHealth } from "./dev-server";
import { rodarInvariantes } from "./invariantes";

export async function runStandalone(cenario: Cenario): Promise<void> {
  loadEnv({ path: ".env.test", override: false });
  loadEnv({ path: ".env.test.local", override: true });

  const baseUrl = process.env.TEST_RUNNER_BASE_URL ?? "http://localhost:3001";
  const nome = process.env.TEST_RUNNER_NOME ?? "test-runner";
  const pin = process.env.TEST_RUNNER_PIN ?? "9999";

  console.log(`[standalone] ${cenario.nome}`);
  console.log(`[standalone] esperando dev server em ${baseUrl} ...`);
  await waitForHealth(`${baseUrl}/api/auth/me`, { timeout_ms: 15_000 });

  const sb = createServiceClient();
  // NÃO-DESTRUTIVO (staging vivo): só garante fixtures compartilhados.
  console.log(`[standalone] garantir fixtures (sem truncate)`);
  const staging = await seedInicial(sb);

  console.log(`[standalone] login`);
  const sessionId = await loginTestRunner({ baseUrl, nome, pin });

  const correlationId = randomUUID();
  const http = createHttp({ baseUrl, sessionId, correlationId });
  const ctx = createContext({ sb, http, staging, correlationId });

  const t0 = Date.now();
  try {
    const setupData = await cenario.setup(ctx);
    await cenario.run(ctx, setupData);
    await cenario.assertEsperado(ctx, setupData);
    const invs = await rodarInvariantes(sb);
    const falhas = invs.filter((i) => !i.ok);
    if (falhas.length > 0) {
      console.error(`[standalone] ❌ ${cenario.nome} — invariantes falhando:`);
      for (const f of falhas) console.error(`  - ${f.nome}: ${JSON.stringify(f.detalhes)}`);
      process.exit(1);
    }
    console.log(`[standalone] ✅ ${cenario.nome} (${Date.now() - t0}ms)`);
  } catch (err) {
    console.error(`[standalone] ❌ ${cenario.nome}:`);
    console.error(err);
    process.exit(1);
  }
}
