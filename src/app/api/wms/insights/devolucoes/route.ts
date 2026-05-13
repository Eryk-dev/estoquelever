import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase-server";
import {
  getDevolucoesAgregado,
  getInsightsAtivos,
} from "@/lib/wms/insights/queries";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const galpaoId = req.nextUrl.searchParams.get("galpao_id");
  const dias = Number(req.nextUrl.searchParams.get("dias") ?? 30);
  const sb = createServiceClient();
  const [agregado, recentes, insights] = await Promise.all([
    getDevolucoesAgregado(dias),
    sb
      .from("siso_devolucoes_pendentes")
      .select("id, status, classificacao, criado_em, classificada_em, observacoes, nota_fiscal_id, pedido_origem_id")
      .gte("criado_em", new Date(Date.now() - dias * 24 * 3600_000).toISOString())
      .order("criado_em", { ascending: false })
      .limit(100),
    getInsightsAtivos("devolucoes", galpaoId, 6),
  ]);
  return NextResponse.json({
    agregado,
    recentes: recentes.data ?? [],
    insights,
  });
}
