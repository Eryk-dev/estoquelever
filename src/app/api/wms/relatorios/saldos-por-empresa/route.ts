import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

/**
 * GET /api/wms/relatorios/saldos-por-empresa
 *
 * Saldo virtual por (empresa, produto, galpão), computado como
 * Σ entradas − Σ saídas das movs não-estornadas. Empresa = compradora
 * em E, vendedora em S. Em 3D o saldo físico é fungível por galpão,
 * mas esse relatório oferece uma "visão fiscal" — quanto cada empresa
 * comprou e ainda não vendeu, agregado por galpão.
 *
 * Query params:
 *   - galpao_id?:  filtra por galpão
 *   - empresa_id?: filtra por empresa (compradora ou vendedora)
 *
 * Response: { items: [{ empresa_id, produto_id, galpao_id, saldo_virtual }] }
 * (rows com saldo_virtual=0 são omitidos)
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user)
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const url = new URL(req.url);
  const galpaoId = url.searchParams.get("galpao_id");
  const empresaId = url.searchParams.get("empresa_id");

  const supabase = createServiceClient();
  let query = supabase
    .from("siso_movimentacoes")
    .select(
      `
      tipo, quantidade,
      produto_id, galpao_id,
      empresa_compradora_id, empresa_vendedora_id
    `,
    )
    .is("estorno_de", null)
    .in("tipo", ["E", "S"]);

  if (galpaoId) query = query.eq("galpao_id", galpaoId);

  const { data, error } = await query;
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  const acc = new Map<
    string,
    {
      empresa_id: string;
      produto_id: string;
      galpao_id: string;
      saldo_virtual: number;
    }
  >();

  for (const m of data ?? []) {
    const empresa =
      m.tipo === "E" ? m.empresa_compradora_id : m.empresa_vendedora_id;
    if (!empresa) continue;
    if (empresaId && empresa !== empresaId) continue;
    const key = `${empresa}|${m.produto_id}|${m.galpao_id}`;
    const grp = acc.get(key) ?? {
      empresa_id: empresa,
      produto_id: m.produto_id,
      galpao_id: m.galpao_id,
      saldo_virtual: 0,
    };
    const qty = Number(m.quantidade);
    grp.saldo_virtual += m.tipo === "E" ? qty : -qty;
    acc.set(key, grp);
  }

  const items = Array.from(acc.values()).filter((r) => r.saldo_virtual !== 0);
  return NextResponse.json({ items });
}
