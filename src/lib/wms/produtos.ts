import { createServiceClient } from "@/lib/supabase-server";
import type { Produto } from "./types";

export async function listarProdutos(
  filtros: { q?: string; ativo?: boolean; limit?: number; offset?: number } = {},
): Promise<{ rows: Produto[]; total: number }> {
  const sb = createServiceClient();
  const limit = filtros.limit ?? 50;
  const offset = filtros.offset ?? 0;
  let q = sb
    .from("siso_produtos")
    .select("*", { count: "exact" })
    .order("sku", { ascending: true })
    .range(offset, offset + limit - 1);
  if (filtros.q) {
    q = q.or(
      `sku.ilike.%${filtros.q}%,descricao.ilike.%${filtros.q}%,gtin.eq.${filtros.q}`,
    );
  }
  if (filtros.ativo !== undefined) q = q.eq("ativo", filtros.ativo);
  const { data, error, count } = await q;
  if (error) throw error;
  return { rows: (data ?? []) as Produto[], total: count ?? 0 };
}

export async function getProduto(id: string): Promise<Produto | null> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_produtos")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as Produto | null;
}

export async function criarProduto(input: {
  sku: string;
  descricao: string;
  gtin?: string;
  unidade?: string;
  ncm?: string;
}): Promise<Produto> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_produtos")
    .insert({ ...input, unidade: input.unidade ?? "UN" })
    .select()
    .single();
  if (error) throw error;
  return data as Produto;
}

export async function atualizarProduto(
  id: string,
  patch: Partial<Produto>,
): Promise<Produto> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_produtos")
    .update({ ...patch, atualizado_em: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as Produto;
}
