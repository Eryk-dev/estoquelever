import "dotenv/config";
import { runAuthMatrix, printAuthMatrixReport } from "./runner";

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

// Use a stable fake UUID — the handler returns 200 with empty array for
// unknown pedidoIds, which is fine for the auth assertion (we only care
// about 401/403 vs anything else).
const FAKE_PEDIDO_ID = "00000000-0000-0000-0000-000000000000";

async function main() {
  const results = await runAuthMatrix({
    baseUrl,
    tests: [{
      name: "GET /api/wms/pedidos/[id]/historico requires pedidos.ver",
      method: "GET",
      path: `/api/wms/pedidos/${FAKE_PEDIDO_ID}/historico`,
      cases: [
        { label: "no session",     user: null,            expectedStatus: 401 },
        { label: "vendedor",       user: "vendor-runner", expectedStatus: 403 },
        { label: "comprador",      user: "buyer-runner",  expectedStatus: 200 },
        { label: "operador",       user: "op-runner",     expectedStatus: 200 },
        { label: "admin",          user: "admin-runner",  expectedStatus: 200 },
      ],
    }],
  });
  const ok = printAuthMatrixReport(results);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
