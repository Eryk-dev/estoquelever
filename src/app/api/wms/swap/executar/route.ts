import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { tentarSwapAutomatico } from "@/lib/wms/swap";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * POST /api/wms/swap/executar
 * Body: { produto_id, qty, vendedora_id, galpao_destino_id }
 *
 * Detecta + executa o melhor swap viável (qty inteira). Cria 4 movimentações
 * atômicas no ledger:
 *   Leg 1 (galpão destino):    irmã → vendedora  (E ganha onde precisa)
 *   Leg 2 (galpão contrapartida): vendedora → irmã  (I ganha onde ela roda)
 * Saldo devedor líquido vendedora↔irmã: 0.
 *
 * Retorna null se nenhuma oportunidade cobre qty integralmente.
 */
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  const { produto_id, qty, vendedora_id, galpao_destino_id } = body;
  if (!produto_id || !qty || !vendedora_id || !galpao_destino_id) {
    return NextResponse.json(
      {
        error:
          "produto_id, qty, vendedora_id, galpao_destino_id obrigatórios",
      },
      { status: 400 },
    );
  }
  if (!Number.isFinite(Number(qty)) || Number(qty) <= 0) {
    return NextResponse.json(
      { error: "qty inválida" },
      { status: 400 },
    );
  }

  try {
    const sb = createServiceClient();

    // buscarLinha: dado (produto, dona, galpão, qty), retorna localização com
    // disponivel >= qty, preferindo picking sobre overstock. Filtra locks ativos.
    const buscarLinha = async (q: {
      produto_id: string;
      empresa_dona_id: string;
      galpao_id: string;
      qty: number;
    }) => {
      const { data } = await sb
        .from("siso_estoque")
        .select(
          "id, localizacao_id, disponivel, localizacao:siso_localizacoes(tipo)",
        )
        .match({
          produto_id: q.produto_id,
          empresa_dona_id: q.empresa_dona_id,
          galpao_id: q.galpao_id,
        })
        .gte("disponivel", q.qty)
        .order("disponivel", { ascending: false })
        .limit(20);
      if (!data || data.length === 0) return null;

      const { data: locks } = await sb
        .from("siso_localizacao_locks")
        .select("localizacao_id")
        .is("finalizado_em", null);
      const blocked = new Set(
        (locks ?? []).map(
          (l) => (l as { localizacao_id: string }).localizacao_id,
        ),
      );
      type Row = {
        id: string;
        localizacao_id: string;
        disponivel: number;
        localizacao?: { tipo?: string };
      };
      const livres = (data as unknown as Row[]).filter(
        (d) => !blocked.has(d.localizacao_id),
      );
      const sorted = livres.sort((a, b) => {
        const ap = a.localizacao?.tipo === "picking" ? 0 : 1;
        const bp = b.localizacao?.tipo === "picking" ? 0 : 1;
        return ap - bp;
      });
      return sorted[0]
        ? {
            id: sorted[0].id,
            localizacao_id: sorted[0].localizacao_id,
            disponivel: Number(sorted[0].disponivel),
          }
        : null;
    };

    const resultado = await tentarSwapAutomatico(
      produto_id,
      Number(qty),
      vendedora_id,
      galpao_destino_id,
      auth.user.id,
      buscarLinha,
    );
    if (!resultado) {
      return NextResponse.json(
        {
          executed: false,
          motivo:
            "nenhuma oportunidade de swap cobre qty integralmente (verifique regras bidirecionais e saldos)",
        },
        { status: 200 },
      );
    }
    return NextResponse.json({ executed: true, ...resultado });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.swap.executar",
      error: e,
      status: 400,
      requestPath: "/api/wms/swap/executar",
      requestMethod: "POST",
      metadata: { produto_id, qty, vendedora_id, galpao_destino_id },
    });
  }
}
