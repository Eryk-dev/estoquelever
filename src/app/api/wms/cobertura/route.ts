import { NextRequest, NextResponse } from "next/server";
import { listarCobertura } from "@/lib/wms/cobertura";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  return NextResponse.json({
    rows: await listarCobertura({
      status: sp.get("status") ?? undefined,
      galpao_id: sp.get("galpao_id") ?? undefined,
    }),
  });
}
