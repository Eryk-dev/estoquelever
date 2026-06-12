import { createServiceClient } from "@/lib/supabase-server";

/**
 * Set de localizacao_id com lock ativo (`siso_localizacao_locks` com
 * `finalizado_em IS NULL`) — locs sendo inventariadas.
 *
 * [INV-07] Mesmo filtro que roteamento.ts / sugestao-dinamica.ts /
 * reconciliador-oc.ts (P3-26) já aplicavam inline. Consumidores novos
 * (cascade do parcial, fallback de loc do pick, sugestão de put-away)
 * usam este helper pra não criar reserva nem mandar operador pra dentro
 * de loc em contagem.
 */
export async function locsBloqueadasSet(
  sb?: ReturnType<typeof createServiceClient>,
): Promise<Set<string>> {
  const client = sb ?? createServiceClient();
  const { data } = await client
    .from("siso_localizacao_locks")
    .select("localizacao_id")
    .is("finalizado_em", null);
  return new Set(
    ((data ?? []) as Array<{ localizacao_id: string }>).map(
      (l) => l.localizacao_id,
    ),
  );
}
