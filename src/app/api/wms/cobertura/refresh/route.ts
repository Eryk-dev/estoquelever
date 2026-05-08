import { NextRequest, NextResponse } from "next/server";
import { refreshCobertura } from "@/lib/wms/cobertura";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("x-worker-secret");
  if (auth !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    await refreshCobertura();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
