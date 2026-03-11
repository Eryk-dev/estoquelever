import { createServiceClient } from "./supabase-server";
import { getPedido, getEstoque, buscarProdutoPorSku, getProdutoDetalhe, getProdutoKit, obterNotaFiscal } from "./tiny-api";
import { getFornecedorBySku } from "./sku-fornecedor";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { registerApiCall, waitForRateLimit } from "./rate-limiter";
import { processQueue } from "./execution-worker";
import { getEmpresasDoGrupo, agregarEstoquePorGalpao } from "./grupo-resolver";
import type { EmpresaGrupo } from "./grupo-resolver";
import { logger } from "./logger";
import { registrarEvento } from "./historico-service";
import type { NfWebhookPayload } from "./nf-webhook-handler";
import type { TinyPedidoItem } from "./tiny-api";

/** Serialize any thrown value into a readable string */
function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

type Decisao = "propria" | "transferencia" | "oc";

interface ProcessedItem {
  produto_id: number;
  produto_id_suporte: number | null;
  sku: string;
  descricao: string;
  quantidade_pedida: number;
  // Legacy columns (still written for backwards compat)
  estoque_cwb_deposito_id: number | null;
  estoque_cwb_deposito_nome: string | null;
  estoque_cwb_saldo: number;
  estoque_cwb_reservado: number;
  estoque_cwb_disponivel: number;
  estoque_sp_deposito_id: number | null;
  estoque_sp_deposito_nome: string | null;
  estoque_sp_saldo: number;
  estoque_sp_reservado: number;
  estoque_sp_disponivel: number;
  cwb_atende: boolean;
  sp_atende: boolean;
  fornecedor_oc: string | null;
  localizacao_cwb: string | null;
  localizacao_sp: string | null;
  imagem_url: string | null;
  gtin: string | null;
}

/** Per-empresa stock data for one item */
interface ItemEstoqueEmpresa {
  empresaId: string;
  galpaoId: string;
  galpaoNome: string;
  produtoIdNaEmpresa: number | null;
  depositoId: number | null;
  depositoNome: string | null;
  saldo: number;
  reservado: number;
  disponivel: number;
  localizacao: string | null;
}

// ─── Load configured deposit ID for an empresa ─────────────────────────────

async function getDepositoIdByEmpresa(
  empresaId: string,
): Promise<number | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("siso_tiny_connections")
    .select("deposito_id")
    .eq("empresa_id", empresaId)
    .eq("ativo", true)
    .single();
  return data?.deposito_id ?? null;
}

/**
 * Process an incoming Tiny webhook payload.
 * Now receives empresaId instead of filial.
 */
