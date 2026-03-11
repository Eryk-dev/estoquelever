import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";

/**
 * POST /api/separacao/produto-esgotado
 *
 * Marks a SKU as out of stock. Finds ALL pedidos in active separation
 * (aguardando_nf, aguardando_separacao, em_separacao) that contain this SKU,
 * moves the item to compra flow, and moves the pedido to aguardando_compra.
 *
 * Body: { sku: string }
 * Returns: { pedidos_afetados: number, itens_afetados: number }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const sku = body?.sku;

  if (!sku || typeof sku !== "string") {
    return NextResponse.json(
      { error: "Campo 'sku' obrigatorio" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const fornecedorInfo = getFornecedorBySku(sku);

  try {
    // 1. Find all pedidos in active separation
    const ACTIVE_STATUSES = [
      "aguardando_nf",
      "aguardando_separacao",
      "em_separacao",
    ];

    const { data: activePedidos, error: pedidosErr } = await supabase
      .from("siso_pedidos")
      .select("id")
      .in("status_separacao", ACTIVE_STATUSES);

    if (pedidosErr) {
      logger.error("produto-esgotado", "Erro ao buscar pedidos ativos", {
        error: pedidosErr.message,
      });
      return NextResponse.json(
        { error: "Erro ao buscar pedidos" },
        { status: 500 },
      );
    }

    const activePedidoIds = (activePedidos ?? []).map((p) => p.id);
    if (activePedidoIds.length === 0) {
      return NextResponse.json({ pedidos_afetados: 0, itens_afetados: 0 });
    }

    // 2. Find items with this SKU in those pedidos
    const { data: matchingItems, error: itemsErr } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id")
      .eq("sku", sku)
      .in("pedido_id", activePedidoIds);

    if (itemsErr) {
      logger.error("produto-esgotado", "Erro ao buscar itens", {
        error: itemsErr.message,
        sku,
      });
      return NextResponse.json(
        { error: "Erro ao buscar itens" },
        { status: 500 },
      );
    }

    if (!matchingItems || matchingItems.length === 0) {
      return NextResponse.json({ pedidos_afetados: 0, itens_afetados: 0 });
    }

    const itemIds = matchingItems.map((i) => i.id);
    const affectedPedidoIds = [
      ...new Set(matchingItems.map((i) => i.pedido_id as string)),
    ];

    // 3. Update matching items: mark for purchase
    const { error: updateItemsErr } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "aguardando_compra",
        fornecedor_oc: fornecedorInfo.fornecedor,
      })
      .in("id", itemIds);

    if (updateItemsErr) {
      logger.error("produto-esgotado", "Erro ao atualizar itens", {
        error: updateItemsErr.message,
      });
      return NextResponse.json(
        { error: "Erro ao atualizar itens" },
        { status: 500 },
      );
    }

    // 4. Reset separation state on ALL items of affected pedidos
    const { error: resetItemsErr } = await supabase
      .from("siso_pedido_itens")
      .update({
        separacao_marcado: false,
        separacao_marcado_em: null,
        bipado_completo: false,
        quantidade_bipada: 0,
      })
      .in("pedido_id", affectedPedidoIds);

    if (resetItemsErr) {
      logger.error("produto-esgotado", "Erro ao resetar itens separacao", {
        error: resetItemsErr.message,
      });
    }

    // 5. Move affected pedidos to aguardando_compra
    const { error: updatePedidosErr } = await supabase
      .from("siso_pedidos")
      .update({
        status_separacao: "aguardando_compra",
        status_unificado: "aguardando_compra",
        separacao_operador_id: null,
        separacao_iniciada_em: null,
        separacao_concluida_em: null,
      })
      .in("id", affectedPedidoIds);

    if (updatePedidosErr) {
      logger.error("produto-esgotado", "Erro ao mover pedidos", {
        error: updatePedidosErr.message,
      });
      return NextResponse.json(
        { error: "Erro ao mover pedidos" },
        { status: 500 },
      );
    }

    logger.info("produto-esgotado", "SKU marcado como esgotado", {
      sku,
      fornecedor: fornecedorInfo?.fornecedor ?? "Desconhecido",
      pedidos_afetados: affectedPedidoIds.length,
      itens_afetados: itemIds.length,
    });

    return NextResponse.json({
      pedidos_afetados: affectedPedidoIds.length,
      itens_afetados: itemIds.length,
    });
  } catch (err) {
    logger.error("produto-esgotado", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      sku,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
