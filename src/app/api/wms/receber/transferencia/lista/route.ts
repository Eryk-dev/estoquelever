import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

/**
 * GET /api/wms/receber/transferencia/lista
 *
 * Decisão 10 (28/05): lista APENAS transferências em_transito cujo destino é
 * o galpão padrão do operador autenticado (siso_usuarios.galpao_id). Admin
 * vê todas se admin=true.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  if (!userCan(session, "operacoes.receber")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const supabase = createServiceClient();

  const { data: user } = await supabase
    .from("siso_usuarios")
    .select("galpao_id")
    .eq("id", session.id)
    .single();
  // P3-10: gate por permissão (RBAC dinâmico), não por cargo legado.
  const isAdmin = userCan(session, "sistema.usuarios");

  let q = supabase
    .from("siso_transferencias_galpao")
    .select(
      "id, criada_em, galpao_origem_id, galpao_destino_id, status, origem:siso_galpoes!siso_transferencias_galpao_galpao_origem_id_fkey(nome), destino:siso_galpoes!siso_transferencias_galpao_galpao_destino_id_fkey(nome)",
    )
    .eq("status", "em_transito");

  if (!isAdmin && user?.galpao_id) {
    q = q.eq("galpao_destino_id", user.galpao_id);
  } else if (!isAdmin && !user?.galpao_id) {
    return NextResponse.json({ transferencias: [] });
  }

  const { data: trs, error } = await q.order("criada_em", {
    ascending: true,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Calcula qty pendente de cada transferência via siso_transferencia_galpao_itens
  const ids = (trs ?? []).map((t) => String(t.id));
  if (ids.length === 0) {
    return NextResponse.json({ transferencias: [] });
  }
  const { data: itens } = await supabase
    .from("siso_transferencia_galpao_itens")
    .select("transferencia_id, produto_id, qty, mov_entrada_id")
    .in("transferencia_id", ids);

  const pendenteByTr = new Map<string, number>();
  const skusByTr = new Map<string, Set<string>>();
  for (const it of itens ?? []) {
    const trId = String(it.transferencia_id);
    if (it.mov_entrada_id) continue; // já recebido
    pendenteByTr.set(trId, (pendenteByTr.get(trId) ?? 0) + Number(it.qty ?? 0));
    let skus = skusByTr.get(trId);
    if (!skus) {
      skus = new Set();
      skusByTr.set(trId, skus);
    }
    skus.add(String(it.produto_id));
  }

  const result = (trs ?? [])
    .map((t) => ({
      id: t.id,
      criado_em: t.criada_em,
      origem_nome:
        (t.origem as { nome?: string } | null)?.nome ?? null,
      destino_nome:
        (t.destino as { nome?: string } | null)?.nome ?? null,
      qty_pendente: pendenteByTr.get(String(t.id)) ?? 0,
      skus_pendentes: skusByTr.get(String(t.id))?.size ?? 0,
    }))
    .filter((t) => t.qty_pendente > 0);

  return NextResponse.json({ transferencias: result });
}
