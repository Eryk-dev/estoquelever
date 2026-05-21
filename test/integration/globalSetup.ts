import { config as loadEnv } from "dotenv";
import { createServiceClient } from "../../src/lib/supabase-server";
import { truncateOperacional, seedInicial, validarStaging } from "../../scripts/wms/cenarios/_harness/seed";

export default async function setup() {
  loadEnv({ path: ".env.test", override: false });
  loadEnv({ path: ".env.test.local", override: true });
  validarStaging();
  const sb = createServiceClient();
  await truncateOperacional(sb);
  await seedInicial(sb);
  console.log("[integration setup] staging limpo + seed inicial OK");
}
