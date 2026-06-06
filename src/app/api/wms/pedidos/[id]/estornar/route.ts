import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { estornarMovimentacao } from "@/lib/wms/ledger";
import { estornarReservaIndividual } from "@/lib/wms/reservas";
import { registrarEvento } from "@/lib/historico-service";
import { logger } from "@/lib/logger";

/**
 * POST /api/wms/pedidos/[id]/estornar
 *
 * Banner D10 admin: estorna TODAS as movs (S+R) do pedido e marca pedido
 * como cancelado. Cria par de estorno simétrico no ledger (chain estorno_de),
 * sem deletar nada.
 *
 * Requer perm: pedidos.estornar (apenas admin).
 *
 * Body: { motivo: string (≥3 chars) }
 * Returns: { ok: true, movs_estornadas: number } ou { error, estornadas } (500)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!userCan(session, "pedidos.estornar")) {
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

  const { data: pedido, error: ePedido } = await sb
    .from("siso_pedidos")
    .select("id, status_separacao")
    .eq("id", pedidoId)
    .maybeSingle();
  if (ePedido) {
    return NextResponse.json({ error: ePedido.message }, { status: 500 });
  }
  if (!pedido) {
    return NextResponse.json({ error: "pedido não encontrado" }, { status: 404 });
  }

  // Lista movs ativas do pedido: S (saídas) e R (reservas) não-estornadas.
  // origem_id pode estar setado com pedido.id (Tiny ID, text). Reservas vivem
  // com origem_tipo='reserva_pedido' e tipo='R'; saídas variam mas todas têm
  // origem_id=pedido.id quando vieram pelo cutover.
  const { data: movsRaw } = await sb
    .from("siso_movimentacoes")
    .select("id, tipo, estorno_de")
    .eq("origem_id", pedidoId)
    .in("tipo", ["S", "R"])
    .is("estorno_de", null);

  type Mov = { id: string; tipo: "S" | "R"; estorno_de: string | null };
  const movs = (movsRaw ?? []) as Mov[];
  const estornadas: string[] = [];

  try {
    for (const m of movs) {
      if (m.tipo === "R") {
        await estornarReservaIndividual({
          reserva_id: m.id,
          motivo: "outro",
          usuario_id: session.id,
        });
      } else {
        await estornarMovimentacao({
          mov_id: m.id,
          usuario_id: session.id,
          motivo: `estorno_manual_admin: ${motivo}`,
        });
      }
      estornadas.push(m.id);
    }

    // P008: seta status='cancelado' (coluna que o worker-guard lê) e limpa
    // status_separacao (CHECK não admite 'cancelado'; NULL é o estado correto
    // pra um pedido cuja separação nunca chegou a acontecer).
    await sb
      .from("siso_pedidos")
      .update({ status: "cancelado", status_separacao: null })
      .eq("id", pedidoId);

    // P008: cancela o job lancar_estoque enfileirado pra que o worker não
    // re-processe (double-release). O worker-wms já é idempotente por estorno_de,
    // mas a nota é vinculante: desativar o job explicitamente.
    await sb
      .from("siso_fila_execucao")
      .update({ status: "cancelado", atualizado_em: new Date().toISOString() })
      .eq("pedido_id", pedidoId)
      .in("status", ["pendente", "executando", "erro"]);

    await registrarEvento({
      pedidoId,
      evento: "estorno_manual_admin",
      usuarioId: session.id,
      usuarioNome: session.nome,
      detalhes: {
        motivo,
        movs_estornadas_count: estornadas.length,
      },
    });

    logger.info("api.pedidos.estornar", "Pedido estornado", {
      pedidoId,
      usuario_id: session.id,
      movs_count: estornadas.length,
    });

    return NextResponse.json({ ok: true, movs_estornadas: estornadas.length });
  } catch (e) {
    logger.logError({
      error: e instanceof Error ? e : new Error(String(e)),
      source: "api.pedidos.estornar",
      message: "estorno parcial falhou",
      category: "business_logic",
      metadata: { pedidoId, estornadas_parciais: estornadas },
    });
    return NextResponse.json(
      { error: "estorno_parcial_falhou", estornadas: estornadas.length },
      { status: 500 },
    );
  }
}