export async function processWebhook(
  webhookLogId: string,
  pedidoTinyId: string,
  empresaOrigemId: string,
  galpaoOrigemId: string,
  grupoId: string | null,
) {
  const supabase = createServiceClient();

  await supabase
    .from("siso_webhook_logs")
    .update({ status: "processando" })
    .eq("id", webhookLogId);

  logger.info("processor", "Processing webhook", {
    pedidoId: pedidoTinyId,
    empresaId: empresaOrigemId,
    webhookLogId,
  });

  try {
    // 0. Resolve galpao name early (used for filial_origem and enrichment fallback)
    let galpaoOrigemNome: string;
    {
      const { data: galpaoRow } = await supabase
        .from("siso_galpoes")
        .select("nome")
        .eq("id", galpaoOrigemId)
        .single();
      galpaoOrigemNome = galpaoRow?.nome ?? "CWB";
    }

    // 1. Get all empresas in the grupo
    const empresasDoGrupo = grupoId
      ? await getEmpresasDoGrupo(grupoId)
      : [];

    // Ensure origin empresa is included
    const origemNoGrupo = empresasDoGrupo.find(
      (e) => e.empresaId === empresaOrigemId,
    );
    if (!origemNoGrupo && empresasDoGrupo.length === 0) {
      // Empresa without a grupo — process only with itself
      logger.warn("processor", "Empresa sem grupo — processando somente com origem", {
        pedidoId: pedidoTinyId,
        empresaId: empresaOrigemId,
        grupoId,
      });
    }

    // 2. Get token for origin empresa
    const { token: origemToken } = await getValidTokenByEmpresa(empresaOrigemId);

    // 3. Get tokens for all other empresas in the grupo
    const empresaTokens = new Map<string, string>();
    empresaTokens.set(empresaOrigemId, origemToken);

    const empresaDepositoIds = new Map<string, number | null>();
    empresaDepositoIds.set(empresaOrigemId, await getDepositoIdByEmpresa(empresaOrigemId));

    const empresasIndisponiveis: string[] = [];

    for (const emp of empresasDoGrupo) {
      if (emp.empresaId === empresaOrigemId) continue;
      try {
        const { token } = await getValidTokenByEmpresa(emp.empresaId);
        empresaTokens.set(emp.empresaId, token);
        empresaDepositoIds.set(emp.empresaId, await getDepositoIdByEmpresa(emp.empresaId));
      } catch {
        empresasIndisponiveis.push(emp.empresaNome);
        logger.warn("processor", `No token for empresa ${emp.empresaNome} — stock check skipped`, {
          pedidoId: pedidoTinyId,
          empresaId: emp.empresaId,
        });
      }
    }

    // 4. Fetch order details from Tiny (origin empresa)
    await waitForRateLimit(empresaOrigemId);
    await registerApiCall(empresaOrigemId, "GET /pedidos/{id}");
    const pedido = await getPedido(origemToken, pedidoTinyId);

    // 5. Enrich each item with stock from all empresas in the grupo
    const itensProcessados: ProcessedItem[] = [];
    const itensEstoques: Array<{
      pedido_id: string;
      produto_id: number;
      empresa_id: string;
      deposito_id: number | null;
      deposito_nome: string | null;
      saldo: number;
      reservado: number;
      disponivel: number;
      localizacao: string | null;
    }> = [];

    for (const item of pedido.itens) {
      // Check if product is a kit — expand into components
      let expandedItems: TinyPedidoItem[] = [item];
      let kitImagemUrl: string | null = null;
      let itemGtin: string | null = null;

      try {
        await waitForRateLimit(empresaOrigemId);
        await registerApiCall(empresaOrigemId, "GET /produtos/{id}");
        const detalhe = await getProdutoDetalhe(origemToken, item.produto.id);
        kitImagemUrl = detalhe.imagemUrl;
        itemGtin = detalhe.gtin;

        if (detalhe.tipo === "K") {
          await sleep(500);
          await waitForRateLimit(empresaOrigemId);
          await registerApiCall(empresaOrigemId, "GET /produtos/{id}/kit");
          const componentes = await getProdutoKit(origemToken, item.produto.id);

          if (componentes.length > 0) {
            logger.info("processor", `Kit detected — expanding ${componentes.length} components`, {
              pedidoId: pedidoTinyId,
              kitProdutoId: item.produto.id,
              kitSku: item.produto.sku,
              componentes: componentes.map((c) => c.produto.sku),
            });

            expandedItems = componentes.map((comp) => ({
              produto: {
                id: comp.produto.id,
                sku: comp.produto.sku ?? "",
                descricao: comp.produto.descricao ?? "",
              },
              quantidade: comp.quantidade * item.quantidade,
              valorUnitario: 0,
            }));
          }
        }
      } catch {
        // Detalhe/kit fetch failed — process as normal item
      }

      // For non-kit items, use the GTIN from the origin getProdutoDetalhe call.
      // For kit components, GTIN is null (kit parent GTIN != component GTIN).
      const isKit = expandedItems.length > 1 || expandedItems[0] !== item;

      for (const expandedItem of expandedItems) {
        const { processed, estoquesPorEmpresa } = await enrichItemMultiEmpresa(
          expandedItem,
          empresaOrigemId,
          galpaoOrigemId,
          galpaoOrigemNome,
          empresasDoGrupo,
          empresaTokens,
          empresaDepositoIds,
          kitImagemUrl,
          isKit ? null : itemGtin,
        );
        itensProcessados.push(processed);

        for (const est of estoquesPorEmpresa) {
          itensEstoques.push({
            pedido_id: pedidoTinyId,
            produto_id: expandedItem.produto.id,
            empresa_id: est.empresaId,
            deposito_id: est.depositoId,
            deposito_nome: est.depositoNome,
            saldo: est.saldo,
            reservado: est.reservado,
            disponivel: est.disponivel,
            localizacao: est.localizacao,
          });
        }

        await sleep(500);
      }
    }

    // 6. Calculate suggestion using aggregated galpao data
    const { sugestao, motivo, parcial, separacaoGalpaoId } = calcularSugestaoMultiGalpao(
      galpaoOrigemId,
      itensProcessados,
      empresasDoGrupo,
      itensEstoques,
    );

    // 6b. Append warnings
    const warnings: string[] = [];
    if (empresasIndisponiveis.length > 0) {
      warnings.push(`Estoque não verificado: ${empresasIndisponiveis.join(", ")}`);
    }
    const motivoFinal = warnings.length > 0
      ? `${motivo} | ${warnings.join("; ")}`
      : motivo;

    // 7. Determine status
    const isAuto = sugestao === "propria" && !parcial;
    const status = isAuto ? "executando" : "pendente";
    const tipoResolucao = isAuto ? "auto" : null;

    // 8. Use galpaoOrigemNome (resolved at step 0)

    // 9. Insert into siso_pedidos
    const { error: pedidoError } = await supabase
      .from("siso_pedidos")
      .upsert(
        {
          id: pedidoTinyId,
          numero: pedido.numero,
          data: formatDate(pedido.data),
          filial_origem: galpaoOrigemNome as "CWB" | "SP",
          empresa_origem_id: empresaOrigemId,
          id_pedido_ecommerce: pedido.idPedidoEcommerce ?? null,
          nome_ecommerce: pedido.nomeEcommerce ?? null,
          cliente_nome: pedido.cliente.nome,
          cliente_cpf_cnpj: pedido.cliente.cpfCnpj ?? null,
          forma_envio_id: pedido.formaEnvio?.id ?? null,
          forma_envio_descricao: pedido.formaEnvio?.descricao ?? null,
          sugestao,
          sugestao_motivo: motivoFinal,
          status,
          tipo_resolucao: tipoResolucao,
          decisao_final: isAuto ? "propria" : null,
          separacao_galpao_id: separacaoGalpaoId,
          status_separacao: "aguardando_nf",
          processado_em: null,
          marcadores: isAuto ? [galpaoOrigemNome] : [],
          payload_original: pedido,
        },
        { onConflict: "id" },
      );

    if (pedidoError) throw pedidoError;

    // 9a. Record history events
    registrarEvento({
      pedidoId: pedidoTinyId,
      evento: "recebido",
      detalhes: { sugestao, empresa: galpaoOrigemNome, ecommerce: pedido.nomeEcommerce },
    }).catch(() => {});

    if (isAuto) {
      registrarEvento({
        pedidoId: pedidoTinyId,
        evento: "auto_aprovado",
        detalhes: { decisao: "propria", motivo: motivoFinal },
      }).catch(() => {});
    }

    // 9b. Auto-approved → enqueue stock posting job
    if (isAuto) {
      await supabase.from("siso_fila_execucao").insert({
        pedido_id: pedidoTinyId,
        tipo: "lancar_estoque",
        filial_execucao: galpaoOrigemNome,
        empresa_id: empresaOrigemId,
        decisao: "propria",
      });

      processQueue(1).catch((err) => {
        logger.error("processor", "Auto-approve worker kick failed", {
          pedidoId: pedidoTinyId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      logger.info("processor", "Order auto-approved → stock posting queued", {
        pedidoId: pedidoTinyId,
        empresaId: empresaOrigemId,
        sugestao,
        motivo: motivoFinal,
      });
    } else {
      logger.info("processor", "Order queued for human review", {
        pedidoId: pedidoTinyId,
        empresaId: empresaOrigemId,
        sugestao,
        motivo: motivoFinal,
        parcial,
      });
    }

    // 10. Insert items (legacy per-item table)
    for (const item of itensProcessados) {
      const { error: itemError } = await supabase
        .from("siso_pedido_itens")
        .upsert(
          {
            pedido_id: pedidoTinyId,
            ...item,
          },
          { onConflict: "pedido_id,produto_id" },
        );
      if (itemError && itemError.code !== "23505") {
        logger.error("processor", "Failed to insert order item", {
          pedidoId: pedidoTinyId,
          produtoId: item.produto_id,
          supabaseError: itemError.message,
        });
      }
    }

    // 10b. Insert normalized per-empresa stock data
    if (itensEstoques.length > 0) {
      const { error: estError } = await supabase
        .from("siso_pedido_item_estoques")
        .upsert(itensEstoques, {
          onConflict: "pedido_id,produto_id,empresa_id",
        });
      if (estError) {
        logger.error("processor", "Failed to insert item estoques", {
          pedidoId: pedidoTinyId,
          supabaseError: estError.message,
        });
      }
    }

    // 11. Update webhook log
    await supabase
      .from("siso_webhook_logs")
      .update({
        status: "concluido",
        empresa_id: empresaOrigemId,
        processado_em: new Date().toISOString(),
      })
      .eq("id", webhookLogId);

    // 12. Reconcile pending NF webhooks (race condition: NF arrived before pedido was saved)
    try {
      const { data: pendingNfWebhooks } = await supabase
        .from("siso_webhook_logs")
        .select("id, payload")
        .eq("status", "aguardando_pedido")
        .eq("empresa_id", empresaOrigemId)
        .like("dedup_key", "nf_%");

      if (pendingNfWebhooks && pendingNfWebhooks.length > 0) {
        for (const nfLog of pendingNfWebhooks) {
          const nfPayload = nfLog.payload as NfWebhookPayload | null;
          const idNotaFiscalTiny = nfPayload?.dados?.idNotaFiscalTiny;
          if (!idNotaFiscalTiny) continue;

          // Match this NF to the just-saved pedido via Tiny API
          let isMatch = false;
          try {
            await waitForRateLimit(empresaOrigemId);
            await registerApiCall(empresaOrigemId, "GET /notas/{id}");
            const nf = await obterNotaFiscal(origemToken, idNotaFiscalTiny);
            if (nf.origem?.tipo === "venda" && nf.origem?.id === pedidoTinyId) {
              isMatch = true;
            }
          } catch {
            continue;
          }

          if (!isMatch) continue;

          // Transition aguardando_nf → pendente and save NF data
          const { data: transitioned } = await supabase
            .from("siso_pedidos")
            .update({
              status_separacao: "pendente",
              url_danfe: nfPayload.dados.urlDanfe ?? null,
              chave_acesso_nf: nfPayload.dados.chaveAcesso ?? null,
            })
            .eq("id", pedidoTinyId)
            .eq("status_separacao", "aguardando_nf")
            .select("id")
            .maybeSingle();

          // Mark NF webhook as processed
          await supabase
            .from("siso_webhook_logs")
            .update({ status: "processado", processado_em: new Date().toISOString() })
            .eq("id", nfLog.id);

          logger.info("processor", "Reconciled pending NF webhook", {
            pedidoId: pedidoTinyId,
            idNotaFiscalTiny: String(idNotaFiscalTiny),
            transitioned: !!transitioned,
          });
        }
      }
    } catch (err) {
      logger.warn("processor", "NF reconciliation check failed", {
        pedidoId: pedidoTinyId,
        error: serializeError(err),
      });
    }

    logger.info("processor", "Webhook processing complete", {
      pedidoId: pedidoTinyId,
      empresaId: empresaOrigemId,
      status,
      sugestao,
    });

    return { ok: true, pedidoId: pedidoTinyId, status, sugestao };
  } catch (err) {
    const msg = serializeError(err);
    await supabase
      .from("siso_webhook_logs")
      .update({ status: "erro", erro: msg, processado_em: new Date().toISOString() })
      .eq("id", webhookLogId);
    logger.error("processor", "Webhook processing failed", {
      pedidoId: pedidoTinyId,
      empresaId: empresaOrigemId,
      error: msg,
      webhookLogId,
    });
    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function enrichItemMultiEmpresa(
  item: TinyPedidoItem,
  empresaOrigemId: string,
  galpaoOrigemId: string,
  galpaoOrigemNome: string,
  empresasDoGrupo: EmpresaGrupo[],
  empresaTokens: Map<string, string>,
  empresaDepositoIds: Map<string, number | null>,
  preImagemUrl?: string | null,
  preGtin?: string | null,
): Promise<{
  processed: ProcessedItem;
  estoquesPorEmpresa: ItemEstoqueEmpresa[];
}> {
  const sku = item.produto.sku ?? "";
  const qtd = item.quantidade;
  const estoquesPorEmpresa: ItemEstoqueEmpresa[] = [];

  // Helper: pick deposit from depositos array
  function pickDeposito(
    depositos: import("./tiny-api").TinyDeposito[] | undefined,
    depositoId: number | null,
  ) {
    if (!depositos?.length) return null;
    if (depositoId !== null) {
      return depositos.find((d) => d.id === depositoId) ?? null;
    }
    return depositos[0];
  }

  // Track first produto_id found in non-origin empresas (for transfers)
  let produtoIdSuporte: number | null = null;

  // Query stock in each empresa of the grupo
  const empresasParaConsultar = empresasDoGrupo.length > 0
    ? empresasDoGrupo
    : [{ empresaId: empresaOrigemId, galpaoId: galpaoOrigemId, galpaoNome: galpaoOrigemNome, empresaNome: galpaoOrigemNome, tier: 1 }];

  for (const emp of empresasParaConsultar) {
    const token = empresaTokens.get(emp.empresaId);
    if (!token) continue;

    const depositoId = empresaDepositoIds.get(emp.empresaId) ?? null;
    const isOrigem = emp.empresaId === empresaOrigemId;

    try {
      let produtoId: number;
      if (isOrigem) {
        produtoId = item.produto.id;
      } else {
        // Search for product by SKU in this empresa's Tiny account
        await sleep(500);
        await waitForRateLimit(emp.empresaId);
        await registerApiCall(emp.empresaId, "GET /produtos?codigo=");
        const produtoBusca = await buscarProdutoPorSku(token, sku);
        if (!produtoBusca) continue;
        produtoId = produtoBusca.id;
        if (!produtoIdSuporte) produtoIdSuporte = produtoId;
      }

      await waitForRateLimit(emp.empresaId);
      await registerApiCall(emp.empresaId, "GET /estoque/{id}");
      const estoque = await getEstoque(token, produtoId);
      const dep = pickDeposito(estoque.depositos, depositoId);

      const saldo = dep?.saldo ?? 0;
      const reservado = dep?.reservado ?? 0;
      const disponivel = Math.max(0, saldo - reservado);

      estoquesPorEmpresa.push({
        empresaId: emp.empresaId,
        galpaoId: emp.galpaoId,
        galpaoNome: emp.galpaoNome,
        produtoIdNaEmpresa: produtoId,
        depositoId: dep?.id ?? null,
        depositoNome: dep?.nome ?? null,
        saldo,
        reservado,
        disponivel,
        localizacao: estoque.localizacao ?? null,
      });
    } catch {
      // Stock query failed, continue
    }

    await sleep(500);
  }

  // Use pre-fetched image URL and GTIN (fetched before kit expansion)
  // For non-kit items, fetch it now if not provided
  let imagemUrl: string | null = preImagemUrl ?? null;
  let gtin: string | null = preGtin ?? null;
  if (imagemUrl === null) {
    const origemToken = empresaTokens.get(empresaOrigemId);
    if (origemToken) {
      try {
        await waitForRateLimit(empresaOrigemId);
        await registerApiCall(empresaOrigemId, "GET /produtos/{id}");
        const detalhe = await getProdutoDetalhe(origemToken, item.produto.id);
        imagemUrl = detalhe.imagemUrl;
        if (!gtin) gtin = detalhe.gtin;
      } catch {
        // Image/GTIN fetch failed — non-critical, continue
      }
    }
  }

  // Aggregate by galpao for legacy CWB/SP columns
  const porGalpao = agregarEstoquePorGalpao(
    estoquesPorEmpresa.map((e) => ({
      ...e,
      depositoId: e.depositoId,
      depositoNome: e.depositoNome,
    })),
  );

  // Find CWB and SP aggregates (by galpao name for backwards compat)
  let cwbAgg = { disponivel: 0, saldo: 0, reservado: 0 };
  let spAgg = { disponivel: 0, saldo: 0, reservado: 0 };
  let cwbDepId: number | null = null;
  let cwbDepNome: string | null = null;
  let cwbLocalizacao: string | null = null;
  let spDepId: number | null = null;
  let spDepNome: string | null = null;
  let spLocalizacao: string | null = null;

  for (const [, agg] of porGalpao) {
    if (agg.galpaoNome === "CWB") {
      cwbAgg = agg;
      const cwbEst = estoquesPorEmpresa.find((e) => e.galpaoNome === "CWB");
      cwbDepId = cwbEst?.depositoId ?? null;
      cwbDepNome = cwbEst?.depositoNome ?? null;
      cwbLocalizacao = cwbEst?.localizacao ?? null;
    } else if (agg.galpaoNome === "SP") {
      spAgg = agg;
      const spEst = estoquesPorEmpresa.find((e) => e.galpaoNome === "SP");
      spDepId = spEst?.depositoId ?? null;
      spDepNome = spEst?.depositoNome ?? null;
      spLocalizacao = spEst?.localizacao ?? null;
    }
  }

  const fornecedor = getFornecedorBySku(sku);

  const processed: ProcessedItem = {
    produto_id: item.produto.id,
    produto_id_suporte: produtoIdSuporte,
    sku,
    descricao: item.produto.descricao,
    quantidade_pedida: qtd,
    estoque_cwb_deposito_id: cwbDepId,
    estoque_cwb_deposito_nome: cwbDepNome,
    estoque_cwb_saldo: cwbAgg.saldo,
    estoque_cwb_reservado: cwbAgg.reservado,
    estoque_cwb_disponivel: cwbAgg.disponivel,
    estoque_sp_deposito_id: spDepId,
    estoque_sp_deposito_nome: spDepNome,
    estoque_sp_saldo: spAgg.saldo,
    estoque_sp_reservado: spAgg.reservado,
    estoque_sp_disponivel: spAgg.disponivel,
    cwb_atende: cwbAgg.disponivel >= qtd,
    sp_atende: spAgg.disponivel >= qtd,
    fornecedor_oc: fornecedor?.fornecedor ?? null,
    localizacao_cwb: cwbLocalizacao,
    localizacao_sp: spLocalizacao,
    imagem_url: imagemUrl,
    gtin,
  };

  return { processed, estoquesPorEmpresa };
}

interface SugestaoResult {
  sugestao: Decisao;
  motivo: string;
  parcial: boolean;
  separacaoGalpaoId: string;
}

function calcularSugestaoMultiGalpao(
  galpaoOrigemId: string,
  itens: ProcessedItem[],
  empresasDoGrupo: EmpresaGrupo[],
  itensEstoques: Array<{
    pedido_id: string;
    produto_id: number;
    empresa_id: string;
    deposito_id: number | null;
    deposito_nome: string | null;
    saldo: number;
    reservado: number;
    disponivel: number;
  }>,
): SugestaoResult {
  if (itens.length === 0) {
    return {
      sugestao: "oc",
      motivo: "Pedido sem itens — verificar manualmente",
      parcial: false,
      separacaoGalpaoId: galpaoOrigemId,
    };
  }

  // Get unique galpao IDs and names
  const galpaoMap = new Map<string, string>();
  for (const emp of empresasDoGrupo) {
    galpaoMap.set(emp.galpaoId, emp.galpaoNome);
  }
  const galpaoOrigemNome = galpaoMap.get(galpaoOrigemId) ?? "Origem";

  // Aggregate stock by galpao per item
  const galpaoIds = [...galpaoMap.keys()];
  const outrosGalpaoIds = galpaoIds.filter((id) => id !== galpaoOrigemId);

  // Check: does origin galpao cover all items?
  const origemAtendeTudo = itens.every((item) => {
    const estoqueOrigemGalpao = itensEstoques
      .filter((e) => e.produto_id === item.produto_id)
      .filter((e) => {
        const emp = empresasDoGrupo.find((eg) => eg.empresaId === e.empresa_id);
        return emp?.galpaoId === galpaoOrigemId;
      })
      .reduce((sum, e) => sum + e.disponivel, 0);
    return estoqueOrigemGalpao >= item.quantidade_pedida;
  });

  if (origemAtendeTudo) {
    return {
      sugestao: "propria",
      motivo: `${galpaoOrigemNome} tem estoque de todos os itens`,
      parcial: false,
      separacaoGalpaoId: galpaoOrigemId,
    };
  }

  // Check: does any OTHER galpao cover all items?
  for (const outroGalpaoId of outrosGalpaoIds) {
    const outroNome = galpaoMap.get(outroGalpaoId) ?? "???";
    const outroAtendeTudo = itens.every((item) => {
      const estoqueOutro = itensEstoques
        .filter((e) => e.produto_id === item.produto_id)
        .filter((e) => {
          const emp = empresasDoGrupo.find((eg) => eg.empresaId === e.empresa_id);
          return emp?.galpaoId === outroGalpaoId;
        })
        .reduce((sum, e) => sum + e.disponivel, 0);
      return estoqueOutro >= item.quantidade_pedida;
    });

    if (outroAtendeTudo) {
      return {
        sugestao: "transferencia",
        motivo: `${galpaoOrigemNome} sem estoque. ${outroNome} tem ${itens.length === 1 ? "o item" : `todos os ${itens.length} itens`} → Transferência`,
        parcial: false,
        separacaoGalpaoId: outroGalpaoId,
      };
    }
  }

  // Check: no galpao has any stock at all?
  const nenhumaTemQualquer = itens.every((item) => {
    const totalDisponivel = itensEstoques
      .filter((e) => e.produto_id === item.produto_id)
      .reduce((sum, e) => sum + e.disponivel, 0);
    return totalDisponivel <= 0;
  });

  if (nenhumaTemQualquer) {
    const fornecedores = [
      ...new Set(itens.map((i) => i.fornecedor_oc).filter(Boolean)),
    ];
    return {
      sugestao: "oc",
      motivo: `Sem estoque em nenhum galpão → Ordem de Compra${fornecedores.length > 0 ? ` (Fornecedor: ${fornecedores.join(", ")})` : ""}`,
      parcial: false,
      separacaoGalpaoId: galpaoOrigemId,
    };
  }

  // Partial — count how many items each galpao covers
  const coverageByGalpao = new Map<string, number>();
  for (const galpaoId of galpaoIds) {
    let covers = 0;
    for (const item of itens) {
      const estoqueGalpao = itensEstoques
        .filter((e) => e.produto_id === item.produto_id)
        .filter((e) => {
          const emp = empresasDoGrupo.find((eg) => eg.empresaId === e.empresa_id);
          return emp?.galpaoId === galpaoId;
        })
        .reduce((sum, e) => sum + e.disponivel, 0);
      if (estoqueGalpao >= item.quantidade_pedida) covers++;
    }
    coverageByGalpao.set(galpaoId, covers);
  }

  // Find best galpao
  let bestGalpaoId = galpaoOrigemId;
  let bestCovers = coverageByGalpao.get(galpaoOrigemId) ?? 0;
  for (const [galpaoId, covers] of coverageByGalpao) {
    if (covers > bestCovers) {
      bestCovers = covers;
      bestGalpaoId = galpaoId;
    }
  }

  const coverageDesc = [...coverageByGalpao.entries()]
    .map(([gId, c]) => `${galpaoMap.get(gId)} cobre ${c}/${itens.length}`)
    .join(", ");

  if (bestGalpaoId === galpaoOrigemId) {
    return {
      sugestao: "propria",
      motivo: `Estoque parcial. ${coverageDesc}`,
      parcial: true,
      separacaoGalpaoId: galpaoOrigemId,
    };
  }

  return {
    sugestao: "transferencia",
    motivo: `Estoque parcial. ${coverageDesc}`,
    parcial: true,
    separacaoGalpaoId: bestGalpaoId,
  };
}

function formatDate(dateStr: string): string {
  if (dateStr.includes("/")) {
    const [d, m, y] = dateStr.split("/");
    return `${y}-${m}-${d}`;
  }
  return dateStr;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
