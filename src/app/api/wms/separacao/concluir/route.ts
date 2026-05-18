import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { registrarEventos } from "@/lib/historico-service";
import { preCriarAgrupamentosEmLote, recarregarEtiquetasFaltantes } from "@/lib/agrupamento-service";
import { dispararCutoverSePronto } from "@/lib/wms/cutover";
import { getSessionUser } from "@/lib/session";


/**
 * POST /api/separacao/concluir
 *
 * Finish separation for selected orders. Only pedidos where ALL items
 * have separacao_marcado = true are moved to 'separado'.
 *
 * Body: { pedido_ids: string[] }
 * Returns: { separados: string[], pendentes: string[] }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (
    !body?.pedido_ids ||
    !Array.isArray(body.pedido_ids) ||
    body.pedido_ids.length === 0 ||
    !body.pedido_ids.every((id: unknown) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "'pedido_ids' (string[]) é obrigatório" },
      { status: 400 },
    );
  }

  const { pedido_ids } = body as { pedido_ids: string[] };
  const supabase = createServiceClient();

  try {
    // Fetch all items for the given pedidos
    const { data: items, error: fetchError } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, separacao_marcado, compra_status")
      .in("pedido_id", pedido_ids);

    if (fetchError) {
      logger.logError({
        error: fetchError,
        source: "separacao-concluir",
        message: "Failed to fetch items",
        category: "database",
        errorCode: fetchError.code,
        requestPath: "/api/wms/separacao/concluir",
        requestMethod: "POST",
        metadata: { pedido_ids, table: "siso_pedido_itens" },
      });
      return NextResponse.json(
        { error: fetchError.message },
        { status: 500 },
      );
    }

    // Coleta pedidos com realocações ainda em aguardando_picking — bloqueiam concluir.
    // Sem isso, um item parcial (separacao_marcado=true) com cascade pendente passaria
    // direto pra 'separado' sem o residual ter sido pego.
    const itemIds = (items ?? []).map((i) => i.id);
    const pedidosComRealocPendente = new Set<string>();
    if (itemIds.length > 0) {
      const { data: realocsPend } = await supabase
        .from("siso_pedido_item_realocacoes")
        .select("pedido_item_id, siso_pedido_itens!inner(pedido_id)")
        .in("pedido_item_id", itemIds)
        .eq("status", "aguardando_picking");
      for (const r of realocsPend ?? []) {
        const pid = (r.siso_pedido_itens as unknown as { pedido_id: string })
          .pedido_id;
        if (pid) pedidosComRealocPendente.add(pid);
      }
    }

    // Group items by pedido_id
    const itemsByPedido = new Map<
      string,
      { separacao_marcado: boolean | null; compra_status: string | null }[]
    >();
    for (const item of items ?? []) {
      const list = itemsByPedido.get(item.pedido_id) ?? [];
      list.push({
        separacao_marcado: item.separacao_marcado,
        compra_status: item.compra_status,
      });
      itemsByPedido.set(item.pedido_id, list);
    }

    const separados: string[] = [];
    const aguardandoCompra: string[] = [];
    const pendentes: string[] = [];

    for (const pid of pedido_ids) {
      const pedidoItems = itemsByPedido.get(pid);
      if (!pedidoItems || pedidoItems.length === 0) {
        pendentes.push(pid);
        continue;
      }

      // Pedido com realocação pendente sempre fica como pendente — o residual ainda
      // precisa ser pego, mesmo que separacao_marcado já esteja true nos itens.
      if (pedidosComRealocPendente.has(pid)) {
        pendentes.push(pid);
        continue;
      }

      // Items being handled by compras module or still pending OC validation
      // (not checked for separacao_marcado — they'll be resolved separately)
      const compraItems = pedidoItems.filter(
        (i) =>
          i.compra_status === "aguardando_compra" ||
          i.compra_status === "comprado" ||
          i.compra_status === "oc_pendente",
      );
      // Normal items that need separacao_marcado check
      const normalItems = pedidoItems.filter(
        (i) =>
          i.compra_status !== "aguardando_compra" &&
          i.compra_status !== "comprado" &&
          i.compra_status !== "oc_pendente",
      );

      const allNormalMarcado =
        normalItems.length > 0
          ? normalItems.every((i) => i.separacao_marcado === true)
          : true;

      if (!allNormalMarcado) {
        pendentes.push(pid);
      } else if (compraItems.length > 0) {
        // All normal items marcado but has compra items → pause for purchases
        aguardandoCompra.push(pid);
      } else {
        // All items marcado, no compra items → fully separated
        separados.push(pid);
      }
    }

    // Update pedidos transitioning to aguardando_compra (partial — waiting for purchases)
    if (aguardandoCompra.length > 0) {
      const { error: compraError } = await supabase
        .from("siso_pedidos")
        .update({
          status_separacao: "aguardando_compra",
          // Do NOT set separacao_concluida_em — this is a partial pause, not completion
          // Do NOT reset separacao_marcado/bipado_completo — preserve pick state
        })
        .in("id", aguardandoCompra)
        .eq("status_separacao", "em_separacao");

      if (compraError) {
        logger.logError({
          error: compraError,
          source: "separacao-concluir",
          message: "Failed to update pedidos to aguardando_compra",
          category: "database",
          errorCode: compraError.code,
          requestPath: "/api/wms/separacao/concluir",
          requestMethod: "POST",
          metadata: { aguardandoCompra, table: "siso_pedidos" },
        });
        return NextResponse.json(
          { error: compraError.message },
          { status: 500 },
        );
      }
    }

    // Update fully completed pedidos to 'separado'
    if (separados.length > 0) {
      const { error: updateError } = await supabase
        .from("siso_pedidos")
        .update({
          status_separacao: "separado",
          separacao_concluida_em: new Date().toISOString(),
        })
        .in("id", separados)
        .eq("status_separacao", "em_separacao");

      if (updateError) {
        logger.logError({
          error: updateError,
          source: "separacao-concluir",
          message: "Failed to update pedidos to separado",
          category: "database",
          errorCode: updateError.code,
          requestPath: "/api/wms/separacao/concluir",
          requestMethod: "POST",
          metadata: { separados, table: "siso_pedidos" },
        });
        return NextResponse.json(
          { error: updateError.message },
          { status: 500 },
        );
      }
    }

    logger.info("separacao-concluir", "Separação concluída", {
      separados,
      aguardandoCompra,
      pendentes,
    });

    // Record history for pedidos transitioning to aguardando_compra
    if (aguardandoCompra.length > 0) {
      registrarEventos(
        aguardandoCompra.map((pid) => ({
          pedidoId: pid,
          evento: "separacao_aguardando_compra" as const,
          usuarioId: session.id,
          usuarioNome: session.nome,
        })),
      ).catch(() => {});
    }

    // Record history for completed pedidos
    if (separados.length > 0) {
      registrarEventos(
        separados.map((pid) => ({
          pedidoId: pid,
          evento: "separacao_concluida" as const,
          usuarioId: session.id,
          usuarioNome: session.nome,
        })),
      ).catch(() => {});

      // WMS cutover R→L+S: pedido entrou no conjunto forward (separado).
      // Helper é idempotente e gateado por wmsAsSource() — em modo Tiny
      // não faz nada, em WMS dispara se NF já emitida (caso normal).
      for (const pid of separados) {
        dispararCutoverSePronto(pid).catch((err) => {
          logger.warn("separacao-concluir", "Falha ao disparar cutover", {
            pedidoId: pid,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }

      // Fire-and-forget: ensure agrupamentos exist and ZPL labels are cached.
      // This is a second chance — the first attempt was at iniciar time.
      // 1. Create agrupamentos for any pedidos that don't have one yet
      preCriarAgrupamentosEmLote(separados).catch((err) => {
        logger.error("separacao-concluir", "Falha ao pré-criar agrupamentos no concluir", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // 2. Re-download ZPL for pedidos that have agrupamento but missing ZPL
      recarregarEtiquetasFaltantes(separados).catch((err) => {
        logger.error("separacao-concluir", "Falha ao recarregar etiquetas faltantes", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return NextResponse.json({ separados, aguardandoCompra, pendentes });
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-concluir",
      message: "Unexpected error in concluir",
      category: "unknown",
      requestPath: "/api/wms/separacao/concluir",
      requestMethod: "POST",
      metadata: { pedido_ids },
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
