import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { atualizarStatusPedido } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { cancelOcIfEmpty } from "@/lib/compras-utils";
import { userCan } from "@/lib/permissions";
import { registrarEvento } from "@/lib/historico-service";
import { estornarMovimentacao } from "@/lib/wms/ledger";
import { estornarReservaIndividual } from "@/lib/wms/reservas";

/**
 * POST /api/compras/pedidos/[pedidoId]/cancelar
 *
 * Cancela o pedido inteiro no Tiny e limpa o fluxo local de compras.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ pedidoId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });

  const { pedidoId } = await params;
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

    // Estorna movs E nf_compra associadas aos itens recebidos (PR-1/PR-2).
    // Sem isso, saldo fica "fantasma" no galpão após cancelar.
    let movsEstornadas = 0;
    const itensComEstoque = (compraItems ?? []).filter(
      (i) => (i.compra_quantidade_recebida ?? 0) > 0,
    );
    if (itensComEstoque.length > 0) {
      // Carrega TODAS as movs E nf_compra que essa OC/item gerou no ledger
      // (origem_id = pedido_id). Filtra por pedido_item_id via origem_detalhes
      // dentro do loop pra evitar query por item.
      const { data: movsE } = await supabase
        .from("siso_movimentacoes")
        .select("id, estorno_de, origem_detalhes")
        .eq("origem_tipo", "nf_compra")
        .eq("origem_id", pedidoId);
      for (const item of itensComEstoque) {
        for (const mov of movsE ?? []) {
          // Pula movs que já têm estorno OU que são elas mesmas estornos
          if (mov.estorno_de) continue;
          const detalhes = (mov.origem_detalhes ?? {}) as {
            pedido_item_id?: string | number;
          };
          if (String(detalhes.pedido_item_id ?? "") !== String(item.id)) continue;

          try {
            await estornarMovimentacao({
              mov_id: mov.id as string,
              usuario_id: session.id,
              motivo: `Cancelamento pedido ${pedidoId} — estorno de OC recebida`,
            });
            movsEstornadas++;
          } catch (estErr) {
            const msg = estErr instanceof Error ? estErr.message : String(estErr);
            if (/já\s+(é\s+um\s+estorno|foi\s+estornada)/i.test(msg)) {
              continue;
            }
            logger.error("compras-cancelar-pedido", "falha estornando mov", {
              pedidoId,
              mov_id: mov.id,
              error: msg,
            });
          }
        }
      }
      logger.info(
        "compras-cancelar-pedido",
        "movs E estornadas no cancelamento",
        {
          pedidoId,
          movs_estornadas: movsEstornadas,
          itens_com_estoque: itensComEstoque.length,
        },
      );
    }

    await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "cancelado",
        ordem_compra_id: null,
      })
      .eq("pedido_id", pedidoId)
      .not("compra_status", "is", null);

    for (const ocId of affectedOcIds) {
      await cancelOcIfEmpty(supabase, ocId, "compras-cancelar-pedido");
    }

    await supabase
      .from("siso_pedidos")
      .update({
        status: "cancelado",
        status_separacao: null,
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

    // P039 correlato: libera as R vivas do pedido no ato do cancelamento.
    // estornarReservaIndividual é idempotente por estorno_de.
    {
      const { data: reservasAbertas } = await supabase
        .from("siso_movimentacoes")
        .select("id")
        .eq("tipo", "R")
        .eq("origem_tipo", "reserva_pedido")
        .eq("origem_id", String(pedidoId));
      for (const r of (reservasAbertas ?? []) as Array<{ id: string }>) {
        try {
          await estornarReservaIndividual({ reserva_id: r.id, motivo: "outro", usuario_id: session.id });
        } catch (e) {
          logger.warn("compras-cancelar-pedido", "falha estornando R no cancelamento (segue)", {
            pedidoId,
            reserva_id: r.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    await registrarEvento({
      pedidoId,
      evento: "compra_pedido_cancelado",
      usuarioId: session.id,
      usuarioNome: session.nome,
      detalhes: {
        affected_oc_ids: affectedOcIds,
        had_stock_entrada: hadStockEntrada,
      },
    });

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
