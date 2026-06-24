import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/**
 * GET /api/wms/encaixotamento
 *
 * Painel das caixas (= dias de despacho) da pista FUTURA. Agrega os pedidos
 * futura já separados por DIA de prazo_envio e mostra o progresso de
 * encaixotamento (quanto já foi depositado vs quanto falta).
 *
 * Resposta: { caixas: [{ dia, pedidos, total_un, encaixotado_un, falta_un,
 *             completo }], total_un, falta_un }
 */

interface CaixaDia {
  dia: string;
  pedidos: number;
  total_un: number;
  encaixotado_un: number;
  falta_un: number;
  completo: boolean;
}

const SEM_PRAZO = "sem-prazo";

export async function GET(request: NextRequest) {
  const auth = await requireWarehouseAccess(request);
  if (!auth.ok) return auth.response;

  const supabase = createServiceClient();

  try {
    const { data: pedidos, error: pErr } = await supabase
      .from("siso_pedidos")
      .select("id, prazo_envio")
      .eq("separacao_futura", true)
      .eq("status_separacao", "separado");
    if (pErr) {
      return wmsErrorResponse({ source: "wms.encaixotamento.overview", error: pErr, status: 500 });
    }

    const lista = pedidos ?? [];
    if (lista.length === 0) {
      return NextResponse.json({ caixas: [], total_un: 0, falta_un: 0 });
    }

    const diaPorPedido = new Map<string, string>();
    for (const p of lista) {
      // prazo_envio é timestamptz (UTC) — extrai a DATA no fuso de SP (mesma
      // lógica da RPC wms_encaixotar_atomico), senão a virada de meia-noite
      // joga o pedido pro dia errado.
      const dia = p.prazo_envio
        ? new Date(p.prazo_envio as string).toLocaleDateString("en-CA", {
            timeZone: "America/Sao_Paulo",
          })
        : SEM_PRAZO;
      diaPorPedido.set(String(p.id), dia);
    }

    const ids = lista.map((p) => String(p.id));
    const { data: itens, error: iErr } = await supabase
      .from("siso_pedido_itens")
      .select("pedido_id, quantidade_pega, quantidade_pedida, quantidade_encaixotada")
      .in("pedido_id", ids);
    if (iErr) {
      return wmsErrorResponse({ source: "wms.encaixotamento.overview", error: iErr, status: 500 });
    }

    const agg = new Map<string, { total: number; feito: number; pedidos: Set<string> }>();
    for (const it of itens ?? []) {
      const dia = diaPorPedido.get(String(it.pedido_id)) ?? SEM_PRAZO;
      const alvo = it.quantidade_pega ?? it.quantidade_pedida ?? 0;
      const feito = Math.min(it.quantidade_encaixotada ?? 0, alvo);
      const cur = agg.get(dia) ?? { total: 0, feito: 0, pedidos: new Set<string>() };
      cur.total += alvo;
      cur.feito += feito;
      cur.pedidos.add(String(it.pedido_id));
      agg.set(dia, cur);
    }

    const caixas: CaixaDia[] = [...agg.entries()]
      .map(([dia, v]) => ({
        dia,
        pedidos: v.pedidos.size,
        total_un: v.total,
        encaixotado_un: v.feito,
        falta_un: Math.max(0, v.total - v.feito),
        completo: v.total > 0 && v.feito >= v.total,
      }))
      .sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0));

    const total_un = caixas.reduce((s, c) => s + c.total_un, 0);
    const falta_un = caixas.reduce((s, c) => s + c.falta_un, 0);

    return NextResponse.json({ caixas, total_un, falta_un });
  } catch (e) {
    return wmsErrorResponse({ source: "wms.encaixotamento.overview", error: e });
  }
}
