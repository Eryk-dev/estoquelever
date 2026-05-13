import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { listarRegras } from "@/lib/wms/insights/queries";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.cargo !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ regras: await listarRegras() });
}
