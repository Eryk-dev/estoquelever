import { NextRequest, NextResponse } from "next/server";
import { refreshCobertura } from "@/lib/wms/cobertura";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("x-worker-secret");
  if (auth !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    await refreshCobertura();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.cobertura.refresh",
      error: e,
      category: "infrastructure",
      requestPath: "/api/wms/cobertura/refresh",
      requestMethod: "GET",
    });
  }
}
