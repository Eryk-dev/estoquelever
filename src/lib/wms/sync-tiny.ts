import { createServiceClient } from "@/lib/supabase-server";
import { getProdutoFull, buscarProdutoPorSku } from "@/lib/tiny-api";
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
  // ── Kit: sincroniza a composição ANTES de resolver eh_kit ──
  // resolverEhKitSync só marca eh_kit=true se já houver composição cadastrada;
  // logo a composição precisa ser inserida primeiro — senão um kit novo (órfão)
  // viria como eh_kit=false e exigiria uma 2ª sync pra convergir.
  if (full.tipo === "K" && full.kit.length > 0) {
    await sincronizarComposicaoKit(produtoId, full.kit, mapeamento.empresa_id);
  }
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

/**
 * Resolve o produto FÍSICO (uuid `siso_produtos`) de um item de pedido — base do
 * pick/reserva/baixa. Estratégia SKU-first (o estoque/ledger é por uuid, e
 * `siso_produtos.sku` é UNIQUE → SKU ↔ uuid é 1:1; o tiny_produto_id é só ponte
 * de entrada e varia por empresa):
 *
 *   1. Substituto de troca (uuid direto) — quando a troca foi aprovada.
 *   2. SKU no catálogo (`siso_produtos.sku == item.sku`) — PRIMÁRIO. Cobre
 *      `produto_id=0` (item sem vínculo Tiny) e ponte ausente numa só consulta.
 *      Premissa do domínio: SKU do anúncio == SKU do catálogo (confirmado), logo
 *      o SKU é confiável.
 *   3. Ponte tiny_id (`siso_produto_empresas`) — FALLBACK pra item sem SKU mas
 *      com produto Tiny mapeado (comportamento legado).
 *   4. Auto-provisão do Tiny — produto ainda não está no catálogo: com tiny_id
 *      puxa por id, sem tiny_id (`produto_id=0`) busca no Tiny da empresa pelo
 *      SKU (`buscarProdutoPorSku`); cria e re-consulta o catálogo por SKU.
 *
 * Sem SKU e sem ponte resolvível → lança (item exige resolução humana via
 * `definir-sku` na aba Pedidos — ex.: linha sem SKU / "VERIFICAR LADO").
 * NÃO re-roteia o pedido (diferente de `definir-sku`): só resolve o produto.
 */
export async function resolverProdutoEfetivoComAutoSync(
  empresaId: string,
  item: {
    produto_id: number | string;
    sku?: string | null;
    produto_wms_substituto_id?: string | null;
  },
): Promise<string> {
  // 1. Troca de equivalência: substituto resolvido direto por uuid.
  if (item.produto_wms_substituto_id) return item.produto_wms_substituto_id;

  const sb = createServiceClient();
  const sku = (item.sku ?? "").trim();
  const tinyId = Number(item.produto_id);
  const temTiny = Number.isInteger(tinyId) && tinyId > 0;

  // 2. SKU-first (catálogo).
  if (sku) {
    const { data } = await sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .maybeSingle();
    if (data?.id) return data.id as string;
  }

  // 3. Fallback: ponte tiny_id (item sem SKU mas com produto Tiny mapeado).
  if (temTiny) {
    const { data } = await sb
      .from("siso_produto_empresas")
      .select("produto_id")
      .eq("empresa_id", empresaId)
      .eq("tiny_produto_id", tinyId)
      .maybeSingle();
    if (data?.produto_id) return data.produto_id as string;
  }

  // 4. Auto-provisão do Tiny — produto ainda não está no catálogo WMS.
  if (sku) {
    try {
      if (temTiny) {
        await ensureProdutoFromTiny(sku, empresaId, tinyId);
      } else {
        const { token } = await getValidTokenByEmpresa(empresaId);
        const achado = await runWithEmpresa(empresaId, () =>
          buscarProdutoPorSku(token, sku),
        );
        if (achado) await ensureProdutoFromTiny(sku, empresaId, achado.id);
      }
    } catch (syncErr) {
      // ensureProdutoFromTiny pode criar produto+ponte e falhar DEPOIS no sync
      // (Tiny intermitente) — o produto já basta pro pick. Re-consulta abaixo.
      logger.warn(
        "wms.sync.autoheal",
        "auto-provisão do Tiny falhou — re-tentando resolver por SKU",
        {
          empresaId,
          sku,
          tinyProdutoId: temTiny ? tinyId : null,
          erro: syncErr instanceof Error ? syncErr.message : String(syncErr),
        },
      );
    }
    const { data } = await sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .maybeSingle();
    if (data?.id) return data.id as string;
  }

  // 5. Sem SKU e sem vínculo Tiny resolvível → resolução humana. Mantém
  //    "não mapeado" na mensagem pra compatibilidade com callers que testam a
  //    string (ex.: caminho legado de validar-oc-item).
  throw new Error(
    `produto não resolvível (sku="${sku || "—"}", tiny=${item.produto_id}, empresa ${empresaId}) — não mapeado em siso_produto_empresas; exige SKU/resolução manual`,
  );
}

