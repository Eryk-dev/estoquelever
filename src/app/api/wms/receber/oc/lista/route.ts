import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

/**
 * GET /api/wms/receber/oc/lista?galpao_id=X
 *
 * Lista OCs com status='comprado' que ainda têm qty pendente de
 * recebimento. Filtrado por galpão (opcional).
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  if (!userCan(session, "operacoes.receber")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const galpaoId = searchParams.get("galpao_id");
  const supabase = createServiceClient();

  let q = supabase
    .from("siso_ordens_compra")
    .select(
      "id, fornecedor, galpao_id, status, created_at, siso_galpoes(nome)",
    )
    .in("status", ["comprado", "aguardando_compra"]);
  if (galpaoId) q = q.eq("galpao_id", galpaoId);

  const { data: ocs, error } = await q.order("created_at", {
    ascending: true,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Pra cada OC, calcula qty pendente (solicitado - recebido) em batch
  const ocIds = (ocs ?? []).map((o) => String(o.id));
  if (ocIds.length === 0) {
    return NextResponse.json({ ocs: [] });
  }

  const { data: itens } = await supabase
    .from("siso_pedido_itens")
    .select(
      "ordem_compra_id, compra_quantidade_solicitada, compra_quantidade_recebida",
    )
    .in("ordem_compra_id", ocIds);

  const pendenteByOC = new Map<string, number>();
  for (const it of itens ?? []) {
    const ocId = String(it.ordem_compra_id ?? "");
    if (!ocId) continue;
    const pend =
      Number(it.compra_quantidade_solicitada ?? 0) -
      Number(it.compra_quantidade_recebida ?? 0);
    if (pend > 0) {
      pendenteByOC.set(ocId, (pendenteByOC.get(ocId) ?? 0) + pend);
    }
  }

  const result = [];
  for (const oc of ocs ?? []) {
    const pendente = pendenteByOC.get(String(oc.id)) ?? 0;
    if (pendente <= 0) continue;
    result.push({
      id: oc.id,
      fornecedor: oc.fornecedor,
      galpao_id: oc.galpao_id,
      galpao_nome:
        (oc.siso_galpoes as { nome?: string } | null)?.nome ?? null,
      qty_pendente: pendente,
      criado_em: oc.created_at,
    });
  }

  return NextResponse.json({ ocs: result });
}
