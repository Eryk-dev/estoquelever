import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase-server";
import { userCan } from "@/lib/permissions";
import { testarRegra } from "@/lib/wms/insights/queries";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!userCan(user, "insights.regras")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const { id } = await params;
  const sb = createServiceClient();
  const { data: regra, error } = await sb
    .from("siso_wms_insights_regras")
    .select("codigo, threshold")
    .eq("id", id)
    .single();
  if (error || !regra) {
    return NextResponse.json({ error: "regra não encontrada" }, { status: 404 });
  }
  // Permite override do threshold via body
  const body = (await req.json().catch(() => ({}))) as { threshold?: Record<string, unknown> };
  const threshold = body.threshold ?? (regra.threshold as Record<string, unknown>);
  try {
    const resultados = await testarRegra(regra.codigo, threshold);
    return NextResponse.json({ resultados });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
