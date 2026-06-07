import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/** Backoff custom dos jobs de manutenção: 30s → 5min → 10min (nota P082). */
export function backoffManutencao(tentativa: number): number {
  if (tentativa <= 1) return 30_000;
  if (tentativa === 2) return 300_000;
  return 600_000; // 3+ → 10min (NÃO escala pra 1h)
}

/** Enfileira um job durável de manutenção (varredura/reconciliar) com 1ª execução imediata. */
export async function enfileirarJobManutencao(input: {
  tipo: "varredura_pos_entrada" | "reconciliar_oc_retry";
  pedido_id?: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const sb = createServiceClient();
  const { error } = await sb.from("siso_fila_execucao").insert({
    pedido_id: input.pedido_id ?? "MAINT",
    tipo: input.tipo,
    filial_execucao: "MAINT",
    decisao: "manutencao",
    status: "pendente",
    max_tentativas: 3,
    payload: input.payload,
  });
  if (error) {
    logger.warn("jobs-manutencao", "falha ao enfileirar job de manutenção", {
      tipo: input.tipo, error: error.message,
    });
  }
}
