import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";

/**
 * POST /api/separacao/produto-esgotado
 *
 * Marks a SKU as out of stock. Finds ALL pedidos in active separation
 * (aguardando_nf, aguardando_separacao, em_separacao) that contain this SKU,
 * moves the item to compra flow (compra_status + fornecedor_oc), and moves
 * the pedido to aguardando_compra. Items appear in the compras module's
 * "Aguardando Compra" tab for the operator to create an OC.
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

    // 6. Auto-create OC and link items to it
    let ordemCompraId: string | null = null;
    const fornecedor = fornecedorInfo.fornecedor;

    try {
      const { data: pedidoData } = await supabase
        .from("siso_pedidos")
        .select("empresa_origem_id")
        .in("id", affectedPedidoIds)
        .not("empresa_origem_id", "is", null)
        .limit(1)
        .single();

      const empresaId = pedidoData?.empresa_origem_id;

      if (empresaId) {
        // Check if there's already an open OC for this fornecedor
        const { data: existingOC } = await supabase
          .from("siso_ordens_compra")
          .select("id")
          .eq("fornecedor", fornecedor)
          .eq("empresa_id", empresaId)
          .eq("status", "aguardando_compra")
          .limit(1)
          .maybeSingle();

        if (existingOC) {
          ordemCompraId = existingOC.id;
        } else {
          const { data: newOC, error: ocError } = await supabase
            .from("siso_ordens_compra")
            .insert({
              fornecedor,
              empresa_id: empresaId,
              status: "aguardando_compra",
              observacao: `Criada automaticamente — SKU ${sku} esgotado`,
            })
            .select("id")
            .single();

          if (ocError) {
            logger.warn("produto-esgotado", "Erro ao criar OC automatica", {
              error: ocError.message,
              fornecedor,
              empresaId,
            });
          } else {
            ordemCompraId = newOC.id;
          }
        }

        // Link items to the OC
        if (ordemCompraId) {
          const { error: linkError } = await supabase
            .from("siso_pedido_itens")
            .update({ ordem_compra_id: ordemCompraId })
            .in("id", itemIds);

          if (linkError) {
            logger.warn("produto-esgotado", "Erro ao vincular itens a OC", {
              error: linkError.message,
              ordemCompraId,
            });
          }
        }
      }
    } catch (ocErr) {
      logger.warn("produto-esgotado", "Erro ao criar OC automatica (nao-critico)", {
        error: ocErr instanceof Error ? ocErr.message : String(ocErr),
        sku,
      });
    }

    logger.info("produto-esgotado", "SKU marcado como esgotado", {
      sku,
      fornecedor,
      pedidos_afetados: affectedPedidoIds.length,
      itens_afetados: itemIds.length,
      ordem_compra_id: ordemCompraId,
    });

    return NextResponse.json({
      pedidos_afetados: affectedPedidoIds.length,
      itens_afetados: itemIds.length,
      ordem_compra_id: ordemCompraId,
    });
  } catch (err) {
    logger.error("produto-esgotado", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      sku,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
