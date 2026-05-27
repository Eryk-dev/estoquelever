import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { estornarSessaoInventario } from "@/lib/wms/inventario";

/**
 * POST /api/wms/inventario/[id]/estornar
 *
 * Body: { motivo: string }
 *
 * Admin-only. Reverte movs de uma sessão aplicada e recoloca divergências
 * em status='pendente'. Sessão volta pra 'revisao'.
 *
 * Idempotente: re-execução em sessão já estornada retorna 400
 * (status != 'aplicada'); re-execução durante estorno ignora movs
 * já estornadas via guard em estornarMovimentacao.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const motivo = typeof body?.motivo === "string" ? body.motivo.trim() : "";
  if (motivo.length < 3) {
    return NextResponse.json(
      { error: "motivo é obrigatório (≥3 caracteres)" },
      { status: 400 },
    );
  }

  try {
    const r = await estornarSessaoInventario({
      sessao_id: id,
      usuario_id: auth.user.id,
      motivo,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isClient =
      msg.includes("não encontrada") ||
      msg.includes("apenas 'aplicada'") ||
      msg.includes("motivo");
    return wmsErrorResponse({
      source: "wms.inventario.estornar",
      error: e,
      status: isClient ? 400 : 500,
      requestPath: `/api/wms/inventario/${id}/estornar`,
      requestMethod: "POST",
      metadata: { sessao_id: id },
    });
  }
}
