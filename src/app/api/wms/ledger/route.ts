import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const sp = req.nextUrl.searchParams;
  const sb = createServiceClient();

  let q = sb
    .from("siso_movimentacoes")
    .select(
      `
        *,
        produto:siso_produtos(sku, descricao),
        empresa:siso_empresas!empresa_dona_id(nome),
        galpao:siso_galpoes(nome),
        localizacao:siso_localizacoes(codigo, tipo)
      `,
    )
    .order("criado_em", { ascending: false })
    .limit(Number(sp.get("limit") ?? 100));

  const produtoId = sp.get("produto_id");
  const empresaId = sp.get("empresa_id");
  const galpaoId = sp.get("galpao_id");
  const localizacaoId = sp.get("localizacao_id");
  const origemTipo = sp.get("origem_tipo");
  const desde = sp.get("desde");
  const ate = sp.get("ate");

  if (produtoId) q = q.eq("produto_id", produtoId);
  if (empresaId) q = q.eq("empresa_dona_id", empresaId);
  if (galpaoId) q = q.eq("galpao_id", galpaoId);
  if (localizacaoId) q = q.eq("localizacao_id", localizacaoId);
  if (origemTipo) q = q.eq("origem_tipo", origemTipo);
  if (desde) q = q.gte("criado_em", desde);
  if (ate) q = q.lte("criado_em", ate);

  const { data, error } = await q;
  if (error) {
    return wmsErrorResponse({
      source: "wms.ledger",
      error,
      requestPath: "/api/wms/ledger",
      requestMethod: "GET",
    });
  }
  return NextResponse.json({ rows: data ?? [] });
}
