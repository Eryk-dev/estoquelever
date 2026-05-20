import { NextRequest, NextResponse } from "next/server";
import { sugerirLocalizacoes } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

// POST /api/wms/inventario/sugerir
// Body: { galpao_id, tamanho? }
// Resp: { localizacoes: SugestaoLoc[] }
//
// Roda o algoritmo de sugestão inteligente (mix 50/30/20 — curva A +
// divergentes recentes + sem contagem em 30d). Roda sob demanda quando o
// supervisor abre "Cycle Count Inteligente".
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  if (!body.galpao_id) {
    return NextResponse.json(
      { error: "galpao_id é obrigatório" },
      { status: 400 },
    );
  }
  try {
    const localizacoes = await sugerirLocalizacoes({
      galpao_id: body.galpao_id,
      tamanho: body.tamanho ?? 30,
    });
    return NextResponse.json({ localizacoes });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.sugerir",
      error: e,
      status: 400,
      requestPath: "/api/wms/inventario/sugerir",
      requestMethod: "POST",
      metadata: { galpao_id: body.galpao_id, tamanho: body.tamanho },
    });
  }
}
