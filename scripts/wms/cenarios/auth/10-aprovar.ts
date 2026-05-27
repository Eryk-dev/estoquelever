import "dotenv/config";
import { runAuthMatrix, printAuthMatrixReport } from "./runner";

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

async function main() {
  const results = await runAuthMatrix({
    baseUrl,
    tests: [{
      name: "POST aprovar requires pedidos.aprovar",
      method: "POST",
      path: "/api/wms/pedidos/aprovar",
      // Pass body with missing pedidoId — server reaches the perm check
      // before validating body, so 401/403 fires first; the "right perm"
      // case falls through to body validation (400).
      body: { pedidoId: "00000000-0000-0000-0000-000000000000", decisao: "propria" },
      cases: [
        { label: "no session", user: null,            expectedStatus: 401 },
        { label: "vendedor",   user: "vendor-runner", expectedStatus: 403 },
        { label: "comprador",  user: "buyer-runner",  expectedStatus: 403 },
        // operador + admin têm pedidos.aprovar → pass perm gate; pedido
        // fake → handler retorna 404 (não encontrado). Esperamos 404,
        // NÃO 401/403.
        { label: "operador (passa perm; pedido fake)", user: "op-runner",     expectedStatus: 404 },
        { label: "admin (passa perm; pedido fake)",    user: "admin-runner",  expectedStatus: 404 },
      ],
    }],
  });
  const ok = printAuthMatrixReport(results);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
