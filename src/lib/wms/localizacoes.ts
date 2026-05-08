import { createServiceClient } from "@/lib/supabase-server";
import type { Localizacao, TipoLocalizacao } from "./types";

export async function listarLocalizacoes(galpaoId?: string): Promise<Localizacao[]> {
  const sb = createServiceClient();
  let q = sb.from("siso_localizacoes").select("*").eq("ativo", true).order("codigo");
  if (galpaoId) q = q.eq("galpao_id", galpaoId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Localizacao[];
}

export async function criarLocalizacao(input: {
  galpao_id: string;
  codigo: string;
  descricao?: string;
  tipo?: TipoLocalizacao;
}): Promise<Localizacao> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_localizacoes")
    .insert({ ...input, tipo: input.tipo ?? "picking" })
    .select()
    .single();
  if (error) throw error;
  return data as Localizacao;
}

export async function atualizarLocalizacao(
  id: string,
  patch: Partial<Localizacao>,
): Promise<Localizacao> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_localizacoes")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as Localizacao;
}

export async function desativarLocalizacao(id: string): Promise<void> {
  const sb = createServiceClient();
  const { data: estoque } = await sb
    .from("siso_estoque")
    .select("saldo")
    .eq("localizacao_id", id)
    .gt("saldo", 0)
    .limit(1);
  if (estoque && estoque.length > 0) {
    throw new Error("não é possível desativar: localização tem saldo");
  }
  await sb.from("siso_localizacoes").update({ ativo: false }).eq("id", id);
}
