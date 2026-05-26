import type { SupabaseClient } from "@supabase/supabase-js";

export interface DisponibilidadeContext {
  produto_id: string;
  galpao_id: string;
}

export interface DisponibilidadeSugestao {
  localizacao_id: string;
  localizacao_codigo: string;
  localizacao_tipo: string;
  disponivel: number;
}

export interface DisponibilidadeResult {
  total_disponivel: number;
  /** Primeira sugestão ordenada (compat — = sugestoes[0] ?? null). */
  sugestao: DisponibilidadeSugestao | null;
  /** Lista completa de locs com saldo, ordenada por preferência (picking>overstock>recebimento, depois maior disponivel). */
  sugestoes: DisponibilidadeSugestao[];
}

interface EstoqueRow {
  localizacao_id: string;
  disponivel: number;
  localizacao?: { codigo?: string; tipo?: string };
}

// Ordem de preferência de tipo de localização — picking primeiro pra
// minimizar caminhada do separador, depois overstock pra esgotar overflow,
// recebimento como último recurso (estoque ainda não guardado), e qualquer
// outro tipo abaixo.
const TIPO_RANK: Record<string, number> = {
  picking: 0,
  overstock: 1,
  recebimento: 2,
};
function rankTipo(tipo?: string): number {
  return TIPO_RANK[tipo ?? ""] ?? 3;
}

/**
 * Resolve a melhor localização com saldo disponível pra baixar a venda de
 * um produto num galpão. Em 3D, estoque é fungível dentro do galpão — não
 * há mais ordenação por empresa dona.
 *
 * Ordem de preferência:
 *   1. Tipo da loc: picking > overstock > recebimento > outros
 *   2. Maior `disponivel` desempata
 *
 * Retorna uma única resolução (loc_id + qty disponível) — o caller decide
 * o que fazer quando `total_disponivel < qty pedida`.
 */
export async function resolverDisponibilidadeVenda(
  sb: SupabaseClient,
  ctx: DisponibilidadeContext,
): Promise<DisponibilidadeResult> {
  const { data, error } = await sb
    .from("siso_estoque")
    .select(
      `
        localizacao_id, disponivel,
        localizacao:siso_localizacoes(codigo, tipo)
      `,
    )
    .match({ produto_id: ctx.produto_id, galpao_id: ctx.galpao_id })
    .gt("disponivel", 0);

  if (error) throw error;

  const rows = ((data ?? []) as unknown as EstoqueRow[]).filter(
    (r) => !!r.localizacao?.codigo,
  );

  const total = rows.reduce((acc, r) => acc + Number(r.disponivel), 0);

  if (rows.length === 0) {
    return { total_disponivel: 0, sugestao: null, sugestoes: [] };
  }

  rows.sort((a, b) => {
    const aRank = rankTipo(a.localizacao?.tipo);
    const bRank = rankTipo(b.localizacao?.tipo);
    if (aRank !== bRank) return aRank - bRank;
    return Number(b.disponivel) - Number(a.disponivel);
  });

  const sugestoes: DisponibilidadeSugestao[] = rows.map((r) => ({
    localizacao_id: r.localizacao_id,
    localizacao_codigo: r.localizacao!.codigo!,
    localizacao_tipo: r.localizacao!.tipo ?? "picking",
    disponivel: Number(r.disponivel),
  }));

  return {
    total_disponivel: total,
    sugestao: sugestoes[0] ?? null,
    sugestoes,
  };
}
