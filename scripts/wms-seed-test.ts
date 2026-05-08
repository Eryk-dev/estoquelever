// Cria 1 produto + 1 mapeamento + 1 mov inventario_inicial pra validar pipeline.
import "dotenv/config";
import { createServiceClient } from "../src/lib/supabase-server";
import { inserirMovimentacao } from "../src/lib/wms/ledger";

async function main() {
  const sb = createServiceClient();

  const { data: empresa } = await sb
    .from("siso_empresas")
    .select("id, galpao_id")
    .limit(1)
    .single();
  if (!empresa) throw new Error("nenhuma empresa cadastrada");

  const { data: loc } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", empresa.galpao_id)
    .eq("codigo", "DEFAULT-PICKING")
    .single();
  if (!loc) throw new Error("DEFAULT-PICKING não existe no galpão da empresa");

  const sku = `WMS-SEED-${Date.now()}`;
  const { data: produto } = await sb
    .from("siso_produtos")
    .insert({ sku, descricao: "Produto de seed pra validar pipeline" })
    .select()
    .single();
  if (!produto) throw new Error("falha ao criar produto");

  await sb.from("siso_produto_empresas").insert({
    produto_id: produto.id,
    empresa_id: empresa.id,
    tiny_produto_id: 999999999,
  });

  await inserirMovimentacao({
    quadrupla: {
      produto_id: produto.id,
      empresa_dona_id: empresa.id,
      galpao_id: empresa.galpao_id,
      localizacao_id: loc.id,
    },
    tipo: "E",
    qty: 100,
    origem_tipo: "inventario_inicial",
    observacoes: "seed teste",
  });

  console.log("seed criado:", { produto_id: produto.id, sku });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
