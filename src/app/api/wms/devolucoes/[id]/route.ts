import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * GET /api/wms/devolucoes/[id]
 *
 * Retorna detalhe de uma devolução pendente. Substitui o fetch da lista
 * inteira + .find(id) que a página /wms/devolucoes/[id] fazia (finding 5.13).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const sb = createServiceClient();
    const { data, error } = await sb
      .from("siso_devolucoes_pendentes")
      .select(
        `id, status, nota_fiscal_id, chave_acesso_nf, criado_em,
         classificacao, classificada_em, payload_webhook,
         empresa_referencia:siso_empresas!empresa_id(id, nome)`,
      )
      .eq("id", id)
      .single();
    if (error) {
      if (error.code === "PGRST116") {
        return NextResponse.json(
          { error: "não encontrada" },
          { status: 404 },
        );
      }
      throw error;
    }
    return NextResponse.json({ devolucao: data });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.devolucoes.detalhe",
      error: e,
      requestPath: `/api/wms/devolucoes/${id}`,
      requestMethod: "GET",
      metadata: { devolucao_id: id },
    });
  }
}
