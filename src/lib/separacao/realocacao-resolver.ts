import { createServiceClient } from "@/lib/supabase-server";
import type { TipoLocalizacao } from "@/lib/wms/types";
import { naturalLocCompare } from "@/lib/wms/loc-compare";
import { locsBloqueadasSet } from "@/lib/wms/loc-locks";

// 3D (Fase 5 Batch C):
// Cascade de realocação opera no pool físico do galpão — sem empresa_dona.
// Próxima loc = qualquer loc no mesmo (produto, galpao) com saldo > 0,
// excluindo as já tentadas.

export interface EstoqueCandidato {
  localizacao_id: string;
  localizacao_codigo: string;
  localizacao_tipo: TipoLocalizacao;
  disponivel: number;
}

export interface ResolverInput {
  produto_id: string;
  galpao_id: string;
  /** Loc original do item (compat com chamadas legacy — usado quando localizacoes_excluir não é passado). */
  localizacao_id_original?: string;
  /** Lista completa de localizações a excluir do pool. Tem precedência sobre localizacao_id_original. */
  localizacoes_excluir?: string[];
  qty_residual: number;
}

export interface RealocacaoSugerida {
  localizacao_id: string;
  localizacao_codigo: string;
  quantidade: number;
}

export interface ResolverResult {
  status: "realocado" | "sem_cobertura";
  realocacoes: RealocacaoSugerida[];
}

export interface ResolverDeps {
  listarSaldoCandidato: (input: {
    produto_id: string;
    galpao_id: string;
    localizacoes_excluir?: string[];
  }) => Promise<EstoqueCandidato[]>;
}

const TIPO_PRIORIDADE: Record<TipoLocalizacao, number> = {
  picking: 1,
  overstock: 2,
  recebimento: 3,
  expedicao: 4,
  quarentena: 5,
};

export async function resolverRealocacao(
  input: ResolverInput,
  deps: ResolverDeps = defaultDeps(),
): Promise<ResolverResult> {
  const excluir =
    input.localizacoes_excluir && input.localizacoes_excluir.length > 0
      ? input.localizacoes_excluir
      : input.localizacao_id_original
        ? [input.localizacao_id_original]
        : [];

  const candidatos = await deps.listarSaldoCandidato({
    produto_id: input.produto_id,
    galpao_id: input.galpao_id,
    localizacoes_excluir: excluir,
  });

  if (candidatos.length === 0) {
    return { status: "sem_cobertura", realocacoes: [] };
  }

  const ordenado = [...candidatos].sort((a, b) => {
    // 1. tipo de localização (picking > overstock > recebimento > expedicao > quarentena)
    const aTipo = TIPO_PRIORIDADE[a.localizacao_tipo] ?? 99;
    const bTipo = TIPO_PRIORIDADE[b.localizacao_tipo] ?? 99;
    if (aTipo !== bTipo) return aTipo - bTipo;

    // 2. maior disponivel primeiro
    if (a.disponivel !== b.disponivel) return b.disponivel - a.disponivel;

    // 3. código ASC (desempate) — natural sort (A-2 < A-10)
    return naturalLocCompare(a.localizacao_codigo, b.localizacao_codigo);
  });

  // Verifica cobertura total antes de comprometer (tudo ou nada)
  const totalDisponivel = ordenado.reduce((acc, c) => acc + c.disponivel, 0);
  if (totalDisponivel < input.qty_residual) {
    return { status: "sem_cobertura", realocacoes: [] };
  }

  const realocacoes: RealocacaoSugerida[] = [];
  let faltando = input.qty_residual;

  for (const c of ordenado) {
    if (faltando <= 0) break;
    const qty = Math.min(c.disponivel, faltando);
    realocacoes.push({
      localizacao_id: c.localizacao_id,
      localizacao_codigo: c.localizacao_codigo,
      quantidade: qty,
    });
    faltando -= qty;
  }

  return { status: "realocado", realocacoes };
}

function defaultDeps(): ResolverDeps {
  return {
    listarSaldoCandidato: async ({
      produto_id,
      galpao_id,
      localizacoes_excluir,
    }) => {
      const supabase = createServiceClient();
      const excluir = localizacoes_excluir ?? [];

      // 3D: pool fungível por (produto, galpao) — sem filtro por dona.
      let query = supabase
        .from("siso_estoque")
        .select(
          `
          localizacao_id,
          disponivel,
          siso_localizacoes!inner(codigo, tipo)
        `,
        )
        .eq("produto_id", produto_id)
        .eq("galpao_id", galpao_id)
        .gt("disponivel", 0);

      if (excluir.length > 0) {
        query = query.not("localizacao_id", "in", `(${excluir.join(",")})`);
      }

      const [{ data }, bloqueadas] = await Promise.all([
        query,
        // [INV-07] Loc em contagem de inventário não recebe R cascade — criar
        // reserva lá manda o picker pra dentro da loc sendo contada e pode
        // travar a aplicação da perda (preflight INV-02/04).
        locsBloqueadasSet(supabase),
      ]);

      return (data ?? [])
        .filter((row) => !bloqueadas.has(row.localizacao_id as string))
        .map((row) => {
        const loc = row.siso_localizacoes as unknown as {
          codigo: string;
          tipo: TipoLocalizacao;
        };
        return {
          localizacao_id: row.localizacao_id as string,
          localizacao_codigo: loc.codigo,
          localizacao_tipo: loc.tipo,
          disponivel: Number(row.disponivel),
        };
      });
    },
  };
}
