import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { registrarEventos } from "@/lib/historico-service";
import type { StatusSeparacao } from "@/types";

/**
 * POST /api/separacao/voltar-etapa
 *
 * Admin-only: revert one or more pedidos to a previous separation stage.
 * Cleans up item-level data for the reverted stages.
 *
 * Headers: X-Session-Id
 * Body: { pedido_ids: string[], novo_status: StatusSeparacao }
 */

const STATUS_ORDER: StatusSeparacao[] = [
  "aguardando_nf",
  "aguardando_separacao",
  "em_separacao",
  "separado",
  "embalado",
];

export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  if (session.cargo !== "admin") {
    return NextResponse.json({ error: "apenas admin pode voltar etapa" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);

  // Accept both pedido_ids (array) and pedido_id (single) for backwards compat
  const pedidoIds: string[] = body?.pedido_ids ?? (body?.pedido_id ? [body.pedido_id] : []);
  const novoStatus: StatusSeparacao | undefined = body?.novo_status;

  if (pedidoIds.length === 0 || !pedidoIds.every((id: unknown) => typeof id === "string") || !novoStatus) {
    return NextResponse.json(
      { error: "'pedido_ids' (string[]) e 'novo_status' são obrigatórios" },
      { status: 400 },
    );
  }

  if (!STATUS_ORDER.includes(novoStatus)) {
    return NextResponse.json({ error: "status inválido" }, { status: 400 });
  }

  const targetIdx = STATUS_ORDER.indexOf(novoStatus);
  const supabase = createServiceClient();

  // Fetch current pedidos
  const { data: pedidos, error: fetchErr } = await supabase
    .from("siso_pedidos")
    .select("id, numero, status_separacao")
    .in("id", pedidoIds);

  if (fetchErr || !pedidos || pedidos.length === 0) {
    return NextResponse.json({ error: "pedidos_nao_encontrados" }, { status: 404 });
  }

  // Filter only pedidos that are ahead of the target status
  const validIds = pedidos
    .filter((p) => STATUS_ORDER.indexOf(p.status_separacao as StatusSeparacao) > targetIdx)
    .map((p) => p.id);

  if (validIds.length === 0) {
    return NextResponse.json(
      { error: "nenhum pedido pode ser revertido para esse status" },
      { status: 400 },
    );
  }

  try {
    // Build update for siso_pedidos
    const pedidoUpdate: Record<string, unknown> = {
      status_separacao: novoStatus,
      status_unificado: novoStatus,
    };

    if (targetIdx <= STATUS_ORDER.indexOf("aguardando_separacao")) {
      pedidoUpdate.separacao_iniciada_em = null;
      pedidoUpdate.separacao_concluida_em = null;
      pedidoUpdate.separacao_operador_id = null;
    }

    if (targetIdx < STATUS_ORDER.indexOf("separado")) {
      pedidoUpdate.separacao_concluida_em = null;
    }

    // Clear etiqueta data when reverting from embalado
    pedidoUpdate.etiqueta_status = null;
    pedidoUpdate.etiqueta_url = null;
    pedidoUpdate.etiqueta_zpl = null;

    // Update pedidos
    const { error: updateErr } = await supabase
      .from("siso_pedidos")
      .update(pedidoUpdate)
      .in("id", validIds);

    if (updateErr) {
      logger.error("voltar-etapa", "Failed to update pedidos", { error: updateErr.message });
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // Clean up item-level data
    if (targetIdx <= STATUS_ORDER.indexOf("aguardando_separacao")) {
      // Full reset: both separacao and embalagem progress
      await supabase
        .from("siso_pedido_itens")
        .update({
          separacao_marcado: false,
          separacao_marcado_em: null,
          quantidade_bipada: 0,
          bipado_completo: false,
          bipado_em: null,
          bipado_por: null,
        })
        .in("pedido_id", validIds);
    } else if (targetIdx <= STATUS_ORDER.indexOf("em_separacao")) {
      // Reset embalagem progress only
      await supabase
        .from("siso_pedido_itens")
        .update({
          quantidade_bipada: 0,
          bipado_completo: false,
          bipado_em: null,
          bipado_por: null,
        })
        .in("pedido_id", validIds);
    } else if (targetIdx <= STATUS_ORDER.indexOf("separado")) {
      await supabase
        .from("siso_pedido_itens")
        .update({
          bipado_completo: false,
          bipado_em: null,
          bipado_por: null,
        })
        .in("pedido_id", validIds);
    }

    // Record in history
    registrarEventos(
      validIds.map((pid) => {
        const original = pedidos.find((p) => p.id === pid);
        return {
          pedidoId: pid,
          evento: "status_revertido" as const,
          usuarioId: session.id,
          usuarioNome: session.nome,
          detalhes: {
            de: original?.status_separacao ?? "desconhecido",
            para: novoStatus,
          },
        };
      }),
    ).catch(() => {});

    logger.info("voltar-etapa", "Status revertido em lote", {
      pedido_ids: validIds,
      novo_status: novoStatus,
      total: String(validIds.length),
      admin: session.nome,
    });

    return NextResponse.json({
      ok: true,
      pedidos_revertidos: validIds,
      total: validIds.length,
      novo_status: novoStatus,
    });
  } catch (err) {
    logger.error("voltar-etapa", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
