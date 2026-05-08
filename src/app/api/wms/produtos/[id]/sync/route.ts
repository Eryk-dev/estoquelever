import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { sincronizarProduto } from "@/lib/wms/sync-tiny";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    await sincronizarProduto(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.produtos.sync",
      error: e,
      category: "external_api",
      requestPath: `/api/wms/produtos/${id}/sync`,
      requestMethod: "POST",
      metadata: { produto_id: id },
    });
  }
}
