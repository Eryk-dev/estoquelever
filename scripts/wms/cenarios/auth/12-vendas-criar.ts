import "dotenv/config";
import { runAuthMatrix, printAuthMatrixReport } from "./runner";

const baseUrl = process.env.AUTH_BASE_URL ?? "http://localhost:3001";

async function main() {
  const results = await runAuthMatrix({
    baseUrl,
    tests: [{
      name: "POST vendas/criar requires vendas.criar",
      method: "POST",
      path: "/api/wms/vendas/criar",
      // minimal body: server will likely 400 on missing fields, which
      // is fine — we only assert 401/403 are blocked, and 400 means
      // perm gate passed.
      body: {
        cliente_nome: "Auth Test",
        cliente_cpf_cnpj: null,
        canal_venda: "balcao",
        empresa_origem_id: "00000000-0000-0000-0000-000000000000",
        galpao_id: "00000000-0000-0000-0000-000000000000",
        modo: "separacao",
        items: [],
      },
      cases: [
        { label: "no session", user: null,            expectedStatus: 401 },
        { label: "operador (sem vendas.criar)",  user: "op-runner",     expectedStatus: 403 },
        { label: "comprador (sem vendas.criar)", user: "buyer-runner",  expectedStatus: 403 },
        // vendedor + admin têm vendas.criar → passa perm gate; body
        // inválido (items vazio) → 400.
        { label: "vendedor (passa perm; body inválido)", user: "vendor-runner", expectedStatus: 400 },
        { label: "admin (passa perm; body inválido)",    user: "admin-runner",  expectedStatus: 400 },
      ],
    }],
  });
  const ok = printAuthMatrixReport(results);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
