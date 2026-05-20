import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

/**
 * GET /api/wms/relatorios/historico-custo
 *
 * Linha do tempo de custo médio pra um produto. Lista todas as movs com
 * custo_unitario IS NOT NULL (entradas de NF de compra, devoluções, etc),
 * ordenadas cronologicamente, com custo_medio_anterior/posterior.
 *
 * Query params:
 *   - produto_id:   uuid (obrigatório)
 *   - data_inicio?: ISO date (opcional)
 *   - data_fim?:    ISO date (opcional)
 *
 * Response: {
 *   custo_medio_atual: number | null,
 *   items: [{
 *     criado_em, custo_medio_anterior, custo_medio_posterior,
 *     custo_unitario, quantidade, origem_tipo,
 *     empresa_compradora_id, fornecedor_id
 *   }]
 * }
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user)
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const url = new URL(req.url);
  const produtoId = url.searchParams.get("produto_id");
  const dataInicio = url.searchParams.get("data_inicio");
  const dataFim = url.searchParams.get("data_fim");

  if (!produtoId) {
    return NextResponse.json(
      { error: "produto_id obrigatório" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  let query = supabase
    .from("siso_movimentacoes")
    .select(
      `
      criado_em, custo_medio_anterior, custo_medio_posterior,
      custo_unitario, quantidade, origem_tipo,
      empresa_compradora_id, fornecedor_id
    `,
    )
    .eq("produto_id", produtoId)
    .not("custo_unitario", "is", null)
    .order("criado_em", { ascending: true });

  if (dataInicio) query = query.gte("criado_em", dataInicio);
  if (dataFim) query = query.lte("criado_em", dataFim);

  const { data, error } = await query;
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  // Custo médio atual (snapshot da cache)
  const { data: cm } = await supabase
    .from("siso_custo_medio")
    .select("custo_medio")
    .eq("produto_id", produtoId)
    .maybeSingle();

  return NextResponse.json({
    custo_medio_atual: cm?.custo_medio ?? null,
    items: data ?? [],
  });
}
