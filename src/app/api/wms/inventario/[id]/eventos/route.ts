import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { createServiceClient } from "@/lib/supabase-server";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

// GET /api/wms/inventario/[id]/eventos?limit=50
// Retorna últimas N movs do galpão da sessão (criadas após o início da sessão),
// com classificação verde / amarelo / vermelho baseada no estado da loc.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const limit = Math.min(200, Number(new URL(req.url).searchParams.get("limit") ?? "50"));

  try {
    const sb = createServiceClient();

    const { data: sessao } = await sb
      .from("siso_inventario_sessoes")
      .select("galpao_id, iniciada_em, criado_em")
      .eq("id", id)
      .single();
    if (!sessao) {
      return NextResponse.json({ error: "sessão não encontrada" }, { status: 404 });
    }
    const inicio = (sessao as { iniciada_em: string | null; criado_em: string }).iniciada_em
      ?? (sessao as { criado_em: string }).criado_em;
    const galpaoId = (sessao as { galpao_id: string }).galpao_id;

    // Estado das locs da sessão (pra classificar)
    const { data: locs } = await sb
      .from("siso_inventario_localizacoes")
      .select("localizacao_id, contagem_finalizada_em")
      .eq("sessao_id", id);
    const finalizadaMap = new Map<string, string>();
    const locIds: string[] = [];
    for (const l of (locs ?? []) as Array<{ localizacao_id: string; contagem_finalizada_em: string | null }>) {
      locIds.push(l.localizacao_id);
      if (l.contagem_finalizada_em) finalizadaMap.set(l.localizacao_id, l.contagem_finalizada_em);
    }

    if (locIds.length === 0) {
      return NextResponse.json({ eventos: [] });
    }

    // Movs nas locs da sessão criadas após o início
    const { data: movs } = await sb
      .from("siso_movimentacoes")
      .select("id, localizacao_id, produto_id, tipo, origem_tipo, origem_id, quantidade, saldo_anterior, saldo_posterior, criado_em, estorno_de, siso_produtos!inner(sku, descricao), siso_localizacoes!inner(codigo, galpao_id)")
      .eq("siso_localizacoes.galpao_id", galpaoId)
      .in("localizacao_id", locIds)
      .gte("criado_em", inicio)
      .order("criado_em", { ascending: false })
      .limit(limit);

    type MovRow = {
      id: string;
      localizacao_id: string;
      produto_id: string;
      tipo: string;
      origem_tipo: string;
      origem_id: string | null;
      quantidade: number;
      saldo_anterior: number;
      saldo_posterior: number;
      criado_em: string;
      estorno_de: string | null;
      siso_produtos: { sku: string; descricao: string } | { sku: string; descricao: string }[];
      siso_localizacoes: { codigo: string } | { codigo: string }[];
    };

    const eventos = ((movs ?? []) as MovRow[]).map((m) => {
      const finalizadaEm = finalizadaMap.get(m.localizacao_id);
      let cor: "verde" | "amarelo" | "vermelho" = "verde";
      if (m.origem_tipo === "inventario_ganho" || m.origem_tipo === "inventario_perda") {
        cor = "verde"; // ajuste de inventário (perda ou ganho)
      } else if (finalizadaEm && m.criado_em > finalizadaEm) {
        cor = "vermelho"; // mov em loc já contada — sistema reconcilia
      } else if (finalizadaEm) {
        cor = "amarelo"; // mov em loc contada mas antes da finalização (ainda em jogo)
      } else {
        cor = "amarelo"; // mov em loc ainda não contada
      }
      const p = Array.isArray(m.siso_produtos) ? m.siso_produtos[0] : m.siso_produtos;
      const l = Array.isArray(m.siso_localizacoes) ? m.siso_localizacoes[0] : m.siso_localizacoes;
      return {
        id: m.id,
        cor,
        tipo: m.tipo,
        origem_tipo: m.origem_tipo,
        origem_id: m.origem_id,
        loc_codigo: l?.codigo,
        sku: p?.sku,
        descricao: p?.descricao,
        quantidade: Number(m.quantidade),
        saldo_anterior: Number(m.saldo_anterior),
        saldo_posterior: Number(m.saldo_posterior),
        criado_em: m.criado_em,
      };
    });

    return NextResponse.json({ eventos });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.eventos",
      error: e,
      status: 500,
      requestPath: `/api/wms/inventario/${id}/eventos`,
      requestMethod: "GET",
      metadata: { sessao_id: id },
    });
  }
}
