import { NextRequest, NextResponse } from "next/server";
import { registrarContagem } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const body = await req.json();
  try {
    await registrarContagem({
      ...body,
      sessao_id: id,
      contada_por: auth.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    // P3 #4.3: mensagens de lock são erros de concorrência/permissão (409),
    // não de validação (400). Distingue pro client retry inteligente.
    const msg = e instanceof Error ? e.message : String(e);
    const isLockMsg =
      msg.includes("não faz parte") ||
      msg.includes("não está reivindicada") ||
      msg.includes("reivindicada por outro") ||
      msg.includes("já está em status") ||
      msg.includes("saiu da fase em andamento") ||
      msg.includes("sessão não encontrada");
    return wmsErrorResponse({
      source: "wms.inventario.contagens",
      error: e,
      status: isLockMsg ? 409 : 400,
      requestPath: `/api/wms/inventario/${id}/contagens`,
      requestMethod: "POST",
      metadata: {
        sessao_id: id,
        localizacao_id: body.localizacao_id,
        produto_id: body.produto_id,
      },
    });
  }
}
