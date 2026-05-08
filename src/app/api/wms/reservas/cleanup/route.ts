import { NextRequest, NextResponse } from "next/server";
import { cleanupReservasExpiradas } from "@/lib/wms/reservas";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("x-worker-secret");
  if (auth !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const result = await cleanupReservasExpiradas();
    return NextResponse.json(result);
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.reservas.cleanup",
      error: e,
      category: "infrastructure",
      requestPath: "/api/wms/reservas/cleanup",
      requestMethod: "GET",
    });
  }
}