export interface PuxarProdutoTinyResult {
  encontrado: boolean;
  produtoId?: string;
  sku: string;
  descricao?: string | null;
  jaExistia?: boolean;
  empresas?: Array<{ empresaId: string; cnpj: string; tinyProdutoId: number }>;
  contasComErro?: number;
}

/**
 * Consulta + cadastro automático por SKU: busca o SKU em TODAS as contas Tiny
 * conectadas (`buscarProdutoPorSku`) e, pra cada conta que tem o produto,
 * garante o catálogo via `ensureProdutoFromTiny` (a 1ª cria + sincroniza; as
 * demais só registram a ponte tiny→wms da empresa). Botão "Puxar do Tiny" da
 * página de produtos.
 *
 * Não lança quando o SKU não existe em lugar nenhum: retorna `encontrado:false`
 * pra rota responder 404 com mensagem amigável (erros reais de conexão são
 * isolados por conta e contados em `contasComErro`).
 */
export async function puxarProdutoDoTinyPorSku(
  skuRaw: string,
): Promise<PuxarProdutoTinyResult> {
  const sku = skuRaw.trim();
  if (!sku) throw new Error("SKU obrigatório");
  const sb = createServiceClient();

  const { data: existente } = await sb
    .from("siso_produtos")
    .select("id, descricao")
    .eq("sku", sku)
    .maybeSingle();

  // contas conectadas (conexão ativa + empresa ativa) — mesma regra do polling.
  const { data: connections, error } = await sb
    .from("siso_tiny_connections")
    .select("cnpj, empresa_id")
    .eq("ativo", true)
    .not("empresa_id", "is", null)
    .not("access_token", "is", null);
  if (error) throw new Error(`Falha listando conexões Tiny: ${error.message}`);
  const { data: empresasAtivas } = await sb
    .from("siso_empresas")
    .select("id")
    .eq("ativo", true);
  const ativas = new Set(
    (empresasAtivas ?? []).map((e) => (e as { id: string }).id),
  );
  const conns = (
    (connections ?? []) as Array<{ cnpj: string; empresa_id: string }>
  ).filter((c) => ativas.has(c.empresa_id));

  const matches: Array<{
    empresaId: string;
    cnpj: string;
    tinyProdutoId: number;
    descricao: string | null;
  }> = [];
  let contasComErro = 0;
  for (const conn of conns) {
    try {
      const { token } = await getValidTokenByEmpresa(conn.empresa_id);
      const achado = await runWithEmpresa(conn.empresa_id, () =>
        buscarProdutoPorSku(token, sku),
      );
      if (achado) {
        matches.push({
          empresaId: conn.empresa_id,
          cnpj: conn.cnpj,
          tinyProdutoId: achado.id,
          descricao: achado.descricao ?? null,
        });
      }
    } catch (err) {
      contasComErro++;
      logger.warn("wms.sync", "busca de SKU no Tiny falhou pra empresa (segue)", {
        empresaId: conn.empresa_id,
        sku,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (matches.length === 0) {
    // Já no catálogo mas não achado agora (ex.: inativo no Tiny / token morto):
    // não é erro — devolve o existente.
    if (existente) {
      return {
        encontrado: true,
        produtoId: existente.id,
        sku,
        descricao: existente.descricao ?? null,
        jaExistia: true,
        empresas: [],
        contasComErro,
      };
    }
    return { encontrado: false, sku, contasComErro };
  }

  // 1º match cria + sincroniza; demais só adicionam a ponte da empresa.
  let produtoId = existente?.id ?? "";
  for (const m of matches) {
    produtoId = await ensureProdutoFromTiny(sku, m.empresaId, m.tinyProdutoId);
  }

  const { data: final } = await sb
    .from("siso_produtos")
    .select("descricao")
    .eq("id", produtoId)
    .maybeSingle();

  return {
    encontrado: true,
    produtoId,
    sku,
    descricao: final?.descricao ?? matches[0].descricao,
    jaExistia: !!existente,
    empresas: matches.map((m) => ({
      empresaId: m.empresaId,
      cnpj: m.cnpj,
      tinyProdutoId: m.tinyProdutoId,
    })),
    contasComErro,
  };
}
