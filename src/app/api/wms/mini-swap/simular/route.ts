import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase-server";
import { planejarMiniSwap } from "@/lib/wms/mini-swap";
import type { EstadoEstoqueSku, Demanda } from "@/lib/wms/mini-swap-types";

/**
 * POST /api/wms/mini-swap/simular
 * Body: { pedido_ids: string[], galpao_id: string }
 * Dry-run: roda apenas o planejador, NÃO chama a RPC. Útil pra debug.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.pedido_ids) || typeof body?.galpao_id !== "string") {
    return NextResponse.json({ error: "pedido_ids[] e galpao_id obrigatórios" }, { status: 400 });
  }

  const sb = createServiceClient();

  const { data: itens } = await sb
    .from("siso_pedido_itens")
    .select("produto_id, quantidade, pedido:siso_pedidos!inner(empresa_origem_id)")
    .in("pedido_id", body.pedido_ids);

  type ItemRow = { produto_id: string; quantidade: number; pedido: { empresa_origem_id: string } };
  const aggMap = new Map<string, { empresa_picadora_id: string; produto_id: string; qty_total: number }>();
  for (const it of (itens ?? []) as unknown as ItemRow[]) {
    const key = `${it.pedido.empresa_origem_id}::${it.produto_id}`;
    const existing = aggMap.get(key);
    if (existing) existing.qty_total += Number(it.quantidade);
    else aggMap.set(key, {
      empresa_picadora_id: it.pedido.empresa_origem_id,
      produto_id: it.produto_id,
      qty_total: Number(it.quantidade),
    });
  }

  const produtoIds = [...new Set([...aggMap.values()].map((a) => a.produto_id))];
  const { data: estoqueRows } = await sb
    .from("siso_estoque")
    .select("produto_id, empresa_dona_id, localizacao_id, saldo, reservado, localizacao:siso_localizacoes!inner(codigo)")
    .eq("galpao_id", body.galpao_id)
    .in("produto_id", produtoIds);

  type EstoqueRow = { produto_id: string; empresa_dona_id: string; localizacao_id: string; saldo: number; reservado: number; localizacao: { codigo: string } };
  const estado: EstadoEstoqueSku[] = produtoIds.map((pid) => ({
    produto_id: pid,
    galpao_id: body.galpao_id,
    linhas: ((estoqueRows ?? []) as unknown as EstoqueRow[])
      .filter((r) => r.produto_id === pid)
      .map((r) => ({
        empresa_dona_id: r.empresa_dona_id,
        localizacao_id: r.localizacao_id,
        localizacao_codigo: r.localizacao.codigo,
        saldo: Number(r.saldo),
        reservado: Number(r.reservado),
      })),
  }));

  const demandas: Demanda[] = [...aggMap.values()].map((a) => ({
    empresa_picadora_id: a.empresa_picadora_id,
    produto_id: a.produto_id,
    qty_total: a.qty_total,
    qty_emprestimo_planejada: 0, // dry-run não busca reservas reais — assume 0
    reservas_existentes_ids: [],
  }));

  const plano = planejarMiniSwap({
    galpao_id: body.galpao_id,
    pedido_ids: body.pedido_ids,
    estado,
    demandas,
  });

  return NextResponse.json({ plano });
}
