import { NextRequest, NextResponse } from "next/server";
import { ultimasContagensDoProduto } from "@/lib/wms/inventario";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const rows = await ultimasContagensDoProduto(id);
    return NextResponse.json({ rows });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.produtos.ultimas-contagens",
      error: e,
      requestPath: `/api/wms/produtos/${id}/ultimas-contagens`,
      requestMethod: "GET",
      metadata: { produto_id: id },
    });
  }
}
