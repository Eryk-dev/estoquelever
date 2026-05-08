import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/wms/auth";
import { executarSnapshotInicial } from "@/lib/wms/snapshot-inicial";

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const sp = req.nextUrl.searchParams;
  const dryRun = sp.get("dryRun") === "true";
  try {
    const result = await executarSnapshotInicial({ dryRun });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
