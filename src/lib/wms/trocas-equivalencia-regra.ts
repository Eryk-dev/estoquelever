/**
 * Regra PURA da troca de equivalência (plano 2026-06-12-cross-troca-equivalencia).
 *
 * Decide se uma troca vendido→substituto é LIVRE (auto, zero humano),
 * exige APROVAÇÃO, ou está BLOQUEADA:
 *
 *   par 'bloqueado' (override curadoria)        → bloqueada
 *   item já tem picks do vendido (misto — D7)   → aprovação ('misto')
 *   tier ausente em qualquer lado               → aprovação ('sem_classificacao')
 *   mesmo tier + par 'verificado' (D9)          → LIVRE ('mesmo_nivel')
 *   mesmo tier sem verificação                  → aprovação ('mesmo_nivel')
 *   tier diferente (mesmo verificado — D2)      → aprovação ('upgrade'|'downgrade')
 *
 * Upgrade TAMBÉM exige aprovação: sem isso, operador manda peça original em
 * anúncio de importado sempre (decisão explícita do Eryk).
 */

export type TierQualidade = "original" | "primeira_linha" | "segunda_linha";

export type TrocaTipo =
  | "mesmo_nivel"
  | "upgrade"
  | "downgrade"
  | "sem_classificacao"
  | "misto";

export type ParVerificacao = "verificado" | "bloqueado" | null;

export interface RegraTrocaInput {
  /** tier do produto VENDIDO (anunciado) — null = sem classificação */
  tierVendido: TierQualidade | null;
  /** tier do produto SUBSTITUTO (peça física a enviar) */
  tierSubstituto: TierQualidade | null;
  /** status do par no caderno do cross (null = nunca curado) */
  parVerificacao: ParVerificacao;
  /** true quando o item já tem quantidade_pega > 0 do vendido (cliente receberá mistura) */
  misto: boolean;
}

export type RegraTrocaResultado =
  | { resultado: "bloqueada"; tipo: null }
  | { resultado: "livre" | "aprovacao"; tipo: TrocaTipo };

export const TIER_RANK: Record<TierQualidade, number> = {
  original: 3,
  primeira_linha: 2,
  segunda_linha: 1,
};

export const TIER_LABEL: Record<TierQualidade, string> = {
  original: "Original",
  primeira_linha: "1ª linha",
  segunda_linha: "2ª linha",
};

export function regraTroca(input: RegraTrocaInput): RegraTrocaResultado {
  if (input.parVerificacao === "bloqueado") {
    return { resultado: "bloqueada", tipo: null };
  }
  // D7: mistura de marcas no mesmo pedido SEMPRE passa por humano — rótulo
  // 'misto' prevalece sobre upgrade/downgrade pro modal avisar certo.
  if (input.misto) {
    return { resultado: "aprovacao", tipo: "misto" };
  }
  if (!input.tierVendido || !input.tierSubstituto) {
    return { resultado: "aprovacao", tipo: "sem_classificacao" };
  }
  if (input.tierVendido === input.tierSubstituto) {
    return input.parVerificacao === "verificado"
      ? { resultado: "livre", tipo: "mesmo_nivel" }
      : { resultado: "aprovacao", tipo: "mesmo_nivel" };
  }
  const tipo: TrocaTipo =
    TIER_RANK[input.tierSubstituto] > TIER_RANK[input.tierVendido]
      ? "upgrade"
      : "downgrade";
  return { resultado: "aprovacao", tipo };
}
