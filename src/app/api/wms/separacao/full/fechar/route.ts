import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";
import { registrarEventos } from "@/lib/historico-service";

/**
 * POST /api/wms/separacao/full/fechar
 *
 * Etapa terminal da lane Full (FULL-04). "Fechar" um Full em `separado` só
 * grava `fechado_em`/`fechado_por` e o move pra aba virtual Fechados —
 * `status_separacao` permanece `separado`. NÃO mexe em estoque nem NF (a baixa
 * já saiu no pick). Idempotente: pedido já no estado alvo é pulado (no-op).
 *
 * Body: { pedido_ids: string[], reabrir?: boolean }
 *  - reabrir=false (default): separado + fechado_em NULL → seta fechado_em/por.
 *    Requer `separacao.executar`.
 *  - reabrir=true: fechado_em NOT NULL → limpa (volta pra aba Separado).
 *    Requer `separacao.administrar` (reverte etapa).
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const pedidoIds: string[] = body?.pedido_ids ?? (body?.pedido_id ? [body.pedido_id] : []);
  const reabrir = body?.reabrir === true;

  if (pedidoIds.length === 0 || !pedidoIds.every((id: unknown) => typeof id === "string")) {
    return NextResponse.json({ error: "'pedido_ids' (string[]) é obrigatório" }, { status: 400 });
  }

  const permNecessaria = reabrir ? "separacao.administrar" : "separacao.executar";
  if (!userCan(session, permNecessaria)) {
    return NextResponse.json(
      { error: `sem permissão (${permNecessaria})` },
      { status: 403 },
    );
  }

  const supabase = createServiceClient();

  // Só pedidos Full entram — nunca fechamos/reabrimos um pedido normal.
  const { data: pedidos, error: fetchErr } = await supabase
    .from("siso_pedidos")
    .select("id, status_separacao, separacao_full, fechado_em")
    .in("id", pedidoIds)
    .eq("separacao_full", true);

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }
  if (!pedidos || pedidos.length === 0) {
    return NextResponse.json({ error: "nenhum pedido Full encontrado" }, { status: 404 });
  }

  // Idempotência: fechar só os separados-não-fechados; reabrir só os fechados.
  const alvo = pedidos.filter((p) =>
    reabrir
      ? p.fechado_em != null
      : p.status_separacao === "separado" && p.fechado_em == null,
  );
  const jaNoEstado = pedidos.length - alvo.length;

  if (alvo.length === 0) {
    return NextResponse.json({ ok: true, atualizados: [], ja_no_estado: jaNoEstado });
  }

  const alvoIds = alvo.map((p) => p.id);
  const update = reabrir
    ? { fechado_em: null, fechado_por: null }
    : { fechado_em: new Date().toISOString(), fechado_por: session.id };

  const { error: updErr } = await supabase
    .from("siso_pedidos")
    .update(update)
    .in("id", alvoIds);

  if (updErr) {
    logger.logError({
      error: updErr,
      source: "full.fechar",
      message: reabrir ? "Falha ao reabrir Full" : "Falha ao fechar Full",
      category: "database",
      errorCode: updErr.code,
      requestPath: "/api/wms/separacao/full/fechar",
      requestMethod: "POST",
      metadata: { alvoIds, reabrir },
    });
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  registrarEventos(
    alvoIds.map((pid) => ({
      pedidoId: pid,
      evento: reabrir ? ("full_reaberto" as const) : ("full_fechado" as const),
      usuarioId: session.id,
      usuarioNome: session.nome,
      detalhes: {},
    })),
  ).catch(() => {});

  return NextResponse.json({ ok: true, atualizados: alvoIds, ja_no_estado: jaNoEstado });
}
