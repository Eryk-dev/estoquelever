import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { cancelarTransferencia } from "@/lib/wms/transferencias";

/**
 * GET /api/wms/transferencias/cleanup
 *
 * Worker-secret protected. Cancela transferências inter-galpão em_transito
 * que passaram do `expira_em` (default 7d). Pra cada uma, delega a
 * `cancelarTransferencia` (lib/wms/transferencias), que estorna a leg E
 * (entrada destino, em recebimentos parciais) ANTES da leg S (saída origem),
 * respeita o lock de recebimento/claim atômico e marca a transferência como
 * 'cancelada'.
 *
 * P2-EST-02/03: antes, este cron tinha um loop próprio que (a) só estornava a
 * leg S — duplicando saldo se a E já tinha sido recebida parcialmente — e (b)
 * usava o usuário uuid-zero como `usuario_id`, que não existia em
 * siso_usuarios → a FK siso_movimentacoes.usuario_id fazia TODO estorno falhar,
 * matando o cron. O usuário sistema agora existe (migration 20260611m) e o
 * estorno é feito pela lib que já trata as duas legs.
 *
 * Idempotente: `cancelarTransferencia` pula movs já estornadas.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("x-worker-secret");
  if (auth !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sb = createServiceClient();
  const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";
  let canceladas = 0;
  const erros: Array<{ transferencia_id: string; mensagem: string }> = [];

  try {
    const { data: rows, error } = await sb
      .from("siso_transferencias_galpao")
      .select("id")
      .eq("status", "em_transito")
      .lt("expira_em", new Date().toISOString());
    if (error) throw error;

    const candidatos = (rows ?? []) as Array<{ id: string }>;

    for (const t of candidatos) {
      try {
        // cancelarTransferencia estorna leg E antes de leg S, respeita o lock
        // de recebimento e marca cancelada. Motivo 'expirada_auto' fica no
        // motivo das movs de estorno (montado pela própria lib).
        await cancelarTransferencia(t.id, SYSTEM_USER);
        canceladas++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        erros.push({ transferencia_id: t.id, mensagem: msg });
        logger.error(
          "wms.transferencias.cleanup",
          `falha ao cancelar transferência ${t.id} (expirada_auto): ${msg}`,
        );
      }
    }

    return NextResponse.json({ canceladas, erros });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("wms.transferencias.cleanup", `falha geral: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
