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
      name: "POST lancamento-retroativo requires operacoes.retroativo",
      method: "POST",
      path: "/api/wms/lancamento-retroativo",
      body: {
        tripla: { produto_id: FAKE, galpao_id: FAKE, localizacao_id: FAKE },
        qty: 1,
        motivo: "auth test",
      },
      cases: [
        { label: "no session", user: null,            expectedStatus: 401 },
        { label: "vendedor",   user: "vendor-runner", expectedStatus: 403 },
        { label: "comprador",  user: "buyer-runner",  expectedStatus: 403 },
        // operador + admin têm operacoes.retroativo (seed em Task 4) →
        // passa perm gate, body referencia fake ids → 400/500 (lib quebra
        // ao inserir mov com produto/galpao/loc inexistente).
        { label: "operador (passa perm; ids fake)", user: "op-runner",     expectedStatus: 500 },
        { label: "admin (passa perm; ids fake)",    user: "admin-runner",  expectedStatus: 500 },
      ],
    }],
  });
  const ok = printAuthMatrixReport(results);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
