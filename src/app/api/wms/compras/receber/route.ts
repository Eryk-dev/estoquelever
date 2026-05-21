import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { checkAndReleasePedidos } from "@/lib/compras-release";
import { userCan } from "@/lib/permissions";

/**
 * POST /api/compras/receber
 *
 * Confirms receiving of purchased items. Supports partial receiving.
 * Allocates received qty to orders by aging (oldest first).
 * Identifies and releases orders where all purchase items are now received.
 *
 * Body: {
 *   itens: Array<{ sku: string, quantidade_recebida: number, observacao?: string }>
 * }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const body = await request.json();
  const itens = body.itens as
    | Array<{ sku: string; quantidade_recebida: number; observacao?: string }>
    | undefined;

  if (!itens || !Array.isArray(itens) || itens.length === 0) {
    return NextResponse.json(
      { error: "Envie { itens: [{ sku, quantidade_recebida }] }" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const allAffectedItemIds: string[] = [];
  const recebimentoLog: Array<{
    sku: string;
    itens_atualizados: number;
    quantidade_alocada: number;
  }> = [];

  try {
    for (const { sku, quantidade_recebida, observacao } of itens) {
      if (!sku || quantidade_recebida <= 0) continue;

      // Fetch all order items for this SKU that are "comprado" (awaiting delivery)
      const { data: orderItems, error: fetchErr } = await supabase
        .from("siso_pedido_itens")
        .select(
          "id, pedido_id, compra_quantidade_solicitada, compra_quantidade_recebida, compra_quantidade_comprada, quantidade_pedida, siso_pedidos(criado_em)",
        )
        .eq("sku", sku)
        .eq("compra_status", "comprado");

      if (fetchErr || !orderItems || orderItems.length === 0) continue;

      // Sort by order creation date (oldest first)
      const sorted = [...orderItems].sort((a, b) => {
        const dateA =
          (a.siso_pedidos as { criado_em?: string } | null)?.criado_em ?? "";
        const dateB =
          (b.siso_pedidos as { criado_em?: string } | null)?.criado_em ?? "";
        return dateA.localeCompare(dateB);
      });

      // Distribute received qty across items by aging
      let remaining = quantidade_recebida;
      let atualizados = 0;
      let alocado = 0;

      for (const item of sorted) {
        if (remaining <= 0) break;

        const qtySolicitada =
          Number(item.compra_quantidade_solicitada ?? 0) ||
          Number(item.quantidade_pedida ?? 0);
        const jaRecebido = Number(item.compra_quantidade_recebida ?? 0);
        const faltante = Math.max(qtySolicitada - jaRecebido, 0);

        if (faltante <= 0) continue;

        const qtyParaEsteItem = Math.min(remaining, faltante);
        const novoRecebido = jaRecebido + qtyParaEsteItem;
        const todosRecebidos = novoRecebido >= qtySolicitada;

        const updateData: Record<string, unknown> = {
          compra_quantidade_recebida: novoRecebido,
        };

        if (todosRecebidos) {
          updateData.compra_status = "recebido";
        }

        if (observacao) {
          updateData.compra_equivalente_observacao = observacao;
        }

        const { error: updateErr } = await supabase
          .from("siso_pedido_itens")
          .update(updateData)
          .eq("id", item.id);

        if (updateErr) {
          logger.error("compras-receber", `Erro ao atualizar item ${item.id}`, {
            error: updateErr.message,
          });
          continue;
        }

        allAffectedItemIds.push(String(item.id));
        remaining -= qtyParaEsteItem;
        atualizados++;
        alocado += qtyParaEsteItem;
      }

      recebimentoLog.push({
        sku,
        itens_atualizados: atualizados,
        quantidade_alocada: alocado,
      });
    }

    // Check which pedidos are now fully received and can be released
    const pedidosDesbloqueados = await checkAndReleasePedidos(allAffectedItemIds);

    logger.info("compras-receber", "Recebimento confirmado", {
      usuario: session.nome,
      total_skus: recebimentoLog.length,
      total_itens: recebimentoLog.reduce((s, r) => s + r.itens_atualizados, 0),
      pedidos_desbloqueados: pedidosDesbloqueados.length,
    });

    return NextResponse.json({
      ok: true,
      recebimento: recebimentoLog,
      pedidos_desbloqueados: pedidosDesbloqueados,
    });
  } catch (err) {
    logger.error("compras-receber", "Erro ao processar recebimento", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Erro interno ao processar recebimento" },
      { status: 500 },
    );
  }
}

