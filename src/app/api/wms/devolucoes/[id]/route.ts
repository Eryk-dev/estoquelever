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
    // empresa_id na tabela siso_devolucoes_pendentes representa a empresa
    // RECEPTORA FÍSICA da NF de devolução (quem recebeu de volta no galpão),
    // NÃO a vendedora original (essa só é resolvida na classificação a partir
    // da mov S da venda). Por isso aliasamos como `empresa_receptora` — alinha
    // com P2 #6.5 que corrige o mesmo bug em listarDevolucoesPendentes.
    const { data, error } = await sb
      .from("siso_devolucoes_pendentes")
      .select(
        `id, status, nota_fiscal_id, chave_acesso_nf, criado_em,
         pedido_origem_id, classificacao, classificada_em, payload_webhook,
         empresa_receptora:siso_empresas!empresa_id(id, nome)`,
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

    // Troca de equivalência: se o pedido de origem teve item(ns) trocado(s)
    // (`produto_wms_substituto_id` setado), a peça que volta fisicamente é o
    // SUBSTITUTO — a entrada (E) deve cair nele, não no produto da NF (que
    // segue o SKU VENDIDO). Surface os itens com substituto pra UI sugerir o
    // produto certo + avisar o operador. Não muda a mecânica do classificar.
    const dev = data as { pedido_origem_id?: string | null };
    let trocas: Array<{
      produto_substituto_id: string;
      sku_substituto: string;
      sku_vendido: string;
      troca_equivalencia_id: string | null;
    }> = [];
    if (dev.pedido_origem_id) {
      const { data: itensTrocados } = await sb
        .from("siso_pedido_itens")
        .select("sku, produto_wms_substituto_id, troca_equivalencia_id")
        .eq("pedido_id", dev.pedido_origem_id)
        .not("produto_wms_substituto_id", "is", null);
      const subIds = (itensTrocados ?? [])
        .map((i) => i.produto_wms_substituto_id as string)
        .filter(Boolean);
      if (subIds.length > 0) {
        const { data: prods } = await sb
          .from("siso_produtos")
          .select("id, sku")
          .in("id", subIds);
        const skuPorId = new Map(
          (prods ?? []).map((p) => [p.id as string, p.sku as string]),
        );
        trocas = (itensTrocados ?? []).map((i) => ({
          produto_substituto_id: i.produto_wms_substituto_id as string,
          sku_substituto:
            skuPorId.get(i.produto_wms_substituto_id as string) ?? "",
          sku_vendido: (i.sku as string) ?? "",
          troca_equivalencia_id:
            (i.troca_equivalencia_id as string | null) ?? null,
        }));
      }
    }

    return NextResponse.json({ devolucao: { ...data, trocas } });
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
