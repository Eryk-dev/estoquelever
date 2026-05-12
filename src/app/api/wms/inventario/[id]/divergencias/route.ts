import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAuth, requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const sb = createServiceClient();
  const sp = req.nextUrl.searchParams;
  let q = sb
    .from("siso_inventario_divergencias")
    .select(
      "*, produto:siso_produtos(sku, descricao), localizacao:siso_localizacoes(codigo)",
    )
    .eq("sessao_id", id);
  const status = sp.get("status");
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) {
    return wmsErrorResponse({
      source: "wms.inventario.divergencias",
      error,
      requestPath: `/api/wms/inventario/${id}/divergencias`,
      requestMethod: "GET",
      metadata: { sessao_id: id },
    });
  }
  return NextResponse.json({ rows: data ?? [] });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id: _sessaoId } = await params;
  void _sessaoId;
  const body = await req.json();
  if (!body.divergencia_id || !body.acao) {
    return NextResponse.json(
      { error: "divergencia_id e acao obrigatórios" },
      { status: 400 },
    );
  }
  const sb = createServiceClient();
  // Sem "recontagem" no novo fluxo — supervisor decide só aprovar/rejeitar
  // a divergência depois da contagem encerrada.
  const novoStatus =
    body.acao === "aprovar"
      ? "aprovada"
      : body.acao === "rejeitar"
        ? "rejeitada"
        : null;
  if (!novoStatus) {
    return NextResponse.json(
      { error: "acao inválida (use 'aprovar' ou 'rejeitar')" },
      { status: 400 },
    );
  }

  await sb
    .from("siso_inventario_divergencias")
    .update({
      status: novoStatus,
      resolucao_por: auth.user.id,
      resolucao_em: new Date().toISOString(),
      observacoes_resolucao: body.observacoes,
    })
    .eq("id", body.divergencia_id);

  return NextResponse.json({ ok: true });
}
