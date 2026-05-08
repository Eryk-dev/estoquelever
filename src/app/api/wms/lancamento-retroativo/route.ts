import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import {
  lancarRetroativo,
  listarRetroativosPendentes,
} from "@/lib/wms/movimentacoes";

export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  if (!body.motivo || body.motivo.length < 3) {
    return NextResponse.json({ error: "motivo obrigatório" }, { status: 400 });
  }
  try {
    await lancarRetroativo({ ...body, usuario_id: auth.user.id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.lancamento-retroativo",
      error: e,
      requestPath: "/api/wms/lancamento-retroativo",
      requestMethod: "POST",
    });
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  try {
    const rows = await listarRetroativosPendentes();
    return NextResponse.json({ rows });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.lancamento-retroativo",
      error: e,
      requestPath: "/api/wms/lancamento-retroativo",
      requestMethod: "GET",
    });
  }
}
