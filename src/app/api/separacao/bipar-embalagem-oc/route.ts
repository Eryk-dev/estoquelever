import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { buscarEImprimirEtiqueta, imprimirEtiquetaDireta } from "@/lib/etiqueta-service";
import { registrarEvento } from "@/lib/historico-service";
import { kickWorker } from "@/lib/execution-worker";

const LOG_SOURCE = "bipar-embalagem-oc";

/**
 * POST /api/separacao/bipar-embalagem-oc
 *
 * Process a barcode scan for direct packing of OC (aguardando_compra) orders.
 * Finds the oldest matching pedido among provided IDs, increments quantities,
 * and auto-resolves the full OC lifecycle when a pedido completes.
 *
 * Headers: X-Session-Id
 * Body: { sku: string, pedido_ids: string[], quantidade?: number }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  // Validate sku
  if (!body?.sku || typeof body.sku !== "string") {
    return NextResponse.json(
      { error: "'sku' (string) é obrigatório" },
      { status: 400 },
    );
  }

  // Validate pedido_ids
  if (
    !body.pedido_ids ||
    !Array.isArray(body.pedido_ids) ||
    body.pedido_ids.length === 0 ||
    !body.pedido_ids.every((id: unknown) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "'pedido_ids' (string[]) é obrigatório" },
      { status: 400 },
    );
  }

  const sku: string = body.sku.trim().toUpperCase();
  const pedido_ids: string[] = body.pedido_ids;
  const quantidade: number =
    typeof body.quantidade === "number" && body.quantidade > 0
      ? body.quantidade
      : 1;

  const supabase = createServiceClient();

  try {
    // ── 1. Find oldest pedido with matching SKU among provided IDs ──
    // Fetch pedidos that are aguardando_compra, ordered by data_pedido asc (oldest first)
    const { data: pedidos, error: pedidosErr } = await supabase
      .from("siso_pedidos")
      .select("id, numero, empresa_origem_id, data_pedido, etiqueta_zpl, etiqueta_url, separacao_tags")
      .in("id", pedido_ids)
      .eq("status_separacao", "aguardando_compra")
      .order("data_pedido", { ascending: true });

    if (pedidosErr) {
      logger.logError({
        error: pedidosErr,
        source: LOG_SOURCE,
        message: "Failed to fetch pedidos",
        category: "database",
        errorCode: pedidosErr.code,
        requestPath: "/api/separacao/bipar-embalagem-oc",
        requestMethod: "POST",
        metadata: { pedido_ids },
      });
      return NextResponse.json({ error: pedidosErr.message }, { status: 500 });
    }

    if (!pedidos || pedidos.length === 0) {
      return NextResponse.json(
        { error: "sku_nao_encontrado" },
        { status: 404 },
      );
    }

    const pedidoIdsSorted = pedidos.map((p) => p.id);

    // Find the first pedido that has a matching item (by sku, case-insensitive)
    const { data: matchingItems, error: itemsErr } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, produto_id, sku, quantidade, quantidade_bipada, bipado_completo, compra_status")
      .in("pedido_id", pedidoIdsSorted)
      .ilike("sku", sku);

    if (itemsErr) {
      logger.logError({
        error: itemsErr,
        source: LOG_SOURCE,
        message: "Failed to fetch items",
        category: "database",
        errorCode: itemsErr.code,
        requestPath: "/api/separacao/bipar-embalagem-oc",
        requestMethod: "POST",
        metadata: { sku, pedido_ids },
      });
      return NextResponse.json({ error: itemsErr.message }, { status: 500 });
    }

    if (!matchingItems || matchingItems.length === 0) {
      return NextResponse.json(
        { error: "sku_nao_encontrado" },
        { status: 404 },
      );
    }

    // Pick the item from the oldest pedido that isn't already fully scanned
    // and isn't cancelled/indisponivel
    let targetItem: typeof matchingItems[0] | null = null;
    for (const pid of pedidoIdsSorted) {
      const item = matchingItems.find(
        (i) =>
          i.pedido_id === pid &&
          !i.bipado_completo &&
          i.compra_status !== "indisponivel" &&
          i.compra_status !== "cancelado",
      );
      if (item) {
        targetItem = item;
        break;
      }
    }

    if (!targetItem) {
      return NextResponse.json(
        { error: "sku_nao_encontrado" },
        { status: 404 },
      );
    }

    // ── 2. Increment quantidade_bipada atomically ──
    const newQtyBipada = (targetItem.quantidade_bipada ?? 0) + quantidade;
    const isBipadoCompleto = newQtyBipada >= targetItem.quantidade;

    const { error: updateErr } = await supabase
      .from("siso_pedido_itens")
      .update({
        quantidade_bipada: newQtyBipada,
        bipado_completo: isBipadoCompleto,
      })
      .eq("id", targetItem.id)
      .eq("quantidade_bipada", targetItem.quantidade_bipada ?? 0); // Optimistic lock

    if (updateErr) {
      logger.logError({
        error: updateErr,
        source: LOG_SOURCE,
        message: "Failed to update item quantity",
        category: "database",
        errorCode: updateErr.code,
        requestPath: "/api/separacao/bipar-embalagem-oc",
        requestMethod: "POST",
        metadata: { itemId: targetItem.id, sku },
      });
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // ── 3. Check pedido completion ──
    // Count items where bipado_completo = false, excluding indisponivel/cancelado.
    // NOTE: compra_status is NULL for most items. Using .or() to correctly
    // include NULL values (SQL: NULL NOT IN (...) returns NULL, excluding the row).
    const { count: pendingCount, error: countErr } = await supabase
      .from("siso_pedido_itens")
      .select("id", { count: "exact", head: true })
      .eq("pedido_id", targetItem.pedido_id)
      .eq("bipado_completo", false)
      .or("compra_status.is.null,compra_status.not.in.(indisponivel,cancelado)");

    if (countErr) {
      logger.logError({
        error: countErr,
        source: LOG_SOURCE,
        message: "Failed to count pending items",
        category: "database",
        errorCode: countErr.code,
        requestPath: "/api/separacao/bipar-embalagem-oc",
        requestMethod: "POST",
        metadata: { pedidoId: targetItem.pedido_id },
      });
      return NextResponse.json({ error: countErr.message }, { status: 500 });
    }

    const pedidoCompleto = (pendingCount ?? 0) === 0;

    logger.info(LOG_SOURCE, "Bip processado", {
      sku,
      pedido_id: targetItem.pedido_id,
      produto_id: targetItem.produto_id,
      quantidade_bipada: newQtyBipada,
      bipado_completo: isBipadoCompleto,
      pedido_completo: pedidoCompleto,
    });

    if (!pedidoCompleto) {
      return NextResponse.json({
        pedido_id: targetItem.pedido_id,
        produto_id: targetItem.produto_id,
        quantidade_bipada: newQtyBipada,
        bipado_completo: isBipadoCompleto,
        pedido_completo: false,
      });
    }

    // ── 4. Pedido complete — run full OC resolution ──
    const pedido = pedidos.find((p) => p.id === targetItem!.pedido_id)!;

    // (a) Auto-resolve compra items — fetch then update per item (same pattern as concluir-oc)
    const { data: ocItems } = await supabase
      .from("siso_pedido_itens")
      .select("id, compra_status, compra_quantidade_solicitada")
      .eq("pedido_id", pedido.id)
      .not("compra_status", "is", null)
      .not("compra_status", "in", "(recebido,cancelado)");

    if (ocItems) {
      for (const item of ocItems) {
        await supabase
          .from("siso_pedido_itens")
          .update({
            compra_status: "recebido",
            compra_quantidade_recebida: item.compra_quantidade_solicitada ?? 0,
          })
          .eq("id", item.id);
      }
    }

    // (b) Determine decisao_final
    let decisao: "propria" | "transferencia" = "propria";
    let separacaoGalpaoId: string | null = null;
    let empresaExecId = pedido.empresa_origem_id;

    // Fetch empresa's galpao
    let pedidoGalpaoId: string | null = null;
    if (pedido.empresa_origem_id) {
      const { data: empresa } = await supabase
        .from("siso_empresas")
        .select("galpao_id")
        .eq("id", pedido.empresa_origem_id)
        .single();
      pedidoGalpaoId = empresa?.galpao_id ?? null;
    }

    // Fetch OC galpao
    const { data: ocOrders } = await supabase
      .from("siso_pedido_itens")
      .select("ordem_compra_id")
      .eq("pedido_id", pedido.id)
      .not("ordem_compra_id", "is", null);

    const ocIds = [...new Set((ocOrders ?? []).map((i) => i.ordem_compra_id).filter(Boolean))];
    let ocGalpaoId: string | null = null;

    if (ocIds.length > 0) {
      const { data: ocs } = await supabase
        .from("siso_ordens_compra")
        .select("galpao_id")
        .in("id", ocIds)
        .limit(1);
      ocGalpaoId = ocs?.[0]?.galpao_id ?? null;
    }

    if (ocGalpaoId && pedidoGalpaoId && ocGalpaoId !== pedidoGalpaoId) {
      // (c) Different galpao → transferencia
      decisao = "transferencia";
      separacaoGalpaoId = ocGalpaoId;

      // Find active empresa in OC galpao
      const { data: empresaOcGalpao } = await supabase
        .from("siso_empresas")
        .select("id")
        .eq("galpao_id", ocGalpaoId)
        .eq("ativo", true)
        .order("criado_em", { ascending: true })
        .limit(1)
        .single();
      if (empresaOcGalpao) {
        empresaExecId = empresaOcGalpao.id;
      }
    } else {
      // Same galpao or no OC → propria
      decisao = "propria";
      separacaoGalpaoId = pedidoGalpaoId;
    }

    // (d) Update siso_pedidos
    const currentTags: string[] = pedido.separacao_tags ?? [];
    const newTags = currentTags.includes("embalagem direta")
      ? currentTags
      : [...currentTags, "embalagem direta"];

    const { error: pedidoUpdateErr } = await supabase
      .from("siso_pedidos")
      .update({
        status: "executando",
        status_separacao: "embalado",
        decisao_final: decisao,
        separacao_galpao_id: separacaoGalpaoId,
        embalagem_concluida_em: new Date().toISOString(),
        separacao_tags: newTags,
      })
      .eq("id", pedido.id);

    if (pedidoUpdateErr) {
      logger.logError({
        error: pedidoUpdateErr,
        source: LOG_SOURCE,
        message: "Failed to update pedido",
        category: "database",
        errorCode: pedidoUpdateErr.code,
        requestPath: "/api/separacao/bipar-embalagem-oc",
        requestMethod: "POST",
        metadata: { pedidoId: pedido.id },
      });
      return NextResponse.json({ error: pedidoUpdateErr.message }, { status: 500 });
    }

    // (e) Insert execution queue job
    const { error: queueErr } = await supabase
      .from("siso_fila_execucao")
      .insert({
        pedido_id: pedido.id,
        empresa_id: empresaExecId,
        tipo: "lancar_estoque",
        status: "pendente",
        tentativas: 0,
        decisao,
      });

    if (queueErr) {
      logger.error(LOG_SOURCE, "Erro ao enfileirar job", {
        pedidoId: pedido.id,
        error: queueErr.message,
      });
    }

    // (f) Print label
    let etiquetaStatus: "impresso" | "falhou" = "falhou";
    let etiquetaErro: string | null = null;

    try {
      const etiqueta =
        (pedido.etiqueta_zpl || pedido.etiqueta_url) && pedido.empresa_origem_id && separacaoGalpaoId
          ? await imprimirEtiquetaDireta({
              pedidoId: pedido.id,
              numero: pedido.numero ?? pedido.id,
              empresaOrigemId: pedido.empresa_origem_id,
              agrupamentoExpedicaoId: null,
              etiquetaZpl: pedido.etiqueta_zpl ?? null,
              etiquetaUrl: pedido.etiqueta_url ?? null,
              separacaoGalpaoId: separacaoGalpaoId,
              separacaoOperadorId: session.id,
            })
          : await buscarEImprimirEtiqueta(pedido.id, session.id);

      etiquetaStatus = etiqueta.success ? "impresso" : "falhou";
      etiquetaErro = etiqueta.error ?? null;
    } catch (err) {
      etiquetaErro = err instanceof Error ? err.message : String(err);
      logger.logError({
        error: err,
        source: LOG_SOURCE,
        message: "Failed to print label",
        category: "external_api",
        requestPath: "/api/separacao/bipar-embalagem-oc",
        requestMethod: "POST",
        metadata: { pedidoId: pedido.id },
      });
    }

    // (g) Register history event
    registrarEvento({
      pedidoId: pedido.id,
      evento: "embalagem_direta_concluida",
      usuarioId: session.id,
      detalhes: { sku, decisao, etiquetaStatus },
    }).catch(() => {});

    // (h) Kick execution worker (fire-and-forget)
    kickWorker().catch((err) => {
      logger.error(LOG_SOURCE, "Worker kick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return NextResponse.json({
      pedido_id: targetItem.pedido_id,
      produto_id: targetItem.produto_id,
      quantidade_bipada: newQtyBipada,
      bipado_completo: true,
      pedido_completo: true,
      etiqueta_status: etiquetaStatus,
      etiqueta_erro: etiquetaErro,
    });
  } catch (err) {
    logger.logError({
      error: err,
      source: LOG_SOURCE,
      message: "Unexpected error in bipar-embalagem-oc",
      category: "business_logic",
      requestPath: "/api/separacao/bipar-embalagem-oc",
      requestMethod: "POST",
      metadata: { sku, pedido_ids },
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
