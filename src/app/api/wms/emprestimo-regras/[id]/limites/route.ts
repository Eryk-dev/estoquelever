import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAuth, requireAdmin } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const sb = createServiceClient();
  const { data } = await sb
    .from("siso_emprestimo_regras")
    .select("limites_por_produto")
    .eq("id", id)
    .single();
  return NextResponse.json({
    limites:
      (data as { limites_por_produto?: Record<string, number> } | null)
        ?.limites_por_produto ?? {},
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const body = await req.json();
  if (!body.produto_id || body.qty === undefined) {
    return NextResponse.json(
      { error: "produto_id e qty obrigatórios" },
      { status: 400 },
    );
  }
  const sb = createServiceClient();
  const { data: regra } = await sb
    .from("siso_emprestimo_regras")
    .select("limites_por_produto")
    .eq("id", id)
    .single();
  const limites =
    ((regra as { limites_por_produto?: Record<string, number> } | null)
      ?.limites_por_produto ?? {}) as Record<string, number>;
  if (body.qty === null) delete limites[body.produto_id as string];
  else limites[body.produto_id as string] = Number(body.qty);
  const { error } = await sb
    .from("siso_emprestimo_regras")
    .update({ limites_por_produto: limites })
    .eq("id", id);
  if (error) {
    return wmsErrorResponse({
      source: "wms.emprestimo-regras.limites",
      error,
      requestPath: `/api/wms/emprestimo-regras/${id}/limites`,
      requestMethod: "PATCH",
      metadata: { regra_id: id, produto_id: body.produto_id },
    });
  }
  return NextResponse.json({ ok: true, limites });
}
