import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

/**
 * GET /api/wms/relatorios/movs-por-empresa
 *
 * Agrega movimentações por (produto, empresa, tipo) num intervalo de datas.
 * Empresa = empresa_compradora_id pra entradas (E), empresa_vendedora_id pra
 * saídas (S). Só inclui movs não-estornadas com origem comercial (compra,
 * venda, devolução).
 *
 * Query params:
 *   - data_inicio: ISO date (obrigatório)
 *   - data_fim:    ISO date (obrigatório)
 *   - galpao_id?:  filtra por galpão
 *   - empresa_id?: filtra por empresa (compradora ou vendedora)
 *   - produto_id?: filtra por produto
 *
 * Response: { items: [{ produto_id, empresa_id, tipo: 'E'|'S', qty_total, valor_total }] }
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user)
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const url = new URL(req.url);
  const dataInicio = url.searchParams.get("data_inicio");
  const dataFim = url.searchParams.get("data_fim");
  const galpaoId = url.searchParams.get("galpao_id");
  const empresaId = url.searchParams.get("empresa_id");
  const produtoId = url.searchParams.get("produto_id");

  if (!dataInicio || !dataFim) {
    return NextResponse.json(
      { error: "data_inicio + data_fim obrigatórios" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  let query = supabase
    .from("siso_movimentacoes")
    .select(
      `
      tipo, quantidade, custo_unitario, criado_em,
      produto_id, galpao_id, empresa_compradora_id, empresa_vendedora_id,
      origem_tipo
    `,
    )
    .gte("criado_em", dataInicio)
    .lte("criado_em", dataFim)
    .is("estorno_de", null)
    .in("origem_tipo", [
      "nf_compra",
      "nf_venda",
      "venda_manual",
      "devolucao_cliente_integra",
      "devolucao_fornecedor_enviada",
    ]);
  if (galpaoId) query = query.eq("galpao_id", galpaoId);
  if (produtoId) query = query.eq("produto_id", produtoId);

  const { data, error } = await query;
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  const grupos = new Map<
    string,
    {
      produto_id: string;
      empresa_id: string;
      tipo: "E" | "S";
      qty_total: number;
      valor_total: number;
    }
  >();
  for (const m of data ?? []) {
    const empresa =
      m.tipo === "E" ? m.empresa_compradora_id : m.empresa_vendedora_id;
    if (!empresa) continue;
    if (empresaId && empresa !== empresaId) continue;
    const key = `${m.produto_id}|${empresa}|${m.tipo}`;
    const grp = grupos.get(key) ?? {
      produto_id: m.produto_id,
      empresa_id: empresa,
      tipo: m.tipo as "E" | "S",
      qty_total: 0,
      valor_total: 0,
    };
    grp.qty_total += Number(m.quantidade);
    grp.valor_total += Number(m.quantidade) * Number(m.custo_unitario ?? 0);
    grupos.set(key, grp);
  }

  return NextResponse.json({ items: Array.from(grupos.values()) });
}
