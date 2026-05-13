import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/**
 * Lista saldos > 0 da localização, agrupados por (produto, dona).
 * Usado no fluxo de exclusão: a UI mostra o que precisa ser movido
 * antes de pedir a loc destino.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const sb = createServiceClient();

  try {
    const { data, error } = await sb
      .from("siso_estoque")
      .select(
        "produto_id, empresa_dona_id, saldo, " +
          "produto:siso_produtos(sku, descricao), " +
          "empresa:siso_empresas(nome)",
      )
      .eq("localizacao_id", id)
      .gt("saldo", 0)
      .order("produto_id");
    if (error) throw error;

    type SaldoRow = {
      produto_id: string;
      empresa_dona_id: string;
      saldo: number;
      produto: { sku: string; descricao: string } | null;
      empresa: { nome: string } | null;
    };
    const linhas = ((data ?? []) as unknown as SaldoRow[]).map((r) => ({
      produto_id: r.produto_id,
      empresa_dona_id: r.empresa_dona_id,
      saldo: r.saldo,
      sku: r.produto?.sku ?? null,
      descricao: r.produto?.descricao ?? null,
      empresa_nome: r.empresa?.nome ?? null,
    }));

    return NextResponse.json({
      rows: linhas,
      total_qty: linhas.reduce((s, l) => s + Number(l.saldo), 0),
      total_linhas: linhas.length,
    });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.localizacoes.saldos",
      error: e,
      requestPath: `/api/wms/localizacoes/${id}/saldos`,
      requestMethod: "GET",
      metadata: { localizacao_id: id },
    });
  }
}
