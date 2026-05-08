import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { criarSessaoInventario } from "@/lib/wms/inventario";
import { requireAuth, requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const sb = createServiceClient();
  const sp = req.nextUrl.searchParams;
  let q = sb
    .from("siso_inventario_sessoes")
    .select(
      "*, galpao:siso_galpoes(nome), criada_por_user:siso_usuarios!siso_inventario_sessoes_criada_por_fkey(nome)",
    )
    .order("criado_em", { ascending: false })
    .limit(100);
  const status = sp.get("status");
  const galpaoId = sp.get("galpao_id");
  if (status) q = q.eq("status", status);
  if (galpaoId) q = q.eq("galpao_id", galpaoId);
  const { data, error } = await q;
  if (error) {
    return wmsErrorResponse({
      source: "wms.inventario",
      error,
      requestPath: "/api/wms/inventario",
      requestMethod: "GET",
    });
  }
  return NextResponse.json({ rows: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  if (!body.tipo || !body.galpao_id || !Array.isArray(body.areas)) {
    return NextResponse.json(
      { error: "tipo, galpao_id, areas obrigatórios" },
      { status: 400 },
    );
  }
  try {
    const id = await criarSessaoInventario({ ...body, criada_por: auth.user.id });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.criar",
      error: e,
      status: 400,
      requestPath: "/api/wms/inventario",
      requestMethod: "POST",
      metadata: { tipo: body.tipo, galpao_id: body.galpao_id },
    });
  }
}
