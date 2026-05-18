import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { criarSessao, type LocSessaoInput } from "@/lib/wms/inventario";
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

interface PostBody {
  tipo?: "cycle_count" | "completo";
  nome?: string;
  galpao_id?: string;
  empresa_dona_id?: string | null;
  modo_contagem?: "aberto" | "blind";
  tolerancia_pct?: number;
  tolerancia_qty_min?: number;
  exige_aprovacao_acima_valor?: number;
  observacoes?: string;
  localizacoes?: LocSessaoInput[];
}

export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json()) as PostBody;
  if (
    !body.tipo ||
    !body.galpao_id ||
    !Array.isArray(body.localizacoes) ||
    body.localizacoes.length === 0
  ) {
    return NextResponse.json(
      {
        error:
          "tipo, galpao_id e localizacoes (lista não-vazia de { localizacao_id, motivo? }) são obrigatórios",
      },
      { status: 400 },
    );
  }
  try {
    const id = await criarSessao({
      tipo: body.tipo,
      nome: body.nome,
      galpao_id: body.galpao_id,
      empresa_dona_id: body.empresa_dona_id,
      modo_contagem: body.modo_contagem,
      tolerancia_pct: body.tolerancia_pct,
      tolerancia_qty_min: body.tolerancia_qty_min,
      exige_aprovacao_acima_valor: body.exige_aprovacao_acima_valor,
      observacoes: body.observacoes,
      criada_por: auth.user.id,
      localizacoes: body.localizacoes,
    });
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
