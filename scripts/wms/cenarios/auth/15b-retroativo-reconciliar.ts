import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { runAuthMatrix, printAuthMatrixReport } from "./runner";

loadEnv({ path: ".env.test", override: false });
loadEnv({ path: ".env.test.local", override: true });

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";
const FAKE = "00000000-0000-0000-0000-000000000000";

async function main() {
  const results = await runAuthMatrix({
    baseUrl,
    tests: [{
      name: "POST retroativo/reconciliar requires operacoes.retroativo",
      method: "POST",
      path: `/api/wms/lancamento-retroativo/${FAKE}/reconciliar`,
      body: { compra_mov_id: FAKE },
      cases: [
        { label: "no session", user: null,            expectedStatus: 401 },
        { label: "vendedor",   user: "vendor-runner", expectedStatus: 403 },
        { label: "comprador",  user: "buyer-runner",  expectedStatus: 403 },
        // operador + admin → perm gate passa; fake ids → 400 (rpc rejeita).
        { label: "operador (passa; ids fake)", user: "op-runner",     expectedStatus: 400 },
        { label: "admin (passa; ids fake)",    user: "admin-runner",  expectedStatus: 400 },
      ],
    }],
  });
  const ok = printAuthMatrixReport(results);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
