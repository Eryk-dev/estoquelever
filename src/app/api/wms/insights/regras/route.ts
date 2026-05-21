import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { listarRegras } from "@/lib/wms/insights/queries";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!userCan(user, "insights.regras")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  return NextResponse.json({ regras: await listarRegras() });
}
