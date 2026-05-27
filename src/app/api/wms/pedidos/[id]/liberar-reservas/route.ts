import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { estornarReservaIndividual } from "@/lib/wms/reservas";
import { registrarEvento } from "@/lib/historico-service";
import { logger } from "@/lib/logger";

/**
 * POST /api/wms/pedidos/[id]/liberar-reservas
 *
 * D2 override admin: libera TODAS as reservas R do pedido (sem cancelar
 * o pedido). Útil pra desbloquear estoque preso quando o pedido está com
 * algum estado fantasma e admin precisa liberar as Rs manualmente.
 *
 * Diferente de /estornar: NÃO toca em movs S e NÃO cancela o pedido.
 *
 * Requer perm: pedidos.liberar_reservas (apenas admin).
 *
 * Body: { motivo: string (≥3 chars) }
 * Returns: { ok: true, rs_liberadas: number }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!userCan(session, "pedidos.liberar_reservas")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const motivo = body?.motivo;
  if (typeof motivo !== "string" || motivo.trim().length < 3 || motivo.length > 500) {
    return NextResponse.json(
      { error: "motivo (string ≥3 e ≤500 chars) obrigatório" },
      { status: 400 },
    );
  }

  const { id: pedidoId } = await params;
  const sb = createServiceClient();

  const { data: rsRaw } = await sb
    .from("siso_movimentacoes")
    .select("id")
    .eq("origem_id", pedidoId)
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .is("estorno_de", null);

  type R = { id: string };
  const rs = (rsRaw ?? []) as R[];
  const liberadas: string[] = [];

  for (const r of rs) {
    try {
      await estornarReservaIndividual({
        reserva_id: r.id,
        motivo: "liberar_reservas_admin",
        usuario_id: session.id,
      });
      liberadas.push(r.id);
    } catch (e) {
      logger.logError({
        error: e instanceof Error ? e : new Error(String(e)),
        source: "api.pedidos.liberar-reservas",
        message: `Falha ao estornar R ${r.id}`,
        category: "business_logic",
        metadata: { pedidoId, reserva_id: r.id },
      });
    }
  }

  await registrarEvento({
    pedidoId,
    evento: "liberar_reservas_admin",
    usuarioId: session.id,
    usuarioNome: session.nome,
    detalhes: {
      motivo,
      rs_liberadas_count: liberadas.length,
      rs_total_no_pedido: rs.length,
    },
  });

  logger.info("api.pedidos.liberar-reservas", "Reservas liberadas", {
    pedidoId,
    usuario_id: session.id,
    liberadas: liberadas.length,
  });

  return NextResponse.json({ ok: true, rs_liberadas: liberadas.length });
}
