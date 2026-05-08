// Seed idempotente de fornecedores baseado no mapeamento canônico
// alinhado com src/lib/sku-fornecedor.ts.
//
// Uso: npx tsx scripts/wms-seed-fornecedores.ts
// Requer .env.local com NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
import "dotenv/config";
import { autoCriarFornecedoresDosPrefixosSku } from "../src/lib/wms/fornecedores";

async function main() {
  const result = await autoCriarFornecedoresDosPrefixosSku();
  console.log(
    `✓ ${result.criados} fornecedores criados, ${result.existentes} já existiam.`,
  );
  console.log(
    "\nLead times: preencha manualmente em /wms/fornecedores depois.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
