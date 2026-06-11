import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { registrarEvento } from "@/lib/historico-service";
import { logger } from "@/lib/logger";

/**
 * POST /api/wms/separacao/conferencia/divergencia
 *
 * Registra divergência achada na conferência de embalagem (o pedido já está
 * 'conferido' — o bip move o status na hora; este endpoint só marca o erro).
 * O conferente arruma fisicamente na bancada; o registro conta contra o
 * embalador nas métricas. Idempotente: re-clique sobrescreve.
 *
 * Body: { pedido_id: string, tipo: TipoDivergencia, observacao?: string }
 */

const LOG_SOURCE = "conferencia-divergencia";

const TIPOS_DIVERGENCIA = [
  "produto_errado",
  "faltou_item",
  "sobrou_item",
  "quantidade_errada",
] as const;
type TipoDivergencia = (typeof TIPOS_DIVERGENCIA)[number];

export async function POST(request: NextRequest) {
  const auth = await requireWarehouseAccess(request);
  if (!auth.ok) return auth.response;
  const session = auth.user;

  const body = await request.json().catch(() => null);
  const pedidoId: unknown = body?.pedido_id;
  const tipo: unknown = body?.tipo;
  const observacao: unknown = body?.observacao;

  if (typeof pedidoId !== "string" || !pedidoId) {
    return NextResponse.json({ error: "'pedido_id' é obrigatório" }, { status: 400 });
  }
  if (typeof tipo !== "string" || !TIPOS_DIVERGENCIA.includes(tipo as TipoDivergencia)) {
    return NextResponse.json(
      { error: `'tipo' deve ser um de: ${TIPOS_DIVERGENCIA.join(", ")}` },
      { status: 400 },
    );
  }
  const obs = typeof observacao === "string" && observacao.trim() ? observacao.trim() : null;

  const supabase = createServiceClient();

  try {
    const { data: pedido } = await supabase
      .from("siso_pedidos")
      .select("id, numero, status_separacao, embalado_real_por, conferido_por")
      .eq("id", pedidoId)
      .maybeSingle();

    if (!pedido) {
      return NextResponse.json({ error: "pedido_nao_encontrado" }, { status: 404 });
    }
    if (pedido.status_separacao !== "conferido") {
      return NextResponse.json(
        {
          error: "status_invalido",
          status_atual: pedido.status_separacao,
          mensagem: "Divergência só pode ser registrada em pedido conferido",
        },
        { status: 422 },
      );
    }

    const { error: updateErr } = await supabase
      .from("siso_pedidos")
      .update({ divergencia_tipo: tipo, divergencia_obs: obs })
      .eq("id", pedidoId);

    if (updateErr) {
      logger.logError({
        error: updateErr,
        source: LOG_SOURCE,
        message: "Falha ao registrar divergência",
        category: "database",
        pedidoId,
        requestPath: "/api/wms/separacao/conferencia/divergencia",
        requestMethod: "POST",
      });
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    registrarEvento({
      pedidoId,
      evento: "conferencia_divergencia",
      usuarioId: session.id,
      usuarioNome: session.nome,
      detalhes: { tipo, observacao: obs, embalado_real_por: pedido.embalado_real_por },
    }).catch(() => {});

    return NextResponse.json({ ok: true, pedido_id: pedidoId, tipo, observacao: obs });
  } catch (err) {
    logger.logError({
      error: err,
      source: LOG_SOURCE,
      message: "Erro inesperado ao registrar divergência",
      category: "unknown",
      requestPath: "/api/wms/separacao/conferencia/divergencia",
      requestMethod: "POST",
      metadata: { pedidoId },
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
