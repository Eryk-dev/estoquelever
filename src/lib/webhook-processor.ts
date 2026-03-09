import { createServiceClient } from "./supabase-server";
import { getPedido, getEstoque, buscarProdutoPorSku } from "./tiny-api";
import { getFornecedorBySku } from "./sku-fornecedor";
import { getValidTokenByFilial } from "./tiny-oauth";
import { logger } from "./logger";
import type { TinyPedidoItem } from "./tiny-api";

type Filial = "CWB" | "SP";
type Decisao = "propria" | "transferencia" | "oc";

interface ProcessedItem {
  produto_id: number;
  sku: string;
  descricao: string;
  quantidade_pedida: number;
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
}

// ─── Load configured deposit IDs from the database ──────────────────────────

async function getDepositoIdByFilial(
  filial: "CWB" | "SP",
): Promise<number | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("siso_tiny_connections")
    .select("deposito_id")
    .eq("filial", filial)
    .eq("ativo", true)
    .single();
  return data?.deposito_id ?? null;
}

/**
 * Process an incoming Tiny webhook payload.
 * Fetches order details, enriches with stock data, calculates suggestion.
 */
export async function processWebhook(
  webhookLogId: string,
  pedidoTinyId: string,
  filialOrigem: Filial,
) {
  const supabase = createServiceClient();

  // Update webhook log status
  await supabase
    .from("siso_webhook_logs")
    .update({ status: "processando" })
    .eq("id", webhookLogId);

  logger.info("processor", "Processing webhook", {
    pedidoId: pedidoTinyId,
    filial: filialOrigem,
    webhookLogId,
  });

  try {
    // 1. Get valid OAuth2 tokens for both branches
    const filialSuporte: Filial = filialOrigem === "CWB" ? "SP" : "CWB";

    const { token: origemToken } = await getValidTokenByFilial(filialOrigem);

    let suporteToken: string | null = null;
    try {
      const result = await getValidTokenByFilial(filialSuporte);
      suporteToken = result.token;
    } catch {
      // Support branch may not be configured yet
      logger.warn("processor", `No token for support branch ${filialSuporte} — stock check skipped`, {
        pedidoId: pedidoTinyId,
        filial: filialOrigem,
      });
    }

    // 2. Fetch order details from Tiny
    const pedido = await getPedido(origemToken, pedidoTinyId);

    // 3. Load configured deposit IDs for each branch
    const cwbDepositoId = await getDepositoIdByFilial("CWB");
    const spDepositoId = await getDepositoIdByFilial("SP");

    // 4. Enrich each item with stock from both branches
    const itensProcessados: ProcessedItem[] = [];

    for (const item of pedido.itens) {
      const processed = await enrichItem(
        item,
        filialOrigem,
        origemToken,
        suporteToken,
        cwbDepositoId,
        spDepositoId,
      );
      itensProcessados.push(processed);

      // Rate limit: 2s between API calls
      await sleep(500);
    }

    // 5. Calculate suggestion
    const { sugestao, motivo, parcial } = calcularSugestao(
      filialOrigem,
      itensProcessados,
    );

    // 6. Determine status: auto-approve ONLY if origin has ALL items (not partial)
    const isAuto = sugestao === "propria" && !parcial;
    const status = isAuto ? "concluido" : "pendente";
    const tipoResolucao = isAuto ? "auto" : null;

    // 7. Insert into siso_pedidos (dedup on id)
    const { error: pedidoError } = await supabase
      .from("siso_pedidos")
      .upsert(
        {
          id: pedidoTinyId,
          numero: pedido.numero,
          data: formatDate(pedido.data),
          filial_origem: filialOrigem,
          id_pedido_ecommerce: pedido.idPedidoEcommerce ?? null,
          nome_ecommerce: pedido.nomeEcommerce ?? null,
          cliente_nome: pedido.cliente.nome,
          cliente_cpf_cnpj: pedido.cliente.cpfCnpj ?? null,
          forma_envio_id: pedido.formaEnvio?.id ?? null,
          forma_envio_descricao: pedido.formaEnvio?.descricao ?? null,
          sugestao,
          sugestao_motivo: motivo,
          status,
          tipo_resolucao: tipoResolucao,
          decisao_final: isAuto ? "propria" : null,
          processado_em: isAuto ? new Date().toISOString() : null,
          marcadores: isAuto ? [filialOrigem] : [],
          payload_original: pedido,
        },
        { onConflict: "id" },
      );

    if (pedidoError) throw pedidoError;

    if (isAuto) {
      logger.info("processor", "Order auto-approved", {
        pedidoId: pedidoTinyId,
        filial: filialOrigem,
        sugestao,
        motivo,
      });
    } else {
      logger.info("processor", "Order queued for human review", {
        pedidoId: pedidoTinyId,
        filial: filialOrigem,
        sugestao,
        motivo,
        parcial,
      });
    }

    // 8. Insert items
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
        console.error("Item insert error:", itemError);
        logger.error("processor", "Failed to insert order item", {
          pedidoId: pedidoTinyId,
          filial: filialOrigem,
          produtoId: item.produto_id,
          supabaseError: itemError.message,
        });
      }
    }

    // 9. Update webhook log
    await supabase
      .from("siso_webhook_logs")
      .update({
        status: "concluido",
        filial: filialOrigem,
        processado_em: new Date().toISOString(),
      })
      .eq("id", webhookLogId);

    logger.info("processor", "Webhook processing complete", {
      pedidoId: pedidoTinyId,
      filial: filialOrigem,
      status,
      sugestao,
    });

    return { ok: true, pedidoId: pedidoTinyId, status, sugestao };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro desconhecido";
    await supabase
      .from("siso_webhook_logs")
      .update({ status: "erro", erro: msg, processado_em: new Date().toISOString() })
      .eq("id", webhookLogId);
    logger.error("processor", "Webhook processing failed", {
      pedidoId: pedidoTinyId,
      filial: filialOrigem,
      error: msg,
      webhookLogId,
    });
    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function enrichItem(
  item: TinyPedidoItem,
  filialOrigem: Filial,
  origemToken: string,
  suporteToken: string | null,
  cwbDepositoId: number | null,
  spDepositoId: number | null,
): Promise<ProcessedItem> {
  const sku = item.produto.codigo;
  const qtd = item.quantidade;

  // Helper: pick deposit by configured ID, or fall back to first entry when
  // no deposit has been configured yet (preserves previous behaviour).
  function pickDeposito(
    depositos: import("./tiny-api").TinyDeposito[] | undefined,
    depositoId: number | null,
  ) {
    if (!depositos?.length) return null;
    if (depositoId !== null) {
      return depositos.find((d) => d.id === depositoId) ?? null;
    }
    // Fallback: no deposit configured — log a warning and use first entry
    console.warn(
      `[webhook-processor] No deposit configured — using first deposit in list. Configure a deposit in Configurações.`,
    );
    logger.warn("processor", "No deposit ID configured, falling back to first deposit in list");
    return depositos[0];
  }

  // Stock in origin branch
  let cwbDeposito = null;
  let spDeposito = null;

  try {
    const estoque = await getEstoque(origemToken, item.produto.id);
    if (filialOrigem === "CWB") {
      cwbDeposito = pickDeposito(estoque.depositos, cwbDepositoId);
    } else {
      spDeposito = pickDeposito(estoque.depositos, spDepositoId);
    }
  } catch {
    // Stock query failed for origin, continue
  }

  // Stock in support branch (need to find product by SKU first)
  if (suporteToken) {
    try {
      await sleep(500);
      const produtoSuporte = await buscarProdutoPorSku(suporteToken, sku);
      if (produtoSuporte) {
        await sleep(500);
        const estoqueSuporte = await getEstoque(
          suporteToken,
          produtoSuporte.id,
        );
        if (filialOrigem === "CWB") {
          spDeposito = pickDeposito(estoqueSuporte.depositos, spDepositoId);
        } else {
          cwbDeposito = pickDeposito(estoqueSuporte.depositos, cwbDepositoId);
        }
      }
    } catch {
      // Stock query failed for support, continue
    }
  }

  const cwbDisponivel = (cwbDeposito?.saldo ?? 0) - (cwbDeposito?.reservado ?? 0);
  const spDisponivel = (spDeposito?.saldo ?? 0) - (spDeposito?.reservado ?? 0);

  const fornecedor = getFornecedorBySku(sku);

  return {
    produto_id: item.produto.id,
    sku,
    descricao: item.produto.descricao,
    quantidade_pedida: qtd,
    estoque_cwb_deposito_id: cwbDeposito?.id ?? null,
    estoque_cwb_deposito_nome: cwbDeposito?.nome ?? null,
    estoque_cwb_saldo: cwbDeposito?.saldo ?? 0,
    estoque_cwb_reservado: cwbDeposito?.reservado ?? 0,
    estoque_cwb_disponivel: Math.max(0, cwbDisponivel),
    estoque_sp_deposito_id: spDeposito?.id ?? null,
    estoque_sp_deposito_nome: spDeposito?.nome ?? null,
    estoque_sp_saldo: spDeposito?.saldo ?? 0,
    estoque_sp_reservado: spDeposito?.reservado ?? 0,
    estoque_sp_disponivel: Math.max(0, spDisponivel),
    cwb_atende: cwbDisponivel >= qtd,
    sp_atende: spDisponivel >= qtd,
    fornecedor_oc: fornecedor?.fornecedor ?? null,
  };
}

