import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { atualizarRegra } from "@/lib/wms/insights/queries";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!userCan(user, "insights.regras")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const { id } = await params;
  const body = (await req.json()) as {
    ativa?: boolean;
    threshold?: Record<string, unknown>;
    cooldown_min?: number;
    expira_min?: number;
  };
  const regra = await atualizarRegra(id, body);
  return NextResponse.json({ regra });
}
