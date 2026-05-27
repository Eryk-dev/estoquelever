import "dotenv/config";
import { runAuthMatrix, printAuthMatrixReport } from "./runner";

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

async function main() {
  const results = await runAuthMatrix({
    baseUrl,
    tests: [{
      name: "GET inventario/metricas requires warehouse access",
      method: "GET",
      path: "/api/wms/inventario/metricas",
      cases: [
        { label: "no session", user: null,            expectedStatus: 401 },
        { label: "vendedor",   user: "vendor-runner", expectedStatus: 403 },
        { label: "comprador",  user: "buyer-runner",  expectedStatus: 403 },
        { label: "operador",   user: "op-runner",     expectedStatus: 200 },
        { label: "admin",      user: "admin-runner",  expectedStatus: 200 },
      ],
    }],
  });
  const ok = printAuthMatrixReport(results);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
