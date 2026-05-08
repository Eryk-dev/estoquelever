import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sb = createServiceClient();

  const [op, loc] = await Promise.all([
    sb.rpc("wms_metricas_operador"),
    sb.rpc("wms_metricas_localizacao"),
  ]);

  return NextResponse.json({
    porOperador: op.data ?? [],
    porLocalizacao: loc.data ?? [],
  });
}
