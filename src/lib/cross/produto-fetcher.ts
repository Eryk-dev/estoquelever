import { createServiceClient } from "@/lib/supabase-server";
import { buscarProdutoPorSku, getProdutoDetalhe } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";
import { extrairOEMs } from "@/lib/cross/oem-extractor";
import { logger } from "@/lib/logger";

export interface FetchProdutoResult {
  sku: string;
  tiny_id: number;
  nome: string;
  descricao: string | null;
  fornecedor: string | null;
  imagem_url: string | null;
  gtin: string | null;
  oems_extraidos: string[];
}

export class TinyOfflineError extends Error {
  constructor(message = "Tiny indisponível, tente em alguns minutos") {
    super(message);
    this.name = "TinyOfflineError";
  }
}

export class ProdutoNaoEncontradoError extends Error {
  constructor(sku: string) {
    super(`SKU "${sku}" não encontrado no Tiny`);
    this.name = "ProdutoNaoEncontradoError";
  }
}

/**
 * Busca um SKU no Tiny da empresa indicada e retorna dados normalizados.
 * Lança ProdutoNaoEncontradoError se SKU não existir.
 * Lança TinyOfflineError em caso de falha de rede/auth.
 */
export async function fetchProdutoFromTiny(
  sku: string,
  empresaId: string,
): Promise<FetchProdutoResult> {
  let token: string;
  try {
    const tokenResult = await getValidTokenByEmpresa(empresaId);
    token = tokenResult.token;
  } catch (err) {
    logger.warn("cross-fetcher", "Falha ao obter token Tiny", {
      sku,
      empresaId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new TinyOfflineError();
  }

  let produto: Awaited<ReturnType<typeof buscarProdutoPorSku>>;
  try {
    produto = await runWithEmpresa(empresaId, () =>
      buscarProdutoPorSku(token, sku),
    );
  } catch (err) {
    logger.warn("cross-fetcher", "Falha ao buscar produto no Tiny", {
      sku,
      empresaId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new TinyOfflineError();
  }

  if (!produto) {
    throw new ProdutoNaoEncontradoError(sku);
  }

  let detalhe: Awaited<ReturnType<typeof getProdutoDetalhe>> | null = null;
  try {
    detalhe = await runWithEmpresa(empresaId, () =>
      getProdutoDetalhe(token, produto!.id),
    );
  } catch (err) {
    logger.warn("cross-fetcher", "Falha em getProdutoDetalhe (não crítico)", {
      sku,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Prefer descricaoComplementar (full, with OEMs); fall back to short product name
  const descricaoCompleta = detalhe?.descricaoComplementar ?? produto.descricao ?? null;
  const oemsExtraidos = extrairOEMs(descricaoCompleta);
  const fornecedor = getFornecedorBySku(sku).fornecedor ?? null;

  return {
    sku: produto.codigo,
    tiny_id: produto.id,
    nome: produto.descricao || sku,
    descricao: descricaoCompleta,
    fornecedor,
    imagem_url: detalhe?.imagemUrl ?? null,
    gtin: detalhe?.gtin ?? null,
    oems_extraidos: oemsExtraidos,
  };
}

/**
 * Persiste um produto vindo do Tiny no catálogo Cross.
 * Faz upsert em siso_produtos_catalogo.
 * Insere OEMs extraídos em siso_produto_oems com origem='extracao_tiny'
 * (idempotente — UNIQUE(produto_sku, oem_code) impede duplicatas).
 *
 * Política: NUNCA remove OEMs já existentes. Apenas adiciona novos.
 */
export async function persistProdutoNoCatalogo(
  produto: FetchProdutoResult,
): Promise<void> {
  const supabase = createServiceClient();

  const { error: upsertErr } = await supabase
    .from("siso_produtos_catalogo")
    .upsert(
      {
        sku: produto.sku,
        tiny_id: produto.tiny_id,
        nome: produto.nome,
        descricao: produto.descricao,
        fornecedor: produto.fornecedor,
        imagem_url: produto.imagem_url,
        gtin: produto.gtin,
        sincronizado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      },
      { onConflict: "sku" },
    );

  if (upsertErr) {
    throw new Error(`Erro ao salvar produto: ${upsertErr.message}`);
  }

  if (produto.oems_extraidos.length > 0) {
    const rows = produto.oems_extraidos.map((codigo) => ({
      produto_sku: produto.sku,
      oem_code: codigo,
      origem: "extracao_tiny" as const,
      adicionado_por: null,
    }));

    const { error: oemErr } = await supabase
      .from("siso_produto_oems")
      .upsert(rows, { onConflict: "produto_sku,oem_code", ignoreDuplicates: true });

    if (oemErr) {
      logger.warn("cross-fetcher", "Falha ao inserir OEMs", {
        sku: produto.sku,
        error: oemErr.message,
      });
    }
  }
}

/**
 * Busca + persiste em uma chamada. Usado pelo lazy fetch e pelo refetch manual.
 */
export async function fetchAndPersistProduto(
  sku: string,
  empresaId: string,
): Promise<void> {
  const produto = await fetchProdutoFromTiny(sku, empresaId);
  await persistProdutoNoCatalogo(produto);
}
