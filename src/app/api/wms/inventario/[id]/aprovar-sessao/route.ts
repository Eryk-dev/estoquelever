import { NextRequest, NextResponse } from "next/server";
import { aprovarSessao, listarOperadoresAtivos } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

// Avança a sessão de "revisao" → "aprovada" depois que o supervisor
// resolveu todas as divergências pendentes na página /divergencias.
// Validação de pendentes acontece em aprovarSessao().
//
// P3 #4.5: também aplica o gate de operadores ativos — supervisor não
// deveria aprovar uma sessão com gente ainda contando. Passar `force=true`
// no body confirma a intenção.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  let force = false;
  try {
    const body = (await req.json().catch(() => ({}))) as { force?: unknown };
    force = body?.force === true;
  } catch {
    // body opcional
  }
  try {
    if (!force) {
      const ativos = await listarOperadoresAtivos(id);
      if (ativos.length > 0) {
        return NextResponse.json(
          {
            error: `há ${ativos.length} operador(es) ativo(s) — passe force=true se confirma`,
            code: "OPERADORES_ATIVOS",
            operadores: ativos,
          },
          { status: 409 },
        );
      }
    }
    await aprovarSessao(id, auth.user.id);
    return NextResponse.json({ ok: true, status: "aprovada" });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.aprovar-sessao",
      error: e,
      status: 400,
      requestPath: `/api/wms/inventario/${id}/aprovar-sessao`,
      requestMethod: "POST",
      metadata: { sessao_id: id, force },
    });
  }
}
