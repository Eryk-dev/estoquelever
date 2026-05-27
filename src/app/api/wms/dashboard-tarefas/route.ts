// src/app/api/wms/dashboard-tarefas/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { montarDashboardTarefas } from "@/lib/wms/dashboard-tarefas";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const galpao_id = req.nextUrl.searchParams.get("galpao_id");
  const sb = createServiceClient();
  const result = await montarDashboardTarefas(sb, galpao_id || null);
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
