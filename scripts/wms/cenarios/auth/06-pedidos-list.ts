import "dotenv/config";
import { runAuthMatrix, printAuthMatrixReport } from "./runner";

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

async function main() {
  const results = await runAuthMatrix({
    baseUrl,
    tests: [
      {
        name: "GET /api/wms/pedidos requires pedidos.ver",
        method: "GET",
        path: "/api/wms/pedidos",
        cases: [
          { label: "no session",     user: null,             expectedStatus: 401 },
          { label: "vendedor (sem pedidos.ver)", user: "vendor-runner",  expectedStatus: 403 },
          { label: "comprador (com pedidos.ver)", user: "buyer-runner",  expectedStatus: 200 },
          { label: "operador (com pedidos.ver)",  user: "op-runner",     expectedStatus: 200 },
          { label: "admin (todas)",   user: "admin-runner",  expectedStatus: 200 },
        ],
      },
    ],
  });
  const ok = printAuthMatrixReport(results);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
