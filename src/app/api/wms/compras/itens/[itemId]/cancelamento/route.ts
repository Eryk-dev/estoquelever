import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { buildCompraFieldReset, cancelOcIfEmpty } from "@/lib/compras-utils";
import { userCan } from "@/lib/permissions";

/**
 * POST /api/compras/itens/[itemId]/cancelamento
 *
 * Marca um item como pendente de cancelamento externo.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });

  const { itemId } = await params;

  let body: { motivo?: string; item_ids?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  // P3-05: aceita item_ids[] no body (todos os itens do card de fornecedor),
  // mantendo compat com o itemId da rota. União dedupada.
  const bodyItemIds = Array.isArray(body.item_ids)
    ? (body.item_ids.filter(
        (x) => typeof x === "string" && x.length > 0,
      ) as string[])
    : [];
  const itemIds = [...new Set([itemId, ...bodyItemIds])];

  const supabase = createServiceClient();

  try {
    const { data: items, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select("id, sku, descricao, pedido_id, ordem_compra_id")
      .in("id", itemIds);

    if (itemError) {
      throw new Error(`Erro ao buscar itens: ${itemError.message}`);
    }
    if (!items || items.length === 0) {
      return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
    }

    const now = new Date().toISOString();
    const ordensTocadas = new Set<string>();
    const atualizados: unknown[] = [];

    for (const item of items) {
      if (item.ordem_compra_id) ordensTocadas.add(item.ordem_compra_id as string);

      const { data: updated, error: updateError } = await supabase
        .from("siso_pedido_itens")
        .update({
          ...buildCompraFieldReset(),
          compra_status: "cancelamento_pendente",
          ordem_compra_id: null,
          compra_cancelamento_motivo: body.motivo?.trim() || null,
          compra_cancelamento_solicitado_em: now,
          compra_cancelamento_solicitado_por: session.id,
        })
        .eq("id", item.id)
        .select("id, sku, descricao, compra_status, compra_cancelamento_motivo")
        .single();

      if (updateError) {
        throw new Error(`Erro ao registrar cancelamento pendente: ${updateError.message}`);
      }
      atualizados.push(updated);
    }

    for (const ocId of ordensTocadas) {
      await cancelOcIfEmpty(supabase, ocId, "compras-cancelamento");
    }

    logger.warn("compras-cancelamento", "Itens marcados para cancelamento externo", {
      itemIds,
      total: atualizados.length,
      motivo: body.motivo ?? null,
    });

    return NextResponse.json({
      ok: true,
      itens: atualizados,
      item: atualizados[0] ?? null,
    });
  } catch (err) {
    logger.error("compras-cancelamento", "Erro ao registrar cancelamento pendente", {
      error: err instanceof Error ? err.message : String(err),
      itemIds,
    });
    return NextResponse.json(
      { error: "Erro interno ao registrar cancelamento do item" },
      { status: 500 },
    );
  }
}
