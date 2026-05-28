import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

/**
 * GET /api/wms/receber/transferencia/[id]
 *
 * Retorna detalhe da transferência + itens pendentes (mov_entrada_id IS NULL).
 * Pra alimentar o form em /wms/receber/transferencia/[id].
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  if (!userCan(session, "operacoes.receber")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const supabase = createServiceClient();

  const { data: tr, error: trErr } = await supabase
    .from("siso_transferencias_galpao")
    .select(
      "id, galpao_origem_id, galpao_destino_id, status, criada_em, observacoes, origem:siso_galpoes!siso_transferencias_galpao_galpao_origem_id_fkey(nome), destino:siso_galpoes!siso_transferencias_galpao_galpao_destino_id_fkey(nome)",
    )
    .eq("id", id)
    .maybeSingle();
  if (trErr || !tr) {
    return NextResponse.json(
      { error: "Transferência não encontrada" },
      { status: 404 },
    );
  }

  const { data: itens } = await supabase
    .from("siso_transferencia_galpao_itens")
    .select(
      "id, transferencia_id, produto_id, localizacao_origem_id, qty, localizacao_destino_id, mov_saida_id, mov_entrada_id, siso_produtos(sku, descricao)",
    )
    .eq("transferencia_id", id)
    .is("mov_entrada_id", null);

  const itensFmt = (itens ?? []).map((it) => ({
    id: String(it.id),
    produto_id: it.produto_id,
    qty: Number(it.qty ?? 0),
    sku: (it.siso_produtos as { sku?: string } | null)?.sku ?? null,
    descricao:
      (it.siso_produtos as { descricao?: string } | null)?.descricao ?? null,
    localizacao_destino_id: it.localizacao_destino_id,
    mov_entrada_id: it.mov_entrada_id,
  }));

  return NextResponse.json({
    transferencia: {
      id: tr.id,
      galpao_origem_id: tr.galpao_origem_id,
      galpao_destino_id: tr.galpao_destino_id,
      status: tr.status,
      criada_em: tr.criada_em,
      observacoes: tr.observacoes,
      origem_nome: (tr.origem as { nome?: string } | null)?.nome ?? null,
      destino_nome: (tr.destino as { nome?: string } | null)?.nome ?? null,
      itens: itensFmt,
    },
  });
}
