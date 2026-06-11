import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { checkAndReleasePedidos } from "@/lib/compras-release";
import { checkAndCancelPedidoIfAllTerminal } from "@/lib/compras-utils";
import { userCan } from "@/lib/permissions";
import { registrarEvento } from "@/lib/historico-service";
import { estornarReservaIndividual } from "@/lib/wms/reservas";
import { resolverProdutoWms } from "@/lib/separacao/wms-mapping";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * P2-CMP-04: libera APENAS as reservas vivas do PRODUTO do item informado —
 * `liberarReserva({pedido_id})` derrubava a R de TODOS os itens do pedido
 * (multi-item compartilham pedido_id). Resolve o uuid WMS do produto (gotcha
 * #1: siso_produto_empresas por tiny_produto_id + empresa_origem_id), busca as
 * R vivas (sem L apontando) desse produto e estorna cada uma individualmente.
 * Produto não-resolvível → warn + não libera nada (conservador).
 */
async function liberarReservasDoProdutoDoItem(
  supabase: SupabaseClient,
  args: {
    pedido_id: string;
    tiny_produto_id: string;
    empresa_origem_id: string | null;
    usuario_id: string;
    source: string;
  },
): Promise<number> {
  if (!args.empresa_origem_id) {
    logger.warn(args.source, "sem empresa_origem_id — não libera reserva (conservador)", {
      pedido_id: args.pedido_id,
    });
    return 0;
  }
  let produtoWmsId: string;
  try {
    produtoWmsId = await resolverProdutoWms(args.empresa_origem_id, args.tiny_produto_id);
  } catch (e) {
    logger.warn(args.source, "produto não resolvível — não libera reserva (conservador)", {
      pedido_id: args.pedido_id,
      tiny_produto_id: args.tiny_produto_id,
      error: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }

  const { data: reservas, error: rErr } = await supabase
    .from("siso_movimentacoes")
    .select("id")
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .eq("origem_id", args.pedido_id)
    .eq("produto_id", produtoWmsId);
  if (rErr) {
    logger.warn(args.source, "falha buscando R do produto (segue)", {
      pedido_id: args.pedido_id,
      error: rErr.message,
    });
    return 0;
  }
  const ids = (reservas ?? []).map((r) => r.id as string);
  if (ids.length === 0) return 0;

  // "Viva" = sem L (estorno_de) apontando pra ela.
  const { data: ls } = await supabase
    .from("siso_movimentacoes")
    .select("estorno_de")
    .eq("tipo", "L")
    .in("estorno_de", ids);
  const liberadas = new Set(
    (ls ?? []).map((l) => l.estorno_de as string | null).filter((x): x is string => !!x),
  );

  let liberados = 0;
  for (const id of ids) {
    if (liberadas.has(id)) continue;
    try {
      await estornarReservaIndividual({ reserva_id: id, motivo: "outro", usuario_id: args.usuario_id });
      liberados++;
    } catch (e) {
      logger.warn(args.source, "falha estornando R individual (segue)", {
        reserva_id: id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return liberados;
}

/**
 * POST /api/compras/itens/[itemId]/cancelamento/confirmar
 *
 * Confirma que o item já foi cancelado externamente e o remove do fluxo local.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });

  const { itemId } = await params;
  const supabase = createServiceClient();

  try {
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, produto_id, sku, compra_status, compra_cancelamento_motivo")
      .eq("id", itemId)
      .single();

    if (itemError || !item) {
      if (itemError?.code === "PGRST116") {
        return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
      }
      throw new Error(`Erro ao buscar item: ${itemError?.message ?? "not found"}`);
    }

    if (item.compra_status !== "cancelamento_pendente") {
      return NextResponse.json(
        { error: "O item não está aguardando confirmação de cancelamento" },
        { status: 409 },
      );
    }

    // (Fase 1.4) REMOVIDO: delete de siso_pedido_item_estoques no cancelamento.
    // Tabela dropada — nada a limpar; o estoque vivo é a fonte de verdade.

    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "cancelado",
        ordem_compra_id: null,
        compra_cancelado_em: now,
        compra_cancelado_por: session.id,
        separacao_marcado: false,
        separacao_marcado_em: null,
        quantidade_bipada: 0,
        bipado_completo: false,
        bipado_em: null,
        bipado_por: null,
      })
      .eq("id", itemId)
      .select("id, sku, descricao, compra_status, compra_cancelamento_motivo")
      .single();

    if (updateError) {
      throw new Error(`Erro ao confirmar cancelamento: ${updateError.message}`);
    }

    const { pedidoCancelado } = await checkAndCancelPedidoIfAllTerminal(
      supabase,
      item.pedido_id,
      "compras-cancelamento-confirmar",
    );

    let pedidosLiberados: string[] = [];
    if (!pedidoCancelado) {
      pedidosLiberados = await checkAndReleasePedidos([itemId]);
      // P039 + P2-CMP-04: o pedido segue vivo (multi-item) e a R criada pra
      // ESTE item (via reconciliador-oc) fica órfã. Libera SÓ a R do produto
      // deste item — não a do pedido inteiro (que derrubaria os outros itens).
      const { data: pedidoR } = await supabase
        .from("siso_pedidos")
        .select("empresa_origem_id")
        .eq("id", item.pedido_id)
        .maybeSingle();
      const liberadas = await liberarReservasDoProdutoDoItem(supabase, {
        pedido_id: String(item.pedido_id),
        tiny_produto_id: String(item.produto_id),
        empresa_origem_id: (pedidoR?.empresa_origem_id as string | null) ?? null,
        usuario_id: session.id,
        source: "compras-cancelamento-confirmar",
      });
      logger.info("compras-cancelamento-confirmar", "Rs liberadas no cancelamento de item", {
        pedido_id: item.pedido_id,
        item_id: itemId,
        liberadas,
      });
    }

    await registrarEvento({
      pedidoId: item.pedido_id,
      evento: "compra_item_cancelado",
      usuarioId: session.id,
      usuarioNome: session.nome,
      detalhes: {
        item_id: itemId,
        sku: item.sku,
        motivo: item.compra_cancelamento_motivo ?? null,
      },
    });

    logger.warn("compras-cancelamento-confirmar", "Cancelamento de item confirmado", {
      itemId,
      pedidoId: item.pedido_id,
      sku: item.sku,
      pedidoCancelado,
      pedidosLiberados: pedidosLiberados.length,
    });

    return NextResponse.json({
      ok: true,
      item: updated,
      pedido_cancelado: pedidoCancelado ? item.pedido_id : null,
      pedidos_liberados: pedidosLiberados,
    });
  } catch (err) {
    logger.error("compras-cancelamento-confirmar", "Erro ao confirmar cancelamento do item", {
      error: err instanceof Error ? err.message : String(err),
      itemId,
    });
    return NextResponse.json(
      { error: "Erro interno ao confirmar cancelamento do item" },
      { status: 500 },
    );
  }
}
