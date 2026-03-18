import { NextRequest, NextResponse } from "next/server";
import { preCriarAgrupamentosEmLote, recarregarEtiquetasFaltantes } from "@/lib/agrupamento-service";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase-server";

const LOG_SOURCE = "separacao-retry-etiqueta";

type PedidoRetryRow = {
  id: string;
  numero: string;
  status_separacao: string | null;
  separacao_galpao_id: string | null;
  agrupamento_expedicao_id: string | null;
  expedicao_id: string | null;
  etiqueta_status: string | null;
  etiqueta_zpl: string | null;
};

type RetryStatus = "ja_disponivel" | "recuperada" | "em_andamento" | "falhou";

function parsePedidoIds(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];

  if ("pedido_id" in body && typeof body.pedido_id === "string") {
    return [body.pedido_id];
  }

  if (
    "pedido_ids" in body &&
    Array.isArray(body.pedido_ids) &&
    body.pedido_ids.length > 0 &&
    body.pedido_ids.every((id) => typeof id === "string")
  ) {
    return body.pedido_ids;
  }

  return [];
}

async function atualizarStatusEtiqueta(
  pedidoId: string,
  status: "pendente" | "falhou",
): Promise<void> {
  const supabase = createServiceClient();
  await supabase.rpc("siso_set_etiqueta_status", {
    p_pedido_id: pedidoId,
    p_status: status,
  });
}

function classificarPedido(
  row: PedidoRetryRow,
  targetedIds: Set<string>,
): RetryStatus {
  if (row.etiqueta_zpl) {
    return targetedIds.has(row.id) ? "recuperada" : "ja_disponivel";
  }

  if (row.agrupamento_expedicao_id === "pending") {
    return "em_andamento";
  }

  return "falhou";
}

