import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { executarSnapshotInicial } from "@/lib/wms/snapshot-inicial";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user || user.cargo !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const sp = req.nextUrl.searchParams;
  const dryRun = sp.get("dryRun") === "true";
  try {
    const result = await executarSnapshotInicial({ dryRun });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
