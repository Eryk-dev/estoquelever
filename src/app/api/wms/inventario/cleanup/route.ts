import { NextRequest, NextResponse } from "next/server";
import { recoveryInventario } from "@/lib/wms/inventario-recovery";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("x-worker-secret");
  if (auth !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json(await recoveryInventario());
}
