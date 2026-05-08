import { NextRequest, NextResponse } from "next/server";
import { dashboardGeral } from "@/lib/wms/dashboard-geral";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await dashboardGeral());
}
