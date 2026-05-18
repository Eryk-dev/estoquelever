import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

export interface MappingDeps {
  buscarProdutoId: (empresaId: string, tinyProdutoId: string) => Promise<string | null>;
  buscarLocalizacaoId: (galpaoId: string, codigo: string) => Promise<string | null>;
  criarLocalizacao: (galpaoId: string, codigo: string) => Promise<string | null>;
}

export async function resolverProdutoWms(
  empresaId: string,
  tinyProdutoId: string,
  deps: MappingDeps = defaultDeps(),
): Promise<string> {
  const id = await deps.buscarProdutoId(empresaId, tinyProdutoId);
  if (!id) {
    throw new Error(
      `produto Tiny ${tinyProdutoId} (empresa ${empresaId}) não mapeado em siso_produto_empresas`,
    );
  }
  return id;
}

export async function resolverLocalizacaoWms(
  galpaoId: string,
  codigo: string | null | undefined,
  deps: MappingDeps = defaultDeps(),
): Promise<string> {
  const codigoNormalizado = (codigo ?? "").trim();
  const codigoBusca = codigoNormalizado || "DEFAULT-PICKING";

  const existente = await deps.buscarLocalizacaoId(galpaoId, codigoBusca);
  if (existente) return existente;

  if (codigoBusca === "DEFAULT-PICKING") {
    throw new Error(
      `DEFAULT-PICKING não encontrada em galpão ${galpaoId} — schema corrompido`,
    );
  }

  const novoId = await deps.criarLocalizacao(galpaoId, codigoBusca);
  if (novoId) return novoId;

  logger.warn("wms-mapping", "Falhou criar loc, fallback DEFAULT-PICKING", {
    galpaoId,
    codigo: codigoBusca,
  });
  const fallback = await deps.buscarLocalizacaoId(galpaoId, "DEFAULT-PICKING");
  if (!fallback) {
    throw new Error(
      `DEFAULT-PICKING não encontrada em galpão ${galpaoId} (fallback)`,
    );
  }
  return fallback;
}

function defaultDeps(): MappingDeps {
  return {
    buscarProdutoId: async (empresaId, tinyProdutoId) => {
      const supabase = createServiceClient();
      const { data } = await supabase
        .from("siso_produto_empresas")
        .select("produto_id")
        .eq("empresa_id", empresaId)
        .eq("tiny_produto_id", Number(tinyProdutoId))
        .maybeSingle();
      return data?.produto_id ?? null;
    },
    buscarLocalizacaoId: async (galpaoId, codigo) => {
      const supabase = createServiceClient();
      const { data } = await supabase
        .from("siso_localizacoes")
        .select("id")
        .eq("galpao_id", galpaoId)
        .eq("codigo", codigo)
        .eq("ativo", true)
        .maybeSingle();
      return data?.id ?? null;
    },
    criarLocalizacao: async (galpaoId, codigo) => {
      const supabase = createServiceClient();
      const { data, error } = await supabase
        .from("siso_localizacoes")
        .insert({
          galpao_id: galpaoId,
          codigo,
          tipo: "picking",
          descricao: `Auto-criada (origem Tiny)`,
          ativo: true,
        })
        .select("id")
        .single();
      if (error) {
        logger.error("wms-mapping", "Falhou criar loc", {
          error: error.message,
          galpaoId,
          codigo,
        });
        return null;
      }
      return data.id;
    },
  };
}
