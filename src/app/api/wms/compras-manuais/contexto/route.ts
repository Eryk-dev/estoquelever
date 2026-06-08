import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * GET /api/wms/compras-manuais/contexto
 *
 * Dropdowns do modal de compra manual: TODOS os galpões ativos + TODAS as
 * empresas ativas (independente de galpão preferencial). Gate em `compras.ver`
 * — compradores não têm `sistema.galpoes_empresas`, então não podem usar
 * /api/wms/admin/galpoes (403). Empresas vêm direto de siso_empresas, não do
 * espelho deprecado siso_empresas.galpao_id (empresas sem preferencial somem).
 */
export async function GET(req: NextRequest) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.ver")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  try {
    const sb = createServiceClient();
    const [{ data: galpoes, error: gErr }, { data: empresas, error: eErr }] =
      await Promise.all([
        sb
          .from("siso_galpoes")
          .select("id, nome")
          .eq("ativo", true)
          .order("nome"),
        sb
          .from("siso_empresas")
          .select("id, nome")
          .eq("ativo", true)
          .order("nome"),
      ]);
    if (gErr) throw gErr;
    if (eErr) throw eErr;
    return NextResponse.json({
      galpoes: galpoes ?? [],
      empresas: empresas ?? [],
    });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.compras-manuais.contexto",
      error: e,
      requestPath: "/api/wms/compras-manuais/contexto",
      requestMethod: "GET",
    });
  }
}
