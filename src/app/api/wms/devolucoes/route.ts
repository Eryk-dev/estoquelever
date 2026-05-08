import { NextRequest, NextResponse } from "next/server";
import { listarDevolucoesPendentes } from "@/lib/wms/devolucoes";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ rows: await listarDevolucoesPendentes() });
}
