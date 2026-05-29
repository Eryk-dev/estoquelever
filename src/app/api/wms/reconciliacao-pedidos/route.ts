import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * GET /api/wms/reconciliacao-pedidos  (Fase 2.1 — safety net)
 *
 * Auth via WORKER_SECRET (header x-worker-secret), mesmo padrão de
 * /api/wms/reconciliacao. Cron-friendly.
 *
 * Sinaliza os 3 padrões de inconsistência do fluxo Pedido→Separação→Estoque
 * via RPC wms_detectar_pedidos_inconsistentes():
 *   A) item marcado sem saída S no ledger
 *   B) saída S viva com pedido.estoque_lancado=false
 *   C) pedido forward com reserva R ainda viva
 *
 * A Fase 1 tornou esses padrões impossíveis daqui pra frente (pick atômico
 * fail-loud). Este endpoint é a rede de segurança: pega histórico e detecta
 * regressões caso uma feature nova reintroduza um caminho de baixa paralelo.
 *
 * Resposta: { ok, total, por_padrao: {A,B,C}, amostras: [...até 50] }.
 */
type LinhaInconsistente = {
  padrao: string;
  pedido_id: string;
  produto_id: string | null;
  status_separacao: string | null;
  estoque_lancado: boolean | null;
  detalhe: string;
};

export async function GET(req: NextRequest) {
  const auth = req.headers.get("x-worker-secret");
  if (auth !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sb = createServiceClient();
  const { data, error } = await sb.rpc("wms_detectar_pedidos_inconsistentes");
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const linhas = (data ?? []) as LinhaInconsistente[];
  const porPadrao = {
    A_marcado_sem_saida: 0,
    B_saida_sem_estoque_lancado: 0,
    C_forward_com_reserva_viva: 0,
  };
  for (const l of linhas) {
    if (l.padrao in porPadrao) {
      porPadrao[l.padrao as keyof typeof porPadrao] += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    total: linhas.length,
    por_padrao: porPadrao,
    amostras: linhas.slice(0, 50),
  });
}
