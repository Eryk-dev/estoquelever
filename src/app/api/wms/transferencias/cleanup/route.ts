import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { estornarMovimentacao } from "@/lib/wms/ledger";

/**
 * GET /api/wms/transferencias/cleanup
 *
 * Worker-secret protected. Cancela transferências inter-galpão em_transito
 * que passaram do `expira_em` (default 7d). Pra cada uma, estorna a saída
 * (mov_saida_id) de cada item que ainda não tem mov_estorno_id, devolvendo
 * o saldo pra loc de origem; em seguida marca a transferência como
 * 'cancelada'.
 *
 * Idempotente: itens com mov_estorno_id já preenchido são pulados.
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
        const { data: itens, error: errItens } = await sb
          .from("siso_transferencia_galpao_itens")
          .select("id, mov_saida_id, mov_estorno_id")
          .eq("transferencia_id", t.id);
        if (errItens) throw errItens;

        for (const item of (itens ?? []) as Array<{
          id: string;
          mov_saida_id: string | null;
          mov_estorno_id: string | null;
        }>) {
          if (!item.mov_saida_id || item.mov_estorno_id) continue;
          const estorno = await estornarMovimentacao({
            mov_id: item.mov_saida_id,
            usuario_id: SYSTEM_USER,
            motivo: "cron expira_em — transferência abandonada > 7 dias",
          });
          await sb
            .from("siso_transferencia_galpao_itens")
            .update({ mov_estorno_id: estorno.id })
            .eq("id", item.id);
        }

        await sb
          .from("siso_transferencias_galpao")
          .update({
            status: "cancelada",
            cancelada_em: new Date().toISOString(),
            observacoes: "auto-cancelada pelo cron de expira_em",
          })
          .eq("id", t.id);

        canceladas++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        erros.push({ transferencia_id: t.id, mensagem: msg });
        logger.error(
          "wms.transferencias.cleanup",
          `falha ao cancelar transferência ${t.id}: ${msg}`,
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
