import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { dispensarInsight } from "@/lib/wms/insights/queries";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  await dispensarInsight(id, user.id);
  return NextResponse.json({ ok: true });
}
