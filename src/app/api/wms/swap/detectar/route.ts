import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { detectarSwap } from "@/lib/wms/swap";

/**
 * GET /api/wms/swap/detectar?produto_id=&qty=&vendedora_id=&galpao_destino_id=
 *
 * Retorna oportunidades de swap simétrico pra um item, ordenadas por
 * capacidade efetiva. Não executa nada — apenas inspeciona.
 *
 * Pré-condição pra uma oportunidade aparecer:
 * - Regras siso_emprestimo_regras ativas nos DOIS sentidos entre vendedora
 *   e a empresa irmã (vendedora→irmã E irmã→vendedora).
 * - Irmã com saldo > 0 no galpão_destino, vendedora com saldo > 0 em outro galpão.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const sp = req.nextUrl.searchParams;
  const produto_id = sp.get("produto_id");
  const qtyStr = sp.get("qty");
  const vendedora_id = sp.get("vendedora_id");
  const galpao_destino_id = sp.get("galpao_destino_id");
  if (!produto_id || !qtyStr || !vendedora_id || !galpao_destino_id) {
    return NextResponse.json(
      {
        error:
          "produto_id, qty, vendedora_id, galpao_destino_id obrigatórios",
      },
      { status: 400 },
    );
  }
  const qty = Number(qtyStr);
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json(
      { error: "qty inválida" },
      { status: 400 },
    );
  }

  try {
    const oportunidades = await detectarSwap(
      produto_id,
      qty,
      vendedora_id,
      galpao_destino_id,
    );
    return NextResponse.json({ oportunidades });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.swap.detectar",
      error: e,
      requestPath: "/api/wms/swap/detectar",
      requestMethod: "GET",
      metadata: { produto_id, qty, vendedora_id, galpao_destino_id },
    });
  }
}
