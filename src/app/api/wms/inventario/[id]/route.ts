import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const sb = createServiceClient();
  const [sessao, areas, locs, contagens, divergencias] = await Promise.all([
    sb.from("siso_inventario_sessoes").select("*").eq("id", id).single(),
    sb
      .from("siso_inventario_areas")
      .select("*, operador:siso_usuarios(nome)")
      .eq("sessao_id", id),
    sb
      .from("siso_inventario_localizacoes")
      .select("*, localizacao:siso_localizacoes(codigo, tipo)")
      .eq("sessao_id", id),
    sb
      .from("siso_inventario_contagens")
      .select(
        "*, contada_por_user:siso_usuarios(nome), produto:siso_produtos(sku)",
      )
      .eq("sessao_id", id),
    sb
      .from("siso_inventario_divergencias")
      .select(
        "*, produto:siso_produtos(sku, descricao), localizacao:siso_localizacoes(codigo)",
      )
      .eq("sessao_id", id),
  ]);
  return NextResponse.json({
    sessao: sessao.data,
    areas: areas.data,
    localizacoes: locs.data,
    contagens: contagens.data,
    divergencias: divergencias.data,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await req.json();
  const sb = createServiceClient();
  const { error } = await sb
    .from("siso_inventario_sessoes")
    .update(body)
    .eq("id", id);
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const sb = createServiceClient();
  const { data: locs } = await sb
    .from("siso_inventario_localizacoes")
    .select("localizacao_id")
    .eq("sessao_id", id);
  const locIds = ((locs ?? []) as Array<{ localizacao_id: string }>).map(
    (l) => l.localizacao_id,
  );
  if (locIds.length > 0) {
    await sb
      .from("siso_localizacao_locks")
      .update({ finalizado_em: new Date().toISOString() })
      .in("localizacao_id", locIds)
      .is("finalizado_em", null);
  }
  await sb
    .from("siso_inventario_sessoes")
    .update({ status: "cancelada" })
    .eq("id", id);
  return NextResponse.json({ ok: true });
}
