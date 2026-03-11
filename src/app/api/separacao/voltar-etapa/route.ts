import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";
import type { StatusSeparacao } from "@/types";

/**
 * POST /api/separacao/voltar-etapa
 *
 * Admin-only: revert a pedido to a previous separation stage.
 * Cleans up item-level data for the reverted stages.
 *
 * Headers: X-Session-Id
 * Body: { pedido_id: string, novo_status: StatusSeparacao }
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
  if (!body?.pedido_id || typeof body.pedido_id !== "string" || !body?.novo_status) {
    return NextResponse.json(
      { error: "'pedido_id' e 'novo_status' são obrigatórios" },
      { status: 400 },
    );
  }

  const { pedido_id, novo_status } = body as { pedido_id: string; novo_status: StatusSeparacao };

  if (!STATUS_ORDER.includes(novo_status)) {
    return NextResponse.json({ error: "status inválido" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Fetch current pedido
  const { data: pedido, error: fetchErr } = await supabase
    .from("siso_pedidos")
    .select("id, numero, status_separacao")
    .eq("id", pedido_id)
    .single();

  if (fetchErr || !pedido) {
    return NextResponse.json({ error: "pedido_nao_encontrado" }, { status: 404 });
  }

  const currentIdx = STATUS_ORDER.indexOf(pedido.status_separacao as StatusSeparacao);
  const targetIdx = STATUS_ORDER.indexOf(novo_status);

  if (targetIdx >= currentIdx) {
    return NextResponse.json(
      { error: "novo_status deve ser anterior ao status atual", atual: pedido.status_separacao },
      { status: 400 },
    );
  }

  try {
    // Build update for siso_pedidos
    const pedidoUpdate: Record<string, unknown> = {
      status_separacao: novo_status,
    };

    // If reverting past separação stage, clear separation timestamps
    if (targetIdx <= STATUS_ORDER.indexOf("aguardando_separacao")) {
      pedidoUpdate.separacao_iniciada_em = null;
      pedidoUpdate.separacao_concluida_em = null;
      pedidoUpdate.separacao_operador_id = null;
    }

    // If reverting past separado, clear concluida timestamp
    if (targetIdx < STATUS_ORDER.indexOf("separado") && currentIdx >= STATUS_ORDER.indexOf("separado")) {
      pedidoUpdate.separacao_concluida_em = null;
    }

    // If reverting past embalado, clear etiqueta data
    if (currentIdx >= STATUS_ORDER.indexOf("embalado")) {
      pedidoUpdate.etiqueta_status = null;
      pedidoUpdate.etiqueta_url = null;
      pedidoUpdate.etiqueta_zpl = null;
    }

    // Update pedido
    const { error: updateErr } = await supabase
      .from("siso_pedidos")
      .update(pedidoUpdate)
      .eq("id", pedido_id);

    if (updateErr) {
      logger.error("voltar-etapa", "Failed to update pedido", { error: updateErr.message });
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // Clean up item-level data based on how far back we're going
    if (targetIdx <= STATUS_ORDER.indexOf("aguardando_separacao")) {
      // Going back to before separation: reset all item marks and bips
      await supabase
        .from("siso_pedido_itens")
        .update({
          separacao_marcado: false,
          separacao_marcado_em: null,
          bipado_completo: false,
          bipado_em: null,
          bipado_por: null,
        })
        .eq("pedido_id", pedido_id);
    } else if (targetIdx === STATUS_ORDER.indexOf("em_separacao")) {
      // Going back to em_separacao: keep separation marks, reset bips
      await supabase
        .from("siso_pedido_itens")
        .update({
          bipado_completo: false,
          bipado_em: null,
          bipado_por: null,
        })
        .eq("pedido_id", pedido_id);
    } else if (targetIdx === STATUS_ORDER.indexOf("separado")) {
      // Going back to separado: reset bips only
      await supabase
        .from("siso_pedido_itens")
        .update({
          bipado_completo: false,
          bipado_em: null,
          bipado_por: null,
        })
        .eq("pedido_id", pedido_id);
    }

    // Record in history
    registrarEvento({
      pedidoId: pedido_id,
      evento: "status_revertido",
      usuarioId: session.id,
      usuarioNome: session.nome,
      detalhes: {
        de: pedido.status_separacao,
        para: novo_status,
      },
    }).catch(() => {});

    logger.info("voltar-etapa", "Status revertido", {
      pedido_id,
      de: pedido.status_separacao,
      para: novo_status,
      admin: session.nome,
    });

    return NextResponse.json({
      ok: true,
      pedido_id,
      status_anterior: pedido.status_separacao,
      novo_status,
    });
  } catch (err) {
    logger.error("voltar-etapa", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
