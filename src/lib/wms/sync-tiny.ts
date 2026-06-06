import { createServiceClient } from "@/lib/supabase-server";
import { getProdutoFull } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { logger } from "@/lib/logger";
import {
  ensureFornecedorTiny,
  upsertProdutoFornecedor,
} from "@/lib/wms/fornecedores";

interface SincronizarOptions {
  /**
   * Quando informado, força usar o mapeamento dessa empresa em vez do
   * primeiro disponível. Necessário pra backfill paralelo splitando trabalho
   * entre empresas (cada thread atua só na sua).
   */
  preferEmpresaId?: string;
}

/**
 * P120: decide eh_kit pro sync. Tiny tipo=K só vira eh_kit=true se já houver
 * composição cadastrada em siso_produto_kits — o trigger wms_kit_exige_componente
 * rejeita kit sem componente. Sem composição, fica false até alguém cadastrar.
 */
export async function resolverEhKitSync(
  sb: ReturnType<typeof createServiceClient>,
  produtoId: string,
  tinyTipo: string | null | undefined,
): Promise<boolean> {
  if (tinyTipo !== "K") return false;
  const { count } = await sb
    .from("siso_produto_kits")
    .select("id", { count: "exact", head: true })
    .eq("kit_produto_id", produtoId);
  return (count ?? 0) > 0;
}

/**
 * Sincroniza um produto do siso_produtos com a versão atual no Tiny.
 * - Busca produto via Tiny API usando 1 mapeamento ativo (ou o de `preferEmpresaId`)
 * - Atualiza descricao, ncm, origem_fiscal, imagem_url, imagens[], gtin, unidade
 * - Persiste fornecedores em siso_produto_fornecedores com codigo_fornecedor
 * - Persiste composição de kit (Tiny tipo=K) em siso_produto_kits e marca eh_kit
 * - Marca sincronizado_em = now()
 */
export async function sincronizarProduto(
  produtoId: string,
  opts: SincronizarOptions = {},
): Promise<void> {
  const sb = createServiceClient();

  const { data: produto, error: errProduto } = await sb
    .from("siso_produtos")
    .select("sku")
    .eq("id", produtoId)
    .maybeSingle();
  if (errProduto) throw errProduto;
  if (!produto) throw new Error("produto não encontrado");

  let mapeamentoQuery = sb
    .from("siso_produto_empresas")
    .select("empresa_id, tiny_produto_id")
    .eq("produto_id", produtoId)
    .eq("ativo", true);
  if (opts.preferEmpresaId) {
    mapeamentoQuery = mapeamentoQuery.eq("empresa_id", opts.preferEmpresaId);
  }
  const { data: mapeamento, error } = await mapeamentoQuery
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!mapeamento) {
    logger.warn("wms.sync", "produto sem mapeamento Tiny ativo", {
      produtoId,
      preferEmpresaId: opts.preferEmpresaId,
    });
    return;
  }

  const { token } = await getValidTokenByEmpresa(mapeamento.empresa_id);

  const full = await runWithEmpresa(mapeamento.empresa_id, () =>
    getProdutoFull(token, mapeamento.tiny_produto_id),
  );

  const patch: Record<string, unknown> = {
    sincronizado_em: new Date().toISOString(),
  };
  if (full.descricao) patch.descricao = full.descricao;
  if (full.gtin) patch.gtin = full.gtin;
  if (full.unidade) patch.unidade = full.unidade;
  if (full.ncm) patch.ncm = full.ncm;
  // origem pode vir como "" do Tiny — protege smallint.
  if (full.origem != null && full.origem !== ("" as unknown)) {
    const origemNum = Number(full.origem);
    if (Number.isInteger(origemNum)) patch.origem_fiscal = origemNum;
  }
  // Sempre persiste imagens[] (mesmo vazio — produto pode ter perdido
  // anexo no Tiny). imagem_url = primeira pra manter capa consistente.
  patch.imagens = full.imagens;
  patch.imagem_url = full.imagemUrl;
  // tipo=K vira eh_kit=true só com composição existente (P120) — o trigger
  // wms_kit_exige_componente rejeita kit sem componente.
  patch.eh_kit = await resolverEhKitSync(sb, produtoId, full.tipo);

  const { error: errUpdate } = await sb
    .from("siso_produtos")
    .update(patch)
    .eq("id", produtoId);
  if (errUpdate) throw errUpdate;

  // ── Fornecedores ──
  // Tiny não devolve `padrao` no response (só no request), então não temos
  // como saber qual é o preferencial. Marcamos o primeiro como preferencial
  // só quando é o único cadastrado pro produto (heurística simples).
  for (let i = 0; i < full.fornecedores.length; i++) {
    const f = full.fornecedores[i];
    try {
      const fornecedor = await ensureFornecedorTiny({
        tiny_fornecedor_id: f.id,
        nome: f.nome,
      });
      await upsertProdutoFornecedor({
        produto_id: produtoId,
        fornecedor_id: fornecedor.id,
        codigo_fornecedor: f.codigoProdutoNoFornecedor,
        custo_unitario: full.precos?.precoCusto ?? null,
        preferencial: i === 0 && full.fornecedores.length === 1,
      });
    } catch (e) {
      logger.warn("wms.sync.fornecedor", "falha ao persistir fornecedor", {
        produtoId,
        tiny_fornecedor_id: f.id,
        nome: f.nome,
        erro: (e as Error).message,
      });
    }
  }

  // ── Kit (apenas se Tiny disser que é tipo=K) ──
  if (full.tipo === "K" && full.kit.length > 0) {
    await sincronizarComposicaoKit(produtoId, full.kit, mapeamento.empresa_id);
  }
}

