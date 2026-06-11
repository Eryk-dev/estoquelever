import { preCriarAgrupamentosEmLote, recarregarEtiquetasFaltantes } from "@/lib/agrupamento-service";
import { registrarEventos } from "@/lib/historico-service";
import { logger } from "@/lib/logger";
import { createServiceClient } from "@/lib/supabase-server";

const LOG_SOURCE = "compras-embalagem";
const PACKABLE_STATUSES = new Set([
  "aguardando_separacao",
  "em_separacao",
  "separado",
]);
const READY_STATUS = "separado";

interface PedidoLinkRow {
  pedido_id: string;
  compra_status: string | null;
}

interface PedidoStatusRow {
  id: string;
  status_separacao: string | null;
  separacao_galpao_id: string | null;
  separacao_operador_id: string | null;
  separacao_iniciada_em: string | null;
}

export interface PrepararPedidosParaEmbalagemResult {
  pedido_ids: string[];
  preparados: string[];
  ja_separados: string[];
  ignorados: Array<{
    pedido_id: string;
    status_atual: string | null;
    motivo: string;
  }>;
  total_relacionados: number;
  galpao_id: string | null;
}

export async function prepararPedidosDasOcsParaEmbalagem(params: {
  ordemCompraIds: string[];
  /**
   * Quando presente, restringe o efeito a estes pedidos (ex.: cross-dock —
   * só os pedidos com TODOS os itens OC já recebidos). Sem ele, deriva e
   * processa todos os pedidos packable das OCs (comportamento original).
   */
  pedidoIds?: string[];
  usuarioId?: string | null;
  usuarioNome?: string | null;
}): Promise<PrepararPedidosParaEmbalagemResult> {
  const ordemCompraIds = [...new Set(params.ordemCompraIds.filter(Boolean))];
  if (ordemCompraIds.length === 0) {
    return {
      pedido_ids: [],
      preparados: [],
      ja_separados: [],
      ignorados: [],
      total_relacionados: 0,
      galpao_id: null,
    };
  }

  const supabase = createServiceClient();

  const { data: linkedRows, error: linkedError } = await supabase
    .from("siso_pedido_itens")
    .select("pedido_id, compra_status")
    .in("ordem_compra_id", ordemCompraIds);

  if (linkedError) {
    throw new Error(`Erro ao buscar pedidos das OCs: ${linkedError.message}`);
  }

  const pedidoIdsPermitidos = params.pedidoIds
    ? new Set(params.pedidoIds)
    : null;
  const pedidoIds = [...new Set(
    ((linkedRows ?? []) as PedidoLinkRow[])
      .filter((row) => row.compra_status !== "cancelado")
      .filter(
        (row) => !pedidoIdsPermitidos || pedidoIdsPermitidos.has(row.pedido_id),
      )
      .map((row) => row.pedido_id),
  )];

  if (pedidoIds.length === 0) {
    return {
      pedido_ids: [],
      preparados: [],
      ja_separados: [],
      ignorados: [],
      total_relacionados: 0,
      galpao_id: null,
    };
  }

  const { data: pedidos, error: pedidosError } = await supabase
    .from("siso_pedidos")
    .select(
      "id, status_separacao, separacao_galpao_id, separacao_operador_id, separacao_iniciada_em",
    )
    .in("id", pedidoIds);

  if (pedidosError) {
    throw new Error(`Erro ao buscar status dos pedidos: ${pedidosError.message}`);
  }

  const ignorados: PrepararPedidosParaEmbalagemResult["ignorados"] = [];
  const jaSeparados: string[] = [];
  const paraPreparar: PedidoStatusRow[] = [];
  const pedidosProntos: PedidoStatusRow[] = [];

  for (const pedido of (pedidos ?? []) as PedidoStatusRow[]) {
    if (!PACKABLE_STATUSES.has(pedido.status_separacao ?? "")) {
      ignorados.push({
        pedido_id: pedido.id,
        status_atual: pedido.status_separacao,
        motivo:
          pedido.status_separacao === "aguardando_nf"
            ? "Pedido ainda aguardando NF para poder embalar"
            : "Pedido ainda não está pronto para embalagem direta",
      });
      continue;
    }

    pedidosProntos.push(pedido);

    if (pedido.status_separacao === READY_STATUS) {
      jaSeparados.push(pedido.id);
      continue;
    }

    paraPreparar.push(pedido);
  }

  const galpaoIds = [
    ...new Set(
      pedidosProntos
        .map((pedido) => pedido.separacao_galpao_id)
        .filter(Boolean),
    ),
  ] as string[];

  if (galpaoIds.length > 1) {
    throw new Error(
      "As OCs selecionadas liberam pedidos em galpões diferentes. Faça a embalagem por galpão.",
    );
  }

  const now = new Date().toISOString();

  for (const pedido of paraPreparar) {
    const updateFields: Record<string, string | null> = {
      status_separacao: READY_STATUS,
      separacao_concluida_em: now,
    };

    if (!pedido.separacao_iniciada_em) {
      updateFields.separacao_iniciada_em = now;
    }

    if (params.usuarioId && !pedido.separacao_operador_id) {
      updateFields.separacao_operador_id = params.usuarioId;
    }

    const { error: updatePedidoError } = await supabase
      .from("siso_pedidos")
      .update(updateFields)
      .eq("id", pedido.id);

    if (updatePedidoError) {
      throw new Error(
        `Erro ao mover pedido ${pedido.id} para separado: ${updatePedidoError.message}`,
      );
    }
  }

  if (paraPreparar.length > 0) {
    const { error: updateItemsError } = await supabase
      .from("siso_pedido_itens")
      .update({
        separacao_marcado: true,
        separacao_marcado_em: now,
      })
      .in("pedido_id", paraPreparar.map((pedido) => pedido.id));

    if (updateItemsError) {
      throw new Error(
        `Erro ao preparar itens para embalagem: ${updateItemsError.message}`,
      );
    }

    registrarEventos(
      paraPreparar.map((pedido) => ({
        pedidoId: pedido.id,
        evento: "separacao_concluida" as const,
        usuarioId: params.usuarioId ?? null,
        usuarioNome: params.usuarioNome ?? null,
        detalhes: {
          origem: "compras_oc",
          ordem_compra_ids: ordemCompraIds,
        },
      })),
    ).catch(() => {});
  }

  const pedidoIdsProntos = pedidosProntos.map((pedido) => pedido.id);

  if (pedidoIdsProntos.length > 0) {
    preCriarAgrupamentosEmLote(pedidoIdsProntos).catch((err) => {
      logger.error(LOG_SOURCE, "Falha ao pré-criar agrupamentos para embalagem direta", {
        pedidoIds: pedidoIdsProntos,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    recarregarEtiquetasFaltantes(pedidoIdsProntos).catch((err) => {
      logger.error(LOG_SOURCE, "Falha ao recarregar etiquetas para embalagem direta", {
        pedidoIds: pedidoIdsProntos,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  logger.info(LOG_SOURCE, "Pedidos preparados para embalagem a partir de OCs", {
    ordemCompraIds,
    pedidoIds: pedidoIdsProntos,
    preparados: paraPreparar.map((pedido) => pedido.id),
    jaSeparados,
    ignorados: ignorados.map((item) => ({
      pedido_id: item.pedido_id,
      status_atual: item.status_atual,
    })),
    galpaoId: galpaoIds[0] ?? null,
  });

  return {
    pedido_ids: pedidoIdsProntos,
    preparados: paraPreparar.map((pedido) => pedido.id),
    ja_separados: jaSeparados,
    ignorados,
    total_relacionados: pedidoIds.length,
    galpao_id: galpaoIds[0] ?? null,
  };
}
