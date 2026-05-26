import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { registrarEventos } from "@/lib/historico-service";

/**
 * POST /api/compras/comprar
 *
 * Marks items as purchased (comprado) for a supplier.
 * Qty is consolidated by SKU — distributed across order items by aging (oldest first).
 *
 * Body: {
 *   itens: Array<{ sku: string, quantidade_comprada: number }>
 * }
 *
 * Only comprador or admin can call this.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  if (!userCan(session, "compras.executar")) {
    return NextResponse.json(
      { error: "Apenas compradores podem marcar como comprado" },
      { status: 403 },
    );
  }

  const body = await request.json();
  const itens = body.itens as
    | Array<{ sku: string; quantidade_comprada: number }>
    | undefined;
  const fornecedorOc =
    typeof body.fornecedor_oc === "string" && body.fornecedor_oc.trim().length > 0
      ? body.fornecedor_oc.trim()
      : null;

  if (!itens || !Array.isArray(itens) || itens.length === 0) {
    return NextResponse.json(
      { error: "Envie { itens: [{ sku, quantidade_comprada }] }" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const now = new Date().toISOString();
  const resultados: Array<{
    sku: string;
    itens_marcados: number;
    quantidade_alocada: number;
    quantidade_excedente: number;
  }> = [];

  // Per-pedido audit aggregator (1 evento compra_item_comprado por pedido).
  const eventosPorPedido = new Map<
    string,
    { qty: number; skus: string[] }
  >();

  try {
    for (const { sku, quantidade_comprada } of itens) {
      if (!sku || quantidade_comprada <= 0) continue;

      // Fetch all order items for this SKU that are aguardando_compra
      const { data: orderItems, error: fetchErr } = await supabase
        .from("siso_pedido_itens")
        .select(
          "id, pedido_id, quantidade_pedida, compra_quantidade_solicitada, siso_pedidos(criado_em)",
        )
        .eq("sku", sku)
        .eq("compra_status", "aguardando_compra")
        .order("id"); // stable order; we'll sort by aging below

      if (fetchErr) {
        logger.error("compras-comprar", `Erro ao buscar itens do SKU ${sku}`, {
          error: fetchErr.message,
        });
        continue;
      }

      if (!orderItems || orderItems.length === 0) continue;

      // Sort by order creation date (oldest first = highest priority)
      const sorted = [...orderItems].sort((a, b) => {
        const dateA =
          (a.siso_pedidos as { criado_em?: string } | null)?.criado_em ?? "";
        const dateB =
          (b.siso_pedidos as { criado_em?: string } | null)?.criado_em ?? "";
        return dateA.localeCompare(dateB);
      });

      // Distribute quantidade_comprada across items by aging
      let remaining = quantidade_comprada;
      let marcados = 0;
      let alocado = 0;

      for (const item of sorted) {
        if (remaining <= 0) break;

        const qtySolicitada =
          Number(item.compra_quantidade_solicitada ?? 0) ||
          Number(item.quantidade_pedida ?? 0);
        const qtyParaEsteItem = Math.min(remaining, qtySolicitada);

        const { error: updateErr } = await supabase
          .from("siso_pedido_itens")
          .update({
            compra_status: "comprado",
            compra_quantidade_comprada: qtyParaEsteItem,
            comprado_em: now,
            comprado_por: session.id,
            comprado_por_nome: session.nome,
            fornecedor_oc: fornecedorOc,
          })
          .eq("id", item.id);

        if (updateErr) {
          logger.error(
            "compras-comprar",
            `Erro ao marcar item ${item.id} como comprado`,
            { error: updateErr.message },
          );
          continue;
        }

        remaining -= qtyParaEsteItem;
        marcados++;
        alocado += qtyParaEsteItem;

        const pedidoId = item.pedido_id as string;
        const cur = eventosPorPedido.get(pedidoId) ?? { qty: 0, skus: [] };
        cur.qty += qtyParaEsteItem;
        if (!cur.skus.includes(sku)) cur.skus.push(sku);
        eventosPorPedido.set(pedidoId, cur);
      }

      resultados.push({
        sku,
        itens_marcados: marcados,
        quantidade_alocada: alocado,
        quantidade_excedente: Math.max(remaining, 0),
      });
    }

    // Audit trail: 1 evento compra_item_comprado por pedido afetado.
    if (eventosPorPedido.size > 0) {
      await registrarEventos(
        Array.from(eventosPorPedido.entries()).map(([pedidoId, info]) => ({
          pedidoId,
          evento: "compra_item_comprado" as const,
          usuarioId: session.id,
          usuarioNome: session.nome,
          detalhes: {
            qty_total: info.qty,
            skus: info.skus,
          },
        })),
      );
    }

    logger.info("compras-comprar", "Itens marcados como comprado", {
      usuario: session.nome,
      total_skus: resultados.length,
      total_itens: resultados.reduce((s, r) => s + r.itens_marcados, 0),
    });

    return NextResponse.json({ ok: true, resultados });
  } catch (err) {
    logger.error("compras-comprar", "Erro ao processar compra", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Erro interno ao processar compra" },
      { status: 500 },
    );
  }
}
