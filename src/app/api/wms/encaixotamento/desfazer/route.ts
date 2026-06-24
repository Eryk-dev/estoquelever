import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/**
 * POST /api/wms/encaixotamento/desfazer
 *
 * Desfaz o último bip de encaixotamento (estorna as alocações). Recebe o array
 * `alocacoes` devolvido pelo bipar e decrementa quantidade_encaixotada de cada
 * item, reabrindo caixas que deixaram de estar 100%.
 *
 * Body: { alocacoes: [{ pedido_id, pedido_item_id, qty }] }
 */

export async function POST(request: NextRequest) {
  const auth = await requireWarehouseAccess(request);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const alocacoes: unknown = body?.alocacoes;

  if (!Array.isArray(alocacoes) || alocacoes.length === 0) {
    return NextResponse.json({ error: "'alocacoes' é obrigatório" }, { status: 400 });
  }

  const supabase = createServiceClient();

  try {
    const { error } = await supabase.rpc("wms_desencaixotar_atomico", {
      p_alocacoes: alocacoes,
    });
    if (error) {
      return wmsErrorResponse({
        source: "wms.encaixotamento.desfazer",
        error,
        message: "Falha ao desfazer encaixotamento",
        requestPath: "/api/wms/encaixotamento/desfazer",
        requestMethod: "POST",
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.encaixotamento.desfazer",
      error: e,
      requestPath: "/api/wms/encaixotamento/desfazer",
      requestMethod: "POST",
    });
  }
}
