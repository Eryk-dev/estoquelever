import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { atualizarStatusPedido } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { COMPRAS_ALLOWED_CARGOS } from "@/lib/compras-utils";

/**
 * POST /api/compras/pedidos/[pedidoId]/cancelar
 *
 * Cancela o pedido inteiro no Tiny e limpa o fluxo local de compras.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ pedidoId: string }> },
) {
  const { pedidoId } = await params;

  let body: { cargo?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (body.cargo && !COMPRAS_ALLOWED_CARGOS.includes(body.cargo as "admin" | "comprador")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const supabase = createServiceClient();

  try {
    const { data: pedido, error: pedidoError } = await supabase
      .from("siso_pedidos")
      .select("id, empresa_origem_id, status, status_separacao")
      .eq("id", pedidoId)
      .single();

    if (pedidoError || !pedido) {
      if (pedidoError?.code === "PGRST116") {
        return NextResponse.json({ error: "Pedido não encontrado" }, { status: 404 });
      }
      throw new Error(`Erro ao buscar pedido: ${pedidoError?.message ?? "not found"}`);
    }

    if (pedido.status !== "cancelado") {
      if (!pedido.empresa_origem_id) {
        return NextResponse.json(
          { error: "Empresa de origem do pedido não encontrada" },
          { status: 400 },
        );
      }

      const { token } = await getValidTokenByEmpresa(pedido.empresa_origem_id);
      await runWithEmpresa(pedido.empresa_origem_id, () =>
        atualizarStatusPedido(token, pedidoId, "cancelado"),
      );
    }

    const { data: compraItems } = await supabase
      .from("siso_pedido_itens")
      .select("id, sku, ordem_compra_id, compra_status, compra_quantidade_recebida")
      .eq("pedido_id", pedidoId)
      .not("compra_status", "is", null);

    const affectedOcIds = [
      ...new Set(
        (compraItems ?? [])
          .map((item) => item.ordem_compra_id)
          .filter((value): value is string => value != null),
      ),
    ];

    const hadStockEntrada = (compraItems ?? []).some(
      (item) => (item.compra_quantidade_recebida ?? 0) > 0,
    );

    await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: null,
        ordem_compra_id: null,
      })
      .eq("pedido_id", pedidoId)
      .not("compra_status", "is", null);

    for (const ocId of affectedOcIds) {
      const { count } = await supabase
        .from("siso_pedido_itens")
        .select("id", { count: "exact", head: true })
        .eq("ordem_compra_id", ocId);

      if (count === 0) {
        await supabase
          .from("siso_ordens_compra")
          .update({ status: "cancelado" })
          .eq("id", ocId);
      }
    }

    await supabase
      .from("siso_pedidos")
      .update({
        status: "cancelado",
        status_separacao: pedido.status_separacao ? "cancelado" : null,
        processado_em: new Date().toISOString(),
        compra_estoque_lancado_alerta: hadStockEntrada || undefined,
      })
      .eq("id", pedidoId);

    await supabase
      .from("siso_fila_execucao")
      .update({
        status: "cancelado",
        atualizado_em: new Date().toISOString(),
      })
      .eq("pedido_id", pedidoId)
      .eq("status", "pendente");

    logger.warn("compras-cancelar-pedido", "Pedido cancelado a partir da aba de compras", {
      pedidoId,
      hadStockEntrada,
      affectedOcIds: affectedOcIds.length,
    });

    return NextResponse.json({
      ok: true,
      pedido_id: pedidoId,
      estoque_lancado_alerta: hadStockEntrada,
    });
  } catch (err) {
    logger.error("compras-cancelar-pedido", "Erro ao cancelar pedido", {
      error: err instanceof Error ? err.message : String(err),
      pedidoId,
    });
    return NextResponse.json(
      { error: "Erro interno ao cancelar pedido" },
      { status: 500 },
    );
  }
}
