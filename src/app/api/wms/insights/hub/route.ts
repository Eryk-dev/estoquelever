import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import {
  getHubKpis,
  getInsightsAtivos,
  getThroughputDiario,
} from "@/lib/wms/insights/queries";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const galpaoId = req.nextUrl.searchParams.get("galpao_id");
  const [kpis, insights, throughput] = await Promise.all([
    getHubKpis(galpaoId),
    getInsightsAtivos("all", galpaoId, 6),
    getThroughputDiario(galpaoId, 30),
  ]);
  return NextResponse.json({ kpis, insights, throughput_30d: throughput });
}
