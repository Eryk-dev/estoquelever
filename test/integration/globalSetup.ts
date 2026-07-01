import { config as loadEnv } from "dotenv";
import { createServiceClient } from "../../src/lib/supabase-server";
import { seedInicial, validarStaging } from "../../scripts/wms/cenarios/_harness/seed";

/**
 * Setup NÃO-DESTRUTIVO. O staging é ambiente VIVO (pedidos reais) — NUNCA
 * truncamos. Cada teste é auto-contido e isolado: cria seus próprios fixtures
 * com id/SKU único (ex.: `TEST-…-${random}`), asserta SÓ nos próprios dados, e
 * limpa o que criou (afterAll/afterEach). Aqui só garantimos que os fixtures
 * COMPARTILHADOS existem (galpões CWB/SP, locs, test-runner, prefs) via
 * seedInicial, que é idempotente (upsert, não apaga nada).
 */
export default async function setup() {
  loadEnv({ path: ".env.test", override: false });
  loadEnv({ path: ".env.test.local", override: true });
  validarStaging();
  const sb = createServiceClient();
  await seedInicial(sb);
  console.log("[integration setup] fixtures compartilhados garantidos (sem truncate)");
}
