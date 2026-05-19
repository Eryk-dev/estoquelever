import type { SupabaseClient } from "@supabase/supabase-js";

export interface DisponibilidadeContext {
  produto_id: string;
  galpao_id: string;
  /** Empresa que vende — usada como tiebreak: se ela tem saldo, prefere baixar dela. */
  empresa_origem_id?: string;
}

export interface DisponibilidadeSugestao {
  empresa_dona_id: string;
  empresa_dona_nome: string;
  localizacao_id: string;
  localizacao_codigo: string;
  localizacao_tipo: string;
  disponivel: number;
}

export interface DisponibilidadeResult {
  total_disponivel: number;
  sugestao: DisponibilidadeSugestao | null;
}

interface EstoqueRow {
  empresa_dona_id: string;
  localizacao_id: string;
  disponivel: number;
  empresa?: { nome?: string };
  localizacao?: { codigo?: string; tipo?: string };
}

/**
 * Resolve a melhor (empresa_dona, localização) com saldo disponível pra
 * baixar a venda de um produto num galpão. Ordem de preferência:
 *
 * 1. Se a empresa_origem_id (quem vende) tem saldo, prefere ela (evita
 *    pegar emprestado de outra empresa quando a própria tem estoque).
 * 2. Loc tipo='picking' antes de overstock/outros tipos.
 * 3. Maior `disponivel` desempata.
 *
 * Locs tipo='recebimento' são **ignoradas** — estoque em recebimento ainda
 * não foi guardado e não deve ser sugerido como origem de venda.
 */
export async function resolverDisponibilidadeVenda(
  sb: SupabaseClient,
  ctx: DisponibilidadeContext,
): Promise<DisponibilidadeResult> {
  const { data, error } = await sb
    .from("siso_estoque")
    .select(
      `
        empresa_dona_id, localizacao_id, disponivel,
        empresa:siso_empresas(nome),
        localizacao:siso_localizacoes(codigo, tipo)
      `,
    )
    .match({ produto_id: ctx.produto_id, galpao_id: ctx.galpao_id })
    .gt("disponivel", 0);

  if (error) throw error;

  const rows = ((data ?? []) as unknown as EstoqueRow[]).filter(
    (r) =>
      !!r.localizacao?.codigo &&
      r.localizacao?.tipo !== "recebimento",
  );

  const total = rows.reduce((acc, r) => acc + Number(r.disponivel), 0);

  if (rows.length === 0) {
    return { total_disponivel: 0, sugestao: null };
  }

  rows.sort((a, b) => {
    const aMatch = ctx.empresa_origem_id && a.empresa_dona_id === ctx.empresa_origem_id ? 0 : 1;
    const bMatch = ctx.empresa_origem_id && b.empresa_dona_id === ctx.empresa_origem_id ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    const aPick = a.localizacao?.tipo === "picking" ? 0 : 1;
    const bPick = b.localizacao?.tipo === "picking" ? 0 : 1;
    if (aPick !== bPick) return aPick - bPick;
    return Number(b.disponivel) - Number(a.disponivel);
  });

  const top = rows[0];
  return {
    total_disponivel: total,
    sugestao: {
      empresa_dona_id: top.empresa_dona_id,
      empresa_dona_nome: top.empresa?.nome ?? "",
      localizacao_id: top.localizacao_id,
      localizacao_codigo: top.localizacao!.codigo!,
      localizacao_tipo: top.localizacao!.tipo ?? "picking",
      disponivel: Number(top.disponivel),
    },
  };
}
