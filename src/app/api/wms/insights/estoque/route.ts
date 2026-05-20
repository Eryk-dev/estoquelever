import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase-server";
import {
  getEstoqueQuadrante,
  getInsightsAtivos,
} from "@/lib/wms/insights/queries";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const galpaoId = sp.get("galpao_id");
  // 3D: filtro por empresa_id removido — pool fungível por galpão.

  const sb = createServiceClient();
  const [quadrante, insights, statusAgg, slowMovers] = await Promise.all([
    getEstoqueQuadrante(galpaoId, 500),
    getInsightsAtivos("estoque", galpaoId, 6),
    // Distribuição por status_cobertura
    sb.from("siso_cobertura_estoque").select("status_cobertura"),
    // Top 20 slow-movers (sem saída 60d, valor desc)
    sb.rpc("wms_insight_estoque_slow_mover", { p_threshold: { dias_sem_saida: 60, min_valor: 100 } }),
  ]);

  const distribuicaoStatus = ((statusAgg.data ?? []) as Array<{ status_cobertura: string }>).reduce<
    Record<string, number>
  >((acc, r) => {
    acc[r.status_cobertura] = (acc[r.status_cobertura] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    quadrante,
    insights,
    distribuicaoStatus,
    slowMovers: slowMovers.data ?? [],
  });
}
