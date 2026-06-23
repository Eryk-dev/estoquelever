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
    /** Quando true, anexa ao final os equivalentes CONFIRMADOS do cross
     *  dos produtos que casaram com `q` (substitutos da peça buscada). */
    incluir_equivalentes_cross?: boolean;
    /** Filtra por kit (true), produto simples (false) ou ambos (undefined). */
    eh_kit?: boolean;
    /** Ordenação. Default: sku_asc. */
    ordem?: ProdutoOrdem;
  } = {},
): Promise<{
  rows: Produto[];
  total: number;
  kits_por_componente?: number;
  equivalentes_cross?: number;
}> {
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

  // Extras anexados ao FINAL (kits-por-componente, depois equivalentes-cross).
  // O cliente fatia de trás pra frente usando os counts devolvidos.
  const temQ = !!(filtros.q && filtros.q.trim().length > 0);
  if (temQ && offset === 0) {
    const extras: Produto[] = [];
    let kitsCount = 0;
    let equivCount = 0;

    if (filtros.incluir_kits_por_componente) {
      const kits = await buscarKitsContendoQuery(filtros.q!, {
        excludeProdutoIds: rows.map((r) => r.id),
        limit: 20,
      });
      extras.push(...kits);
      kitsCount = kits.length;
    }

    if (filtros.incluir_equivalentes_cross) {
      const equivs = await buscarEquivalentesCrossQuery(
        sb,
        rows.map((r) => r.sku),
        {
          excludeProdutoIds: [...rows, ...extras].map((r) => r.id),
          limit: 20,
        },
      );
      extras.push(...equivs);
      equivCount = equivs.length;
    }

    if (extras.length > 0) {
      return {
        rows: [...rows, ...extras],
        total: (count ?? 0) + extras.length,
        ...(kitsCount > 0 ? { kits_por_componente: kitsCount } : {}),
        ...(equivCount > 0 ? { equivalentes_cross: equivCount } : {}),
      };
    }
  }

  return { rows, total: count ?? 0 };
}

/**
 * Resolve UM produto por código EXATO — SKU ou GTIN, sem busca por nome.
 * Usado pelo bipe/digitação do inventário: casar pelo `descricao` aproximado
 * (ou pelo código da localização) faria o operador somar estoque no produto
 * errado. SKU é case-insensitive (scanner/digitação variam o caixa); GTIN exato.
 * `.eq`/`.ilike` em queries separadas em vez de `.or()` pra não injetar
 * caractere especial no parser de filtro do PostgREST.
 */
export async function resolverProdutoPorCodigo(
  codigo: string,
): Promise<Produto | null> {
  const sb = createServiceClient();
  const term = codigo.trim();
  if (!term) return null;
  const bySku = await sb
    .from("siso_produtos")
    .select("*")
    .ilike("sku", term)
    .limit(1)
    .maybeSingle();
  if (bySku.data) return bySku.data as Produto;
  const byGtin = await sb
    .from("siso_produtos")
    .select("*")
    .eq("gtin", term)
    .limit(1)
    .maybeSingle();
  return (byGtin.data as Produto | null) ?? null;
}

/**
 * Equivalentes CONFIRMADOS do cross dos `anchorSkus` (peças buscadas).
 * Lê pares confirmados em `siso_cross_equivalencias` que tocam algum anchor,
 * pega o SKU do outro lado e carrega esses produtos (ativos), excluindo os
 * que já estão na lista. Sem corrente transitiva — só vizinhos diretos.
 */
async function buscarEquivalentesCrossQuery(
  sb: ReturnType<typeof createServiceClient>,
  anchorSkus: string[],
  opts: { excludeProdutoIds: string[]; limit: number },
): Promise<Produto[]> {
  const anchors = [...new Set(anchorSkus.filter(Boolean))];
  if (anchors.length === 0) return [];
  const anchorSet = new Set(anchors);

  // Dois selects (sku_a IN / sku_b IN) em vez de .or() pra não injetar SKUs
  // com caractere especial no parser de filtro.
  const [{ data: porA }, { data: porB }] = await Promise.all([
    sb
      .from("siso_cross_equivalencias")
      .select("sku_a, sku_b")
      .eq("status", "confirmado")
      .in("sku_a", anchors),
    sb
      .from("siso_cross_equivalencias")
      .select("sku_a, sku_b")
      .eq("status", "confirmado")
      .in("sku_b", anchors),
  ]);

  const outros = new Set<string>();
  for (const p of [...(porA ?? []), ...(porB ?? [])] as Array<{
    sku_a: string;
    sku_b: string;
  }>) {
    const outro = anchorSet.has(p.sku_a) ? p.sku_b : p.sku_a;
    if (!anchorSet.has(outro)) outros.add(outro);
  }
  if (outros.size === 0) return [];

  const { data } = await sb
    .from("siso_produtos")
    .select("*")
    .in("sku", [...outros])
    .eq("ativo", true)
    .order("sku", { ascending: true })
    .limit(opts.limit);

  const exclude = new Set(opts.excludeProdutoIds);
  return ((data ?? []) as Produto[]).filter((r) => !exclude.has(r.id));
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
