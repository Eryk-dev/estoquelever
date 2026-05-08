import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAuth, requireWarehouseAccess } from "@/lib/wms/auth";

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
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
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
  const novoStatus =
    body.acao === "aprovar"
      ? "aprovada"
      : body.acao === "rejeitar"
        ? "rejeitada"
        : body.acao === "recontar"
          ? "recontagem_solicitada"
          : null;
  if (!novoStatus) {
    return NextResponse.json({ error: "acao inválida" }, { status: 400 });
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

  if (body.acao === "recontar") {
    const { data: d } = await sb
      .from("siso_inventario_divergencias")
      .select("localizacao_id, sessao_id")
      .eq("id", body.divergencia_id)
      .single();
    if (d) {
      const dr = d as { localizacao_id: string; sessao_id: string };
      await sb
        .from("siso_inventario_localizacoes")
        .update({
          status: "recontagem",
          bloqueada_por: null,
          bloqueada_em: null,
        })
        .eq("sessao_id", dr.sessao_id)
        .eq("localizacao_id", dr.localizacao_id);
    }
  }

  return NextResponse.json({ ok: true });
}
