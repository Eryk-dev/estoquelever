import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/**
 * POST /api/wms/encaixotamento/encaixotar-dia
 *
 * Atalho do encaixotamento da pista FUTURA: fecha um DIA inteiro de uma vez, sem
 * bipar. Usado quando o operador separou uma onda de UM dia só (filtro "Dias"
 * com 1 dia) — só existe uma caixa, então bipar item a item é fricção pura.
 * Deposita a qty restante de todos os itens dos pedidos futura já separados do
 * dia e fecha os 100% encaixotados. Atômico via RPC.
 *
 * Body: { dia: string }  // "YYYY-MM-DD" (SP) ou "sem" (sem prazo)
 * Resposta 200: { ok, dia, pedidos, qty_alocada, alocacoes }
 */
export async function POST(request: NextRequest) {
  const auth = await requireWarehouseAccess(request);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const dia: unknown = body?.dia;
  if (typeof dia !== "string" || !dia.trim()) {
    return NextResponse.json({ error: "'dia' é obrigatório" }, { status: 400 });
  }

  const supabase = createServiceClient();

  try {
    const { data, error } = await supabase.rpc("wms_encaixotar_dia_atomico", {
      p_dia: dia.trim(),
    });
    if (error) {
      return wmsErrorResponse({
        source: "wms.encaixotamento.dia",
        error,
        message: "Falha ao encaixotar o dia",
        requestPath: "/api/wms/encaixotamento/encaixotar-dia",
        requestMethod: "POST",
        metadata: { dia },
      });
    }

    return NextResponse.json({ ok: true, ...(data as Record<string, unknown>) });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.encaixotamento.dia",
      error: e,
      requestPath: "/api/wms/encaixotamento/encaixotar-dia",
      requestMethod: "POST",
    });
  }
}
