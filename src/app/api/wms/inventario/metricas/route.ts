import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireWarehouseAccess } from "@/lib/wms/auth";

export async function GET(req: NextRequest) {
  // Auth + perm (finding 4.16)
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

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
