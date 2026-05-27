import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { reconciliarRetroativo } from "@/lib/wms/movimentacoes";
import { createServiceClient } from "@/lib/supabase-server";

// UUID v1-5 (qualquer versão válida) — mesma forma usada em ledger.assertUuidLike.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Auth + perm granular (finding 8.9)
  const session = await getSessionUser(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!userCan(session, "operacoes.retroativo")) {
    return NextResponse.json({ error: "forbidden — requer operacoes.retroativo" }, { status: 403 });
  }
  const auth = { user: session };

  const { id } = await params;
  const body = await req.json();
  if (!body.compra_mov_id) {
    return NextResponse.json({ error: "compra_mov_id obrigatório" }, { status: 400 });
  }
  const compraMovId = String(body.compra_mov_id);
  if (!UUID_RE.test(compraMovId)) {
    return NextResponse.json(
      { error: "compra_mov_id não é um uuid válido" },
      { status: 400 },
    );
  }

  // Existência: a mov precisa estar no ledger pra preservar a trilha de auditoria.
  const sb = createServiceClient();
  const { data: compraRow, error: compraErr } = await sb
    .from("siso_movimentacoes")
    .select("id, origem_tipo")
    .eq("id", compraMovId)
    .maybeSingle();
  if (compraErr) {
    return wmsErrorResponse({
      source: "wms.lancamento-retroativo.reconciliar",
      error: compraErr,
      status: 500,
      requestPath: `/api/wms/lancamento-retroativo/${id}/reconciliar`,
      requestMethod: "POST",
      metadata: { retroativo_mov_id: id, compra_mov_id: compraMovId },
    });
  }
  if (!compraRow) {
    return NextResponse.json(
      { error: `compra_mov_id ${compraMovId} não existe em siso_movimentacoes` },
      { status: 404 },
    );
  }

  try {
    await reconciliarRetroativo({
      retroativo_mov_id: id,
      compra_mov_id: compraMovId,
      usuario_id: auth.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.lancamento-retroativo.reconciliar",
      error: e,
      status: 400,
      requestPath: `/api/wms/lancamento-retroativo/${id}/reconciliar`,
      requestMethod: "POST",
      metadata: { retroativo_mov_id: id, compra_mov_id: compraMovId },
    });
  }
}
