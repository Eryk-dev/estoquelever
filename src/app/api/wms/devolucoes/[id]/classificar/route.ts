import { NextRequest, NextResponse } from "next/server";
import { classificarDevolucao, type Classificacao } from "@/lib/wms/devolucoes";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/**
 * POST /api/wms/devolucoes/[id]/classificar
 *
 * Classifica uma devolução pendente em uma das 4 categorias e dispara as
 * movs no ledger via lib (`classificarDevolucao`). Em 3D não há mais
 * empresa dona — a empresa vendedora original viaja como tag em
 * `empresa_referencia_id` (resolvida automaticamente da mov original
 * quando omitida no body).
 *
 * Body:
 *   {
 *     classificacao: 'integro' | 'avariado' | 'garantia' | 'troca_sku',
 *     produto_id, galpao_id, localizacao_id, qty,
 *     empresa_referencia_id?,  // vendedora da NF original (opcional — auto-resolve)
 *     fornecedor_id?,          // obrigatório quando classificacao='garantia'
 *     observacoes?
 *   }
 */
interface ClassificarBody {
  classificacao: Classificacao;
  produto_id: string;
  galpao_id: string;
  localizacao_id: string;
  qty: number;
  empresa_referencia_id?: string;
  fornecedor_id?: string;
  observacoes?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const body = (await req.json()) as ClassificarBody;
  try {
    await classificarDevolucao({
      devolucao_id: id,
      classificacao: body.classificacao,
      produto_id: body.produto_id,
      galpao_id: body.galpao_id,
      localizacao_id: body.localizacao_id,
      qty: body.qty,
      empresa_referencia_id: body.empresa_referencia_id,
      fornecedor_id: body.fornecedor_id,
      observacoes: body.observacoes,
      usuario_id: auth.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.devolucoes.classificar",
      error: e,
      status: 400,
      requestPath: `/api/wms/devolucoes/${id}/classificar`,
      requestMethod: "POST",
      metadata: { devolucao_id: id, classificacao: body.classificacao },
    });
  }
}
