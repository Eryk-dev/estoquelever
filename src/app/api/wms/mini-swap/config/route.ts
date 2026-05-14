import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

/**
 * GET /api/wms/mini-swap/config
 * Lista config de mini-swap pra todos os galpões.
 * Headers: X-Session-Id
 * Retorno: [{ galpao_id, galpao_nome, ativo, atualizado_em, atualizado_por_nome }]
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_wms_mini_swap_config")
    .select(
      "galpao_id, ativo, atualizado_em, galpao:siso_galpoes!inner(nome), usuario:siso_usuarios!atualizado_por(nome)",
    )
    .order("atualizado_em", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = {
    galpao_id: string;
    ativo: boolean;
    atualizado_em: string;
    galpao: { nome: string };
    usuario: { nome: string } | null;
  };
  const result = (data as unknown as Row[]).map((r) => ({
    galpao_id: r.galpao_id,
    galpao_nome: r.galpao.nome,
    ativo: r.ativo,
    atualizado_em: r.atualizado_em,
    atualizado_por_nome: r.usuario?.nome ?? null,
  }));
  return NextResponse.json(result);
}
