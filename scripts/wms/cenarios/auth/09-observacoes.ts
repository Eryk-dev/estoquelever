import "dotenv/config";
import { runAuthMatrix, printAuthMatrixReport } from "./runner";

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";
const FAKE = "00000000-0000-0000-0000-000000000000";

async function main() {
  const results = await runAuthMatrix({
    baseUrl,
    tests: [
      {
        name: "GET observações requires pedidos.ver",
        method: "GET",
        path: `/api/wms/pedidos/${FAKE}/observacoes`,
        cases: [
          { label: "no session", user: null,            expectedStatus: 401 },
          { label: "vendedor",   user: "vendor-runner", expectedStatus: 403 },
          { label: "comprador",  user: "buyer-runner",  expectedStatus: 200 },
          { label: "admin",      user: "admin-runner",  expectedStatus: 200 },
        ],
      },
      {
        name: "POST observações requires pedidos.ver",
        method: "POST",
        path: `/api/wms/pedidos/${FAKE}/observacoes`,
        // Body uses the session user's own id+nome — server should ignore
        // body usuarioId mismatch (we'll add that check in the impl).
        bodyFor: (user) => ({
          usuarioId: "irrelevant", // server overrides with session.user.id
          usuarioNome: "irrelevant",
          texto: `auth test ${user ?? "anon"} ${Date.now()}`,
        }),
        cases: [
          { label: "no session", user: null,            expectedStatus: 401 },
          { label: "vendedor",   user: "vendor-runner", expectedStatus: 403 },
          // Admin com pedido fake → row tem que ser criada (FK pedido_id é
          // text? No — é uuid. UUID fake é válido pelo formato; insert
          // tentará FK lookup que pode 500. Esperamos 500 OU 200 (não 401/403).
          // O assertion da matrix só cobre status estrito; pra esse caso
          // usamos 500 (insert fails on FK).
          { label: "admin (fake pedidoId → FK fails)", user: "admin-runner",  expectedStatus: 500 },
        ],
      },
    ],
  });
  const ok = printAuthMatrixReport(results);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
