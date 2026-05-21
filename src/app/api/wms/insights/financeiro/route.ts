import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase-server";
import { userCan } from "@/lib/permissions";
import {
  getEstoqueValorAtual,
  getInsightsAtivos,
} from "@/lib/wms/insights/queries";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!userCan(user, "insights.financeiro")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const galpaoId = req.nextUrl.searchParams.get("galpao_id");
  const sb = createServiceClient();
  // 3D: KPIs de empréstimo/saldos devedores removidos — pool fungível por
  // galpão não tem credora/devedora. Resta só valor de estoque, ajustes
  // recentes e insights da categoria financeira.
  const [valor, ajustes, insights] = await Promise.all([
    getEstoqueValorAtual(galpaoId),
    sb
      .from("siso_movimentacoes")
      .select("usuario_id, origem_detalhes, criado_em, tipo, quantidade, custo_unitario")
      .eq("origem_tipo", "ajuste_manual")
      .is("estorno_de", null)
      .gte("criado_em", new Date(Date.now() - 30 * 24 * 3600_000).toISOString())
      .order("criado_em", { ascending: false })
      .limit(50),
    getInsightsAtivos("financeiro", galpaoId, 6),
  ]);
  return NextResponse.json({
    valor,
    ajustes_recentes: ajustes.data ?? [],
    insights,
  });
}