interface SugestaoResult {
  sugestao: Decisao;
  motivo: string;
  /** true when neither branch covers all items (requires human review) */
  parcial: boolean;
}

function calcularSugestao(
  filialOrigem: Filial,
  itens: ProcessedItem[],
): SugestaoResult {
  const origemAtendeTudo = itens.every((i) =>
    filialOrigem === "CWB" ? i.cwb_atende : i.sp_atende,
  );

  if (origemAtendeTudo) {
    return {
      sugestao: "propria",
      motivo: `${filialOrigem} tem estoque de todos os itens`,
      parcial: false,
    };
  }

  const filialSuporte = filialOrigem === "CWB" ? "SP" : "CWB";
  const suporteAtendeTudo = itens.every((i) =>
    filialSuporte === "CWB" ? i.cwb_atende : i.sp_atende,
  );

  if (suporteAtendeTudo) {
    const qtdItens = itens.length;
    return {
      sugestao: "transferencia",
      motivo: `${filialOrigem} sem estoque. ${filialSuporte} tem ${qtdItens === 1 ? "o item" : `todos os ${qtdItens} itens`} → Transferência inter-filial`,
      parcial: false,
    };
  }

  // Check if neither has anything
  const nenhumaTemNada = itens.every((i) => !i.cwb_atende && !i.sp_atende);

  if (nenhumaTemNada) {
    const fornecedores = [
      ...new Set(itens.map((i) => i.fornecedor_oc).filter(Boolean)),
    ];
    return {
      sugestao: "oc",
      motivo: `Sem estoque em ambas filiais → Ordem de Compra${fornecedores.length > 0 ? ` (Fornecedor: ${fornecedores.join(", ")})` : ""}`,
      parcial: false,
    };
  }

  // Partial — suggest based on which branch covers more, but ALWAYS requires human review
  const cwbCovers = itens.filter((i) => i.cwb_atende).length;
  const spCovers = itens.filter((i) => i.sp_atende).length;

  if (cwbCovers >= spCovers) {
    return {
      sugestao: filialOrigem === "CWB" ? "propria" : "transferencia",
      motivo: `Estoque parcial. CWB cobre ${cwbCovers}/${itens.length} itens, SP cobre ${spCovers}/${itens.length}`,
      parcial: true,
    };
  }

  return {
    sugestao: filialOrigem === "SP" ? "propria" : "transferencia",
    motivo: `Estoque parcial. SP cobre ${spCovers}/${itens.length} itens, CWB cobre ${cwbCovers}/${itens.length}`,
    parcial: true,
  };
}

function formatDate(dateStr: string): string {
  // Tiny sends "dd/MM/yyyy" or "yyyy-MM-dd"
  if (dateStr.includes("/")) {
    const [d, m, y] = dateStr.split("/");
    return `${y}-${m}-${d}`;
  }
  return dateStr;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
