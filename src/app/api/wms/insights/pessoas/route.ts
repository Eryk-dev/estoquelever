import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import {
  getInsightsAtivos,
  getRankingOperadores,
} from "@/lib/wms/insights/queries";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const galpaoId = sp.get("galpao_id");
  const dias = Number(sp.get("dias") ?? 7);
  const [ranking, insights] = await Promise.all([
    getRankingOperadores(galpaoId, dias),
    getInsightsAtivos("pessoas", galpaoId, 6),
  ]);
  return NextResponse.json({ ranking, insights });
}
