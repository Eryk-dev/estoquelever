import { createServiceClient } from "@/lib/supabase-server";
import type { TipoLocalizacao } from "@/lib/wms/types";

export interface EstoqueCandidato {
  empresa_dona_id: string;
  localizacao_id: string;
  localizacao_codigo: string;
  localizacao_tipo: TipoLocalizacao;
  disponivel: number;
}

export interface ResolverInput {
  produto_id: string;
  empresa_origem_id: string;
  galpao_id: string;
  localizacao_id_original: string;
  qty_residual: number;
}

export interface RealocacaoSugerida {
  empresa_dona_id: string;
  localizacao_id: string;
  localizacao_codigo: string;
  quantidade: number;
  is_emprestimo: boolean;
  empresa_devedora_id: string | null;
}

export interface ResolverResult {
  status: "realocado" | "sem_cobertura";
  realocacoes: RealocacaoSugerida[];
}

export interface ResolverDeps {
  listarEmpresasDoGrupoMesmoGalpao: (
    empresaOrigemId: string,
    galpaoId: string,
  ) => Promise<string[]>;
  listarSaldoCandidato: (input: {
    produto_id: string;
    galpao_id: string;
    empresas_grupo: string[];
    localizacao_id_excluir: string;
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
  const empresas = await deps.listarEmpresasDoGrupoMesmoGalpao(
    input.empresa_origem_id,
    input.galpao_id,
  );

  const candidatos = await deps.listarSaldoCandidato({
    produto_id: input.produto_id,
    galpao_id: input.galpao_id,
    empresas_grupo: empresas,
    localizacao_id_excluir: input.localizacao_id_original,
  });

  if (candidatos.length === 0) {
    return { status: "sem_cobertura", realocacoes: [] };
  }

  const ordenado = [...candidatos].sort((a, b) => {
    // 1. mesma empresa primeiro
    const aMesma = a.empresa_dona_id === input.empresa_origem_id ? 0 : 1;
    const bMesma = b.empresa_dona_id === input.empresa_origem_id ? 0 : 1;
    if (aMesma !== bMesma) return aMesma - bMesma;

    // 2. tipo de localização (picking > overstock > recebimento > expedicao > quarentena)
    const aTipo = TIPO_PRIORIDADE[a.localizacao_tipo] ?? 99;
    const bTipo = TIPO_PRIORIDADE[b.localizacao_tipo] ?? 99;
    if (aTipo !== bTipo) return aTipo - bTipo;

    // 3. maior disponivel primeiro
    if (a.disponivel !== b.disponivel) return b.disponivel - a.disponivel;

    // 4. código ASC (desempate)
    return a.localizacao_codigo.localeCompare(b.localizacao_codigo);
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
      empresa_dona_id: c.empresa_dona_id,
      localizacao_id: c.localizacao_id,
      localizacao_codigo: c.localizacao_codigo,
      quantidade: qty,
      is_emprestimo: c.empresa_dona_id !== input.empresa_origem_id,
      empresa_devedora_id:
        c.empresa_dona_id !== input.empresa_origem_id ? input.empresa_origem_id : null,
    });
    faltando -= qty;
  }

  return { status: "realocado", realocacoes };
}

function defaultDeps(): ResolverDeps {
  return {
    listarEmpresasDoGrupoMesmoGalpao: async (empresaOrigemId, galpaoId) => {
      const supabase = createServiceClient();
      const { data: ge } = await supabase
        .from("siso_grupo_empresas")
        .select("grupo_id")
        .eq("empresa_id", empresaOrigemId)
        .maybeSingle();
      if (!ge?.grupo_id) return [empresaOrigemId];

      const { data: empresas } = await supabase
        .from("siso_grupo_empresas")
        .select("empresa_id, siso_empresas!inner(galpao_id, ativo)")
        .eq("grupo_id", ge.grupo_id);

      const filtradas = (empresas ?? [])
        .filter((e) => {
          const emp = e.siso_empresas as unknown as { galpao_id: string; ativo: boolean };
          return emp.galpao_id === galpaoId && emp.ativo;
        })
        .map((e) => e.empresa_id);

      return filtradas.length > 0 ? filtradas : [empresaOrigemId];
    },

    listarSaldoCandidato: async ({
      produto_id,
      galpao_id,
      empresas_grupo,
      localizacao_id_excluir,
    }) => {
      const supabase = createServiceClient();
      const { data } = await supabase
        .from("siso_estoque")
        .select(
          `
          empresa_dona_id,
          localizacao_id,
          disponivel,
          siso_localizacoes!inner(codigo, tipo)
        `,
        )
        .eq("produto_id", produto_id)
        .eq("galpao_id", galpao_id)
        .in("empresa_dona_id", empresas_grupo)
        .neq("localizacao_id", localizacao_id_excluir)
        .gt("disponivel", 0);

      return (data ?? []).map((row) => {
        const loc = row.siso_localizacoes as unknown as {
          codigo: string;
          tipo: TipoLocalizacao;
        };
        return {
          empresa_dona_id: row.empresa_dona_id as string,
          localizacao_id: row.localizacao_id as string,
          localizacao_codigo: loc.codigo,
          localizacao_tipo: loc.tipo,
          disponivel: Number(row.disponivel),
        };
      });
    },
  };
}
