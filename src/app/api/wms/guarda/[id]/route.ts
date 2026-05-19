import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { obterPendencia } from "@/lib/wms/guarda";
import {
  sugerirLocalizacaoPutaway,
  listarLocaisExistentesProduto,
} from "@/lib/wms/putaway";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * GET /api/wms/guarda/[id]
 *
 * Retorna detalhe da pendência + sugestão de loc destino (putaway algorithm)
 * + lista de locs onde o produto já tem saldo (atalhos pro operador).
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;

  try {
    const pend = await obterPendencia(id);
    if (!pend) {
      return NextResponse.json(
        { error: "pendência não encontrada" },
        { status: 404 },
      );
    }
    const sb = createServiceClient();
    const [sugestao, locaisExistentes] = await Promise.all([
      sugerirLocalizacaoPutaway(sb as never, {
        produto_id: pend.produto_id,
        empresa_id: pend.empresa_dona_id,
        galpao_id: pend.galpao_id,
      }),
      listarLocaisExistentesProduto(sb as never, {
        produto_id: pend.produto_id,
        empresa_id: pend.empresa_dona_id,
        galpao_id: pend.galpao_id,
      }),
    ]);
    // Defesa em profundidade: sugerirLocalizacaoPutaway já não retorna loc
    // tipo='recebimento', mas mantemos o filtro caso a origem dessa pendência
    // seja outra coisa edge (loc reaproveitada como origem).
    const sugestaoFinal =
      sugestao && sugestao.localizacao_id !== pend.localizacao_origem_id
        ? sugestao
        : null;
    return NextResponse.json({
      pendencia: pend,
      sugestao: sugestaoFinal,
      locais_existentes: locaisExistentes.filter(
        (l) => l.localizacao_id !== pend.localizacao_origem_id,
      ),
    });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.guarda.detalhe",
      error: e,
      requestPath: `/api/wms/guarda/${id}`,
      requestMethod: "GET",
      metadata: { pendencia_id: id },
    });
  }
}
