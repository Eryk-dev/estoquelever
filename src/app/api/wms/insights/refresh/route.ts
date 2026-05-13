import { NextRequest, NextResponse } from "next/server";
import { executarRefreshCompleto } from "@/lib/wms/insights/motor";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("x-worker-secret");
  if (auth !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const resumos = await executarRefreshCompleto();
    return NextResponse.json({ ok: true, resumos });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.insights.refresh",
      error: e,
      category: "infrastructure",
      requestPath: "/api/wms/insights/refresh",
      requestMethod: "GET",
    });
  }
}