/**
 * Persiste a composição de kit a partir do que o Tiny retornou. Resolve cada
 * componente pelo SKU no catálogo local (tem que já existir — esperado, já que
 * o bulk import cobre tudo). Componentes não-encontrados são logados.
 */
async function sincronizarComposicaoKit(
  kitProdutoId: string,
  kitItems: Array<{
    produto: { id: number; sku: string | null; descricao: string | null };
    quantidade: number;
  }>,
  empresaId: string,
): Promise<void> {
  const sb = createServiceClient();
  // Tenta resolver cada componente pelo tiny_produto_id (mais robusto que SKU).
  const tinyIds = kitItems.map((k) => k.produto.id);
  const { data: mapeamentos } = await sb
    .from("siso_produto_empresas")
    .select("produto_id, tiny_produto_id")
    .eq("empresa_id", empresaId)
    .in("tiny_produto_id", tinyIds);

  const idPorTiny = new Map<number, string>(
    (mapeamentos ?? []).map((m) => [
      Number((m as { tiny_produto_id: number }).tiny_produto_id),
      (m as { produto_id: string }).produto_id,
    ]),
  );

  // Limpa composição anterior antes de re-inserir — fonte da verdade é o Tiny
  // pra sync (manual edits são sobrescritas, como o usuário pediu).
  const { error: errDel } = await sb
    .from("siso_produto_kits")
    .delete()
    .eq("kit_produto_id", kitProdutoId);
  if (errDel) {
    logger.warn("wms.sync.kit", "falha ao limpar composição anterior", {
      kitProdutoId,
      erro: errDel.message,
    });
    return;
  }

  const linhas: Array<{
    kit_produto_id: string;
    componente_produto_id: string;
    quantidade: number;
  }> = [];
  for (const item of kitItems) {
    const componenteId = idPorTiny.get(item.produto.id);
    if (!componenteId) {
      logger.warn("wms.sync.kit", "componente não encontrado no catálogo", {
        kitProdutoId,
        tiny_componente_id: item.produto.id,
        sku: item.produto.sku,
      });
      continue;
    }
    if (componenteId === kitProdutoId) {
      // Anti-recursão (defesa redundante — trigger no DB também rejeita).
      continue;
    }
    linhas.push({
      kit_produto_id: kitProdutoId,
      componente_produto_id: componenteId,
      quantidade: item.quantidade,
    });
  }

  if (linhas.length === 0) return;

  const { error: errIns } = await sb.from("siso_produto_kits").insert(linhas);
  if (errIns) {
    logger.warn("wms.sync.kit", "falha ao inserir composição", {
      kitProdutoId,
      erro: errIns.message,
    });
  }
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
