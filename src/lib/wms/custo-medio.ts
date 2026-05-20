import { createServiceClient } from "@/lib/supabase-server";
import type { CustoMedio } from "./types";

export async function obterCustoMedio(produtoId: string): Promise<number> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("siso_custo_medio")
    .select("custo_medio")
    .eq("produto_id", produtoId)
    .maybeSingle();
  return data?.custo_medio ?? 0;
}

export async function listarCustosMedios(): Promise<CustoMedio[]> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("siso_custo_medio")
    .select("produto_id, custo_medio, ultima_movimentacao_id, atualizado_em")
    .order("atualizado_em", { ascending: false });
  return data ?? [];
}

/**
 * Função pura — calcula novo custo médio.
 * saldoGlobalAtual = saldo total do produto somando todas as locs+galpões (snapshot antes da entrada)
 */
export function calcularNovoCustoMedio(
  saldoGlobalAtual: number,
  custoAtual: number,
  qtyEntrada: number,
  custoUnitarioEntrada: number,
): number {
  if (saldoGlobalAtual + qtyEntrada <= 0) {
    return custoUnitarioEntrada;
  }
  return (
    (saldoGlobalAtual * custoAtual + qtyEntrada * custoUnitarioEntrada) /
    (saldoGlobalAtual + qtyEntrada)
  );
}
