import { createServiceClient } from "@/lib/supabase-server";
import { getProdutoCompleto, getProdutoDetalhe } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { logger } from "@/lib/logger";

/**
 * Sincroniza um produto do siso_produtos com a versão atual no Tiny.
 * - Busca produto via Tiny API usando 1 mapeamento ativo qualquer
 * - Atualiza descricao, ncm, origem_fiscal, imagem_url, gtin, unidade
 * - Marca sincronizado_em = now()
 */
export async function sincronizarProduto(produtoId: string): Promise<void> {
  const sb = createServiceClient();

  const { data: produto, error: errProduto } = await sb
    .from("siso_produtos")
    .select("sku")
    .eq("id", produtoId)
    .maybeSingle();
  if (errProduto) throw errProduto;
  if (!produto) throw new Error("produto não encontrado");

  const { data: mapeamento, error } = await sb
    .from("siso_produto_empresas")
    .select("empresa_id, tiny_produto_id")
    .eq("produto_id", produtoId)
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!mapeamento) {
    logger.warn("wms.sync", "produto sem mapeamento Tiny ativo", { produtoId });
    return;
  }

  const { token } = await getValidTokenByEmpresa(mapeamento.empresa_id);

  const completo = await runWithEmpresa(mapeamento.empresa_id, () =>
    getProdutoCompleto(token, mapeamento.tiny_produto_id),
  );
  const detalhe = await runWithEmpresa(mapeamento.empresa_id, () =>
    getProdutoDetalhe(token, mapeamento.tiny_produto_id),
  );

  const patch: Record<string, unknown> = { sincronizado_em: new Date().toISOString() };
  if (completo.descricao) patch.descricao = completo.descricao;
  if (completo.gtin ?? detalhe.gtin) patch.gtin = completo.gtin ?? detalhe.gtin;
  if (completo.unidade) patch.unidade = completo.unidade;
  if (completo.ncm) patch.ncm = completo.ncm;
  if (completo.origem != null) patch.origem_fiscal = completo.origem;
  // Sempre persiste imagens[] (mesmo vazio — produto pode ter perdido
   // anexo no Tiny). imagem_url = primeira pra manter capa consistente
   // sem precisar mexer em todos os consumers de uma vez.
   patch.imagens = detalhe.imagens;
   patch.imagem_url = detalhe.imagemUrl;

  const { error: errUpdate } = await sb.from("siso_produtos").update(patch).eq("id", produtoId);
  if (errUpdate) throw errUpdate;
}

/**
 * Variante: cria produto no siso_produtos se não existir, dado SKU + Tiny empresa+id.
 * Retorna o id do produto (criado ou existente).
 */
export async function ensureProdutoFromTiny(
  sku: string,
  empresaId: string,
  tinyProdutoId: number,
): Promise<string> {
  const sb = createServiceClient();

  const { data: existente } = await sb
    .from("siso_produtos")
    .select("id")
    .eq("sku", sku)
    .maybeSingle();
  if (existente) {
    await sb
      .from("siso_produto_empresas")
      .upsert(
        { produto_id: existente.id, empresa_id: empresaId, tiny_produto_id: tinyProdutoId },
        { onConflict: "produto_id,empresa_id" },
      );
    return existente.id;
  }

  const { data: novo, error } = await sb
    .from("siso_produtos")
    .insert({ sku, descricao: `(aguardando sync) ${sku}` })
    .select("id")
    .single();
  if (error || !novo) throw error ?? new Error("falha ao criar produto");

  await sb
    .from("siso_produto_empresas")
    .insert({ produto_id: novo.id, empresa_id: empresaId, tiny_produto_id: tinyProdutoId });

  await sincronizarProduto(novo.id);
  return novo.id;
}