/**
 * POST /api/separacao/retry-etiqueta
 *
 * Retry label acquisition for packed/separated orders that reached the final
 * stage without cached ZPL. This does not print anything.
 *
 * Headers: X-Session-Id
 * Body: { pedido_id: string } | { pedido_ids: string[] }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const pedidoIds = parsePedidoIds(body);

  if (pedidoIds.length === 0) {
    return NextResponse.json(
      { error: "envie 'pedido_id' ou 'pedido_ids'" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    const { data: pedidos, error: fetchError } = await supabase
      .from("siso_pedidos")
      .select(
        "id, numero, status_separacao, separacao_galpao_id, agrupamento_expedicao_id, expedicao_id, etiqueta_status, etiqueta_zpl",
      )
      .in("id", pedidoIds);

    if (fetchError) {
      logger.logError({
        error: fetchError,
        source: LOG_SOURCE,
        message: "Falha ao carregar pedidos para retry de etiqueta",
        category: "database",
        errorCode: fetchError.code,
        requestPath: "/api/separacao/retry-etiqueta",
        requestMethod: "POST",
        metadata: { pedidoIds },
      });
      return NextResponse.json({ error: "erro_ao_buscar_pedidos" }, { status: 500 });
    }

    const rows = (pedidos ?? []) as PedidoRetryRow[];
    const foundIds = new Set(rows.map((row) => row.id));
    const missingIds = pedidoIds.filter((id) => !foundIds.has(id));

    if (missingIds.length > 0) {
      return NextResponse.json(
        { error: "pedidos_nao_encontrados", pedido_ids: missingIds },
        { status: 404 },
      );
    }

    const wrongGalpao = !session.cargos.includes("admin")
      ? rows.filter((row) => row.separacao_galpao_id !== session.galpaoId)
      : [];

    if (wrongGalpao.length > 0) {
      return NextResponse.json(
        {
          error: "pedidos_nao_pertencem_ao_seu_galpao",
          pedido_ids: wrongGalpao.map((row) => row.id),
        },
        { status: 403 },
      );
    }

    const invalidStatus = rows.filter(
      (row) =>
        row.status_separacao !== "separado" &&
        row.status_separacao !== "embalado",
    );

    if (invalidStatus.length > 0) {
      return NextResponse.json(
        {
          error: "pedido_em_etapa_invalida",
          pedido_ids: invalidStatus.map((row) => row.id),
        },
        { status: 400 },
      );
    }

    const targetIds = rows
      .filter((row) => !row.etiqueta_zpl)
      .map((row) => row.id);

    if (targetIds.length > 0) {
      await preCriarAgrupamentosEmLote(targetIds);
      await recarregarEtiquetasFaltantes(targetIds);

      const { data: secondPassRows, error: secondPassError } = await supabase
        .from("siso_pedidos")
        .select("id, agrupamento_expedicao_id, etiqueta_zpl")
        .in("id", targetIds);

      if (secondPassError) {
        logger.logError({
          error: secondPassError,
          source: LOG_SOURCE,
          message: "Falha ao verificar segunda passada do retry de etiqueta",
          category: "database",
          errorCode: secondPassError.code,
          requestPath: "/api/separacao/retry-etiqueta",
          requestMethod: "POST",
          metadata: { pedidoIds: targetIds },
        });
        return NextResponse.json({ error: "erro_ao_validar_retry" }, { status: 500 });
      }

      const needsRecreate = (secondPassRows ?? [])
        .filter(
          (row) =>
            !row.etiqueta_zpl &&
            row.agrupamento_expedicao_id == null,
        )
        .map((row) => row.id);

      if (needsRecreate.length > 0) {
        await preCriarAgrupamentosEmLote(needsRecreate);
        await recarregarEtiquetasFaltantes(needsRecreate);
      }
    }

    const { data: finalRowsData, error: finalFetchError } = await supabase
      .from("siso_pedidos")
      .select(
        "id, numero, status_separacao, separacao_galpao_id, agrupamento_expedicao_id, expedicao_id, etiqueta_status, etiqueta_zpl",
      )
      .in("id", pedidoIds);

    if (finalFetchError) {
      logger.logError({
        error: finalFetchError,
        source: LOG_SOURCE,
        message: "Falha ao carregar resultado final do retry de etiqueta",
        category: "database",
        errorCode: finalFetchError.code,
        requestPath: "/api/separacao/retry-etiqueta",
        requestMethod: "POST",
        metadata: { pedidoIds },
      });
      return NextResponse.json({ error: "erro_ao_validar_resultado" }, { status: 500 });
    }

    const targetedIds = new Set(targetIds);
    const finalRows = (finalRowsData ?? []) as PedidoRetryRow[];
    const recoverIds = finalRows
      .filter(
        (row) =>
          classificarPedido(row, targetedIds) === "recuperada" &&
          row.etiqueta_status !== "impresso",
      )
      .map((row) => row.id);
    const pendingIds = finalRows
      .filter(
        (row) =>
          classificarPedido(row, targetedIds) === "em_andamento" &&
          row.etiqueta_status !== "impresso",
      )
      .map((row) => row.id);
    const failedIds = finalRows
      .filter(
        (row) =>
          classificarPedido(row, targetedIds) === "falhou" &&
          row.etiqueta_status !== "impresso",
      )
      .map((row) => row.id);

    await Promise.allSettled([
      ...recoverIds.map((id) => atualizarStatusEtiqueta(id, "pendente")),
      ...pendingIds.map((id) => atualizarStatusEtiqueta(id, "pendente")),
      ...failedIds.map((id) => atualizarStatusEtiqueta(id, "falhou")),
    ]);

    const pedidosResultado = finalRows.map((row) => ({
      id: row.id,
      numero: row.numero,
      status: classificarPedido(row, targetedIds),
      etiqueta_pronta: !!row.etiqueta_zpl,
      agrupamento_expedicao_id: row.agrupamento_expedicao_id,
      expedicao_id: row.expedicao_id,
    }));

    const resumo = {
      total: pedidosResultado.length,
      recuperadas: pedidosResultado.filter((row) => row.status === "recuperada").length,
      ja_disponiveis: pedidosResultado.filter((row) => row.status === "ja_disponivel").length,
      em_andamento: pedidosResultado.filter((row) => row.status === "em_andamento").length,
      falhas: pedidosResultado.filter((row) => row.status === "falhou").length,
      pedidos: pedidosResultado,
    };

    logger.info(LOG_SOURCE, "Retry de etiqueta concluído", {
      pedidoIds,
      recuperadas: resumo.recuperadas,
      jaDisponiveis: resumo.ja_disponiveis,
      emAndamento: resumo.em_andamento,
      falhas: resumo.falhas,
      usuario: session.nome,
    });

    return NextResponse.json(resumo);
  } catch (err) {
    logger.logError({
      error: err,
      source: LOG_SOURCE,
      message: "Erro inesperado no retry de etiqueta",
      category: "unknown",
      requestPath: "/api/separacao/retry-etiqueta",
      requestMethod: "POST",
      metadata: { pedidoIds },
    });
    return NextResponse.json({ error: "erro_interno" }, { status: 500 });
  }
}
