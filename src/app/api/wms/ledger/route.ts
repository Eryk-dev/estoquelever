import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const sb = createServiceClient();

  let q = sb
    .from("siso_movimentacoes")
    .select(
      `
        *,
        produto:siso_produtos(sku, descricao),
        empresa:siso_empresas(nome),
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
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}
