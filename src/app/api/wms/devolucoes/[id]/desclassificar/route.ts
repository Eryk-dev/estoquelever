import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/wms/auth";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { desclassificarDevolucao } from "@/lib/wms/devolucoes";

/**
 * POST /api/wms/devolucoes/[id]/desclassificar
 *
 * Body: { motivo: string }
 *
 * P3 #6.3 — Reverte classificação anterior estornando todas as movs
 * geradas por `classificarDevolucao` (match por janela temporal ±60s da
 * `classificada_em` + origem_tipo + nota_fiscal_id + produto_id quando
 * presentes). Devolução volta pra `aguardando_classificacao` permitindo
 * re-classificação imediata.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  // [P2 re-audit #6.NEW2] symmetric com classificar (gated em P4 com mesma perm)
  if (!userCan(auth.user, "operacoes.devolucoes_classificar")) {
    return NextResponse.json(
      { error: "requer permissão operacoes.devolucoes_classificar" },
      { status: 403 },
    );
  }
  const { id } = await ctx.params;

  const body = await req.json().catch(() => null);
  const motivo = typeof body?.motivo === "string" ? body.motivo.trim() : "";
  if (motivo.length < 3) {
    return NextResponse.json(
      { error: "motivo (≥3 chars) é obrigatório" },
      { status: 400 },
    );
  }

  try {
    const r = await desclassificarDevolucao({
      devolucao_id: id,
      usuario_id: auth.user.id,
      motivo,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isClient =
      msg.includes("não encontrada") ||
      msg.includes("apenas 'classificada'") ||
      msg.includes("motivo") ||
      msg.includes("classificada_em");
    return wmsErrorResponse({
      source: "wms.devolucoes.desclassificar",
      error: e,
      status: isClient ? 400 : 500,
      requestPath: `/api/wms/devolucoes/${id}/desclassificar`,
      requestMethod: "POST",
      metadata: { devolucao_id: id },
    });
  }
}
