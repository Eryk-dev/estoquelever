import { createServiceClient } from "@/lib/supabase-server";
import { buscarKitsContendoQuery } from "./kits";
import type { Produto } from "./types";

export type ProdutoOrdem =
  | "sku_asc"
  | "sincronizado_desc"
  | "sincronizado_asc";

export async function listarProdutos(
  filtros: {
    q?: string;
    ativo?: boolean;
    limit?: number;
    offset?: number;
    /** Quando true, anexa ao final da lista kits cujos componentes
     *  casam com `q` mas que não apareceram nos resultados diretos. */
    incluir_kits_por_componente?: boolean;
    /** Filtra por kit (true), produto simples (false) ou ambos (undefined). */
    eh_kit?: boolean;
    /** Ordenação. Default: sku_asc. */
    ordem?: ProdutoOrdem;
  } = {},
): Promise<{ rows: Produto[]; total: number; kits_por_componente?: number }> {
  const sb = createServiceClient();
  const limit = filtros.limit ?? 50;
  const offset = filtros.offset ?? 0;
  const ordem = filtros.ordem ?? "sku_asc";

  // Pré-resolve IDs adicionais quando q também pode bater com código de
  // fornecedor ou código de localização (cross-table search).
  let extraIds: Set<string> | null = null;
  if (filtros.q && filtros.q.trim().length > 0) {
    const term = filtros.q.trim();
    const ids = new Set<string>();
    // codigo_fornecedor (siso_produto_fornecedores)
    const { data: forRows } = await sb
      .from("siso_produto_fornecedores")
      .select("produto_id")
      .ilike("codigo_fornecedor", `%${term}%`)
      .limit(500);
    for (const r of (forRows ?? []) as Array<{ produto_id: string }>) {
      ids.add(r.produto_id);
    }
    // localizacao codigo (siso_estoque join siso_localizacoes)
    const { data: estRows } = await sb
      .from("siso_estoque")
      .select("produto_id, localizacao:siso_localizacoes!inner(codigo)")
      .ilike("localizacao.codigo", `%${term}%`)
      .gt("saldo", 0)
      .limit(500);
    for (const r of (estRows ?? []) as Array<{ produto_id: string }>) {
      ids.add(r.produto_id);
    }
    if (ids.size > 0) extraIds = ids;
  }

  let q = sb
    .from("siso_produtos")
    .select("*", { count: "exact" })
    .range(offset, offset + limit - 1);
  if (ordem === "sincronizado_desc") {
    q = q
      .order("sincronizado_em", { ascending: false, nullsFirst: false })
      .order("sku", { ascending: true });
  } else if (ordem === "sincronizado_asc") {
    q = q
      .order("sincronizado_em", { ascending: true, nullsFirst: false })
      .order("sku", { ascending: true });
  } else {
    q = q.order("sku", { ascending: true });
  }
  if (filtros.q) {
    const term = filtros.q.trim();
    const orClauses = [
      `sku.ilike.%${term}%`,
      `descricao.ilike.%${term}%`,
      `gtin.eq.${term}`,
    ];
    if (extraIds && extraIds.size > 0) {
      orClauses.push(`id.in.(${[...extraIds].join(",")})`);
    }
    q = q.or(orClauses.join(","));
  }
  if (filtros.ativo !== undefined) q = q.eq("ativo", filtros.ativo);
  if (filtros.eh_kit !== undefined) q = q.eq("eh_kit", filtros.eh_kit);
  const { data, error, count } = await q;
  if (error) throw error;
  const rows = (data ?? []) as Produto[];

  if (
    filtros.incluir_kits_por_componente &&
    filtros.q &&
    filtros.q.trim().length > 0 &&
    offset === 0
  ) {
    const kits = await buscarKitsContendoQuery(filtros.q, {
      excludeProdutoIds: rows.map((r) => r.id),
      limit: 20,
    });
    if (kits.length > 0) {
      return {
        rows: [...rows, ...kits],
        total: (count ?? 0) + kits.length,
        kits_por_componente: kits.length,
      };
    }
  }

  return { rows, total: count ?? 0 };
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
