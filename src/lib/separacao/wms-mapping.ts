import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { TIPOS_LOC_VENDAVEIS } from "@/lib/wms/roteamento";

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

/**
 * Busca a localizacao com MAIOR saldo *disponível* do produto no galpão.
 * Usado como fallback live quando o snapshot de siso_pedido_item_estoques
 * está vazio (ex.: pedido chegou antes do recebimento, saldo era 0 no webhook).
 *
 * PR-2 #2.3: usa `disponivel` (= saldo - reservado) em vez de `saldo` cru —
 * com WMS_AS_SOURCE ativo as reservas R viram parte de `reservado`, então
 * uma loc com saldo=10/reservado=10 não tem nada pra picar. Ordenar por
 * disponivel evita sugerir loc impick-ável.
 *
 * Retorna o ID da loc (uuid de siso_localizacoes) ou null se nenhuma loc
 * tem disponível positivo.
 *
 * CST-01: `opts.apenasVendaveis` restringe a locs de tipo vendável
 * (picking/overstock) — usado pela criação de reserva R em aprovar, pra não
 * reservar saldo de quarentena/recebimento/packing/expedicao. O fallback de
 * pick (pick-mov/marcar-item/parcial) segue sem filtro (comportamento antigo).
 */
export async function buscarLocComMaiorSaldoNoGalpao(
  galpaoId: string,
  produtoUuid: string,
  opts?: { apenasVendaveis?: boolean },
): Promise<string | null> {
  const supabase = createServiceClient();
  if (opts?.apenasVendaveis) {
    const { data } = await supabase
      .from("siso_estoque")
      .select("localizacao_id, siso_localizacoes!inner(tipo)")
      .eq("galpao_id", galpaoId)
      .eq("produto_id", produtoUuid)
      .in("siso_localizacoes.tipo", [...TIPOS_LOC_VENDAVEIS])
      .gt("disponivel", 0)
      .order("disponivel", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.localizacao_id as string | null | undefined) ?? null;
  }
  const { data } = await supabase
    .from("siso_estoque")
    .select("localizacao_id")
    .eq("galpao_id", galpaoId)
    .eq("produto_id", produtoUuid)
    .gt("disponivel", 0)
    .order("disponivel", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.localizacao_id as string | null | undefined) ?? null;
}

/**
 * Resolve qual galpão usar pra resolver localizações/movs durante separação.
 *
 * Em fluxos `transferencia` o pedido nasce em uma empresa (`empresa_origem_id`)
 * mas é separado em outro galpão (`separacao_galpao_id` aponta pro destino
 * que tem o estoque). Sem esse helper, código que olhava `empresa_origem_id`
 * pra resolver galpão acabava buscando loc na empresa errada (#A4).
 *
 * Em fluxos `propria`, `separacao_galpao_id` pode ser NULL no início e a
 * separação acontece no galpão preferencial da empresa_origem — o caller
 * resolve esse galpão upstream e popula `empresa_origem_galpao_id` no objeto.
 *
 * Lança quando ambos são null: situação indica pedido em estado inválido.
 */
type PedidoComGalpao = {
  separacao_galpao_id?: string | null;
  empresa_origem_galpao_id?: string | null;
};

export function resolveSeparacaoGalpao(pedido: PedidoComGalpao): string {
  if (pedido.separacao_galpao_id) return pedido.separacao_galpao_id;
  if (pedido.empresa_origem_galpao_id) return pedido.empresa_origem_galpao_id;
  throw new Error(
    "resolveSeparacaoGalpao: pedido sem galpão resolvível (separacao_galpao_id e empresa_origem_galpao_id ambos null)",
  );
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
        // UNIQUE(galpao_id, codigo): a loc existe mas está inativa
        // (buscarLocalizacaoId filtra ativo=true) — reativa em vez de
        // cair pro fallback DEFAULT-PICKING.
        if (error.code === "23505") {
          const { data: reativada } = await supabase
            .from("siso_localizacoes")
            .update({ ativo: true })
            .eq("galpao_id", galpaoId)
            .eq("codigo", codigo)
            .select("id")
            .maybeSingle();
          if (reativada?.id) return reativada.id as string;
        }
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
