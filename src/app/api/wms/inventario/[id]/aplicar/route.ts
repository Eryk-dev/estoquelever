import { NextRequest, NextResponse } from "next/server";
import { aplicarSessao } from "@/lib/wms/inventario";
import { requireAdmin } from "@/lib/wms/auth";

// Aplicar uma sessão escreve movs no ledger e mexe no saldo real —
// gate restrito a admin/supervisor.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const r = await aplicarSessao(id, auth.user.id);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
