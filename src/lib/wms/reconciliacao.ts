import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

interface DivergenciaRow {
  estoque_id: string;
  produto_id: string;
  galpao_id: string;
  localizacao_id: string;
  saldo_cache: number;
  saldo_ledger: number;
  delta: number;
}

interface ReconciliacaoResult {
  divergencias: DivergenciaRow[];
  corrigidas: number;
}

export async function reconciliarEstoqueComLedger(
  opts: { autoFix?: boolean } = {},
): Promise<ReconciliacaoResult> {
  const sb = createServiceClient();

  const { data, error } = await sb.rpc("wms_detectar_divergencias_estoque");
  if (error) {
    logger.warn("wms.reconciliacao", "RPC indisponível", { error });
    return { divergencias: [], corrigidas: 0 };
  }

  const divergencias = (data ?? []) as unknown as DivergenciaRow[];
  let corrigidas = 0;
  if (opts.autoFix) {
    for (const d of divergencias) {
      const { error: errFix } = await sb.rpc("wms_rebuild_linha_estoque", {
        p_id: d.estoque_id,
      });
      if (!errFix) corrigidas++;
    }
  }

  if (divergencias.length > 0) {
    logger.warn("wms.reconciliacao", "divergencias detectadas", {
      count: divergencias.length,
      autoFix: !!opts.autoFix,
    });
  }
  return { divergencias, corrigidas };
}
