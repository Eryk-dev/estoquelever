import { createServiceClient } from "@/lib/supabase-server";

export interface EmprestimoRegra {
  id: string;
  empresa_credora_id: string;
  empresa_devedora_id: string;
  ativo: boolean;
  limite_max_por_produto: number | null;
  limites_por_produto: Record<string, number>;
  observacoes: string | null;
}

export interface SaldoDevedor {
  credora: string;
  devedora: string;
  produto_id: string;
  saldo_liquido: number;
}

export async function listarRegras(): Promise<EmprestimoRegra[]> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_emprestimo_regras")
    .select("*")
    .eq("ativo", true);
  if (error) throw error;
  return (data ?? []) as EmprestimoRegra[];
}

export async function criarRegra(input: {
  empresa_credora_id: string;
  empresa_devedora_id: string;
  limite_max_por_produto?: number;
  observacoes?: string;
}): Promise<EmprestimoRegra> {
  if (input.empresa_credora_id === input.empresa_devedora_id) {
    throw new Error("credora e devedora devem ser empresas diferentes");
  }
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_emprestimo_regras")
    .insert(input)
    .select()
    .single();
  if (error) throw error;
  return data as EmprestimoRegra;
}

export async function listarCredorasPara(
  empresaDevedoraId: string,
): Promise<string[]> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_emprestimo_regras")
    .select("empresa_credora_id")
    .eq("empresa_devedora_id", empresaDevedoraId)
    .eq("ativo", true);
  if (error) throw error;
  return (data ?? []).map((r) => (r as { empresa_credora_id: string }).empresa_credora_id);
}

/**
 * Saldo devedor por par (credora, devedora) por produto, líquido bidirecional.
 */
export async function saldosDevedores(): Promise<SaldoDevedor[]> {
  const sb = createServiceClient();
  const { data, error } = await sb.rpc("wms_saldos_devedores");
  if (error) throw error;
  return (data ?? []) as unknown as SaldoDevedor[];
}
