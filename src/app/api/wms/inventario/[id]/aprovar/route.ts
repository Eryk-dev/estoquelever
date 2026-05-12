import { NextRequest, NextResponse } from "next/server";
import { aprovarSessao, computarDivergencias } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { createServiceClient } from "@/lib/supabase-server";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

// Encerra a contagem: computa divergências e tenta aprovar a sessão.
// - Se tudo bater (sem pendentes), avança pra "aprovada".
// - Se sobrar pendente, fica em "revisao" e devolve a contagem pro
//   frontend redirecionar pro /divergencias. NÃO é erro.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  let parcial = false;
  try {
    const body = (await req.json().catch(() => ({}))) as { parcial?: unknown };
    parcial = body?.parcial === true;
  } catch {
    // body opcional — ignora erro de parsing
  }
  try {
    await computarDivergencias(id, { parcial });

    const sb = createServiceClient();
    const { data: divs } = await sb
      .from("siso_inventario_divergencias")
      .select("status")
      .eq("sessao_id", id);
    type DivRow = { status: string };
    const rows = (divs ?? []) as DivRow[];
    const pendentes = rows.filter((d) => d.status === "pendente").length;
    const aprovadas = rows.filter((d) => d.status === "aprovada").length;
    const total = rows.length;

    if (pendentes > 0) {
      // Sessão fica em "revisao" — supervisor resolve as pendentes na
      // página /divergencias e depois clica "Aprovar sessão".
      return NextResponse.json({
        ok: true,
        parcial,
        status: "revisao",
        divergencias: { total, pendentes, aprovadas },
      });
    }

    // Sem pendentes → tenta avançar pra "aprovada" no mesmo POST
    await aprovarSessao(id, auth.user.id);
    return NextResponse.json({
      ok: true,
      parcial,
      status: "aprovada",
      divergencias: { total, pendentes: 0, aprovadas },
    });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.aprovar",
      error: e,
      status: 400,
      requestPath: `/api/wms/inventario/${id}/aprovar`,
      requestMethod: "POST",
      metadata: { sessao_id: id, parcial },
    });
  }
}
