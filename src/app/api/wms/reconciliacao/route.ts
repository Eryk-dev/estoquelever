import { NextRequest, NextResponse } from "next/server";
import { reconciliarEstoqueComLedger } from "@/lib/wms/reconciliacao";

export async function GET(req: NextRequest) {
  // Auth via WORKER_SECRET (mesmo padrão de /api/worker)
  const auth = req.headers.get("x-worker-secret");
  if (auth !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const result = await reconciliarEstoqueComLedger({
    autoFix: req.nextUrl.searchParams.get("fix") === "true",
  });
  return NextResponse.json(result);
}
