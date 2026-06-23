// Inspeciona o detalhe de um produto no Tiny (debug ad hoc).
// Uso: npx tsx scripts/inspect-tiny-produto.ts <produto_id_wms_uuid>
import "dotenv/config";
import { createServiceClient } from "../src/lib/supabase-server";
import { getValidTokenByEmpresa } from "../src/lib/tiny-oauth";
import { getProdutoFull } from "../src/lib/tiny-api";

async function main() {
  const produtoId = process.argv[2];
  if (!produtoId) {
    console.error("uso: npx tsx scripts/inspect-tiny-produto.ts <produto_id>");
    process.exit(1);
  }
  const sb = createServiceClient();
  const { data: pe } = await sb
    .from("siso_produto_empresas")
    .select("tiny_produto_id, empresa_id, empresa:siso_empresas(nome)")
    .eq("produto_id", produtoId)
    .limit(1)
    .maybeSingle();
  if (!pe) {
    console.error("produto não mapeado em nenhuma empresa");
    return;
  }
  type Row = { tiny_produto_id: number; empresa_id: string; empresa: { nome: string } | { nome: string }[] | null };
  const row = pe as unknown as Row;
  const empNome = Array.isArray(row.empresa) ? row.empresa[0]?.nome : row.empresa?.nome;
  console.log("tiny_produto_id:", row.tiny_produto_id);
  console.log("empresa:", empNome);
  const { token } = await getValidTokenByEmpresa(row.empresa_id);
  const detalhe = await getProdutoFull(token, Number(row.tiny_produto_id));
  console.log("tipo:", detalhe.tipo);
  console.log("sku:", detalhe.sku);
  console.log("descricao:", detalhe.descricao);
  console.log("kit length:", detalhe.kit.length);
  console.log("kit:", JSON.stringify(detalhe.kit, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
