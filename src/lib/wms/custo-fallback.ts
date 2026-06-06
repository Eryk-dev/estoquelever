import { createServiceClient } from "@/lib/supabase-server";

/**
 * Resolve o custo unitário de uma entrada (nf_compra / recebimento OC).
 * - Se `custo_informado > 0`, usa-o.
 * - Senão, cai pro custo médio histórico (`siso_custo_medio`) do produto.
 * - Se não houver nem informado nem histórico (produto novo), lança erro —
 *   a entrada NÃO pode ser gravada com custo 0 (guard P108 da RPC).
 */
export async function resolverCustoEntrada(input: {
  produto_id: string;
  custo_informado?: number | null;
}): Promise<number> {
  const informado = Number(input.custo_informado ?? 0);
  if (informado > 0) return informado;

  const sb = createServiceClient();
  const { data } = await sb
    .from("siso_custo_medio")
    .select("custo_medio")
    .eq("produto_id", input.produto_id)
    .maybeSingle();
  const historico = Number((data as { custo_medio?: number } | null)?.custo_medio ?? 0);
  if (historico > 0) return historico;

  throw new Error(
    `custo unitário obrigatório: produto ${input.produto_id} não tem custo informado nem histórico`,
  );
}
