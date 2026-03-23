import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { buildCompraFieldReset, cancelOcIfEmpty, hasComprasAccess } from "@/lib/compras-utils";

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
  if (!hasComprasAccess(session.cargos)) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });

  const { itemId } = await params;

  let body: { motivo?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const supabase = createServiceClient();

  try {
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select("id, sku, descricao, pedido_id, ordem_compra_id")
      .eq("id", itemId)
      .single();

    if (itemError || !item) {
      if (itemError?.code === "PGRST116") {
        return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
      }
      throw new Error(`Erro ao buscar item: ${itemError?.message ?? "not found"}`);
    }

    const ordemCompraId = item.ordem_compra_id;
    const now = new Date().toISOString();

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
      .eq("id", itemId)
      .select("id, sku, descricao, compra_status, compra_cancelamento_motivo")
      .single();

    if (updateError) {
      throw new Error(`Erro ao registrar cancelamento pendente: ${updateError.message}`);
    }

    await cancelOcIfEmpty(supabase, ordemCompraId, "compras-cancelamento");

    logger.warn("compras-cancelamento", "Item marcado para cancelamento externo", {
      itemId,
      pedidoId: item.pedido_id,
      sku: item.sku,
      motivo: body.motivo ?? null,
    });

    return NextResponse.json({ ok: true, item: updated });
  } catch (err) {
    logger.error("compras-cancelamento", "Erro ao registrar cancelamento pendente", {
      error: err instanceof Error ? err.message : String(err),
      itemId,
    });
    return NextResponse.json(
      { error: "Erro interno ao registrar cancelamento do item" },
      { status: 500 },
    );
  }
}
