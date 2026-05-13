import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import {
  getFunilEtapas,
  getInsightsAtivos,
  getLeadTimePercentis,
  getThroughputDiario,
  getThroughputHora,
} from "@/lib/wms/insights/queries";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const galpaoId = sp.get("galpao_id");
  const dias = Number(sp.get("dias") ?? 7);
  const [funil, leadTime, throughputDia, throughputHora, insights] = await Promise.all([
    getFunilEtapas(galpaoId, dias),
    getLeadTimePercentis(galpaoId),
    getThroughputDiario(galpaoId, 30),
    getThroughputHora(galpaoId),
    getInsightsAtivos("fluxo", galpaoId, 6),
  ]);
  return NextResponse.json({ funil, leadTime, throughputDia, throughputHora, insights });
}
