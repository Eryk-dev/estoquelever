import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { TIPOS_LOC_VENDAVEIS } from "@/lib/wms/roteamento";
import { locsBloqueadasSet } from "@/lib/wms/loc-locks";

export interface MappingDeps {
  buscarProdutoId: (empresaId: string, tinyProdutoId: string) => Promise<string | null>;
  /** Resolve uuid WMS direto pelo SKU (siso_produtos.sku é UNIQUE global). */
  buscarProdutoIdPorSku: (sku: string) => Promise<string | null>;
  buscarLocalizacaoId: (galpaoId: string, codigo: string) => Promise<string | null>;
  criarLocalizacao: (galpaoId: string, codigo: string) => Promise<string | null>;
}

/** Pistas pra resolver o produto FÍSICO de um item, em ordem de prioridade. */
export interface ProdutoRef {
  tinyProdutoId?: string | number | null;
  sku?: string | null;
  substitutoId?: string | null;
}

/**
 * Resolve o uuid do produto WMS por qualquer pista disponível, em ordem:
 *   1. `substitutoId` — troca de equivalência (uuid físico direto).
 *   2. tiny bridge `(empresa, tiny_produto_id)` — caminho normal, rápido.
 *   3. SKU → `siso_produtos.sku` (UNIQUE global) — fallback p/ itens sem vínculo
 *      Tiny (`produto_id=0`) ou empresa sem bridge (venda cross-catálogo no ML,
 *      ex. NetParts vendendo SKU cadastrado só na NetAir).
 *
 * O SKU é resolvido SEM filtro de empresa de propósito: o catálogo WMS é
 * unificado (`siso_produtos`) e o estoque é fungível por `(produto, galpão,
 * loc)` — a empresa é só TAG fiscal (modelo 3D), o tiny_produto_id é a camada
 * fiscal/marketplace e não importa pro estoque.
 *
 * Tiny vem ANTES do SKU pra não regredir o caminho normal (id>0 com bridge):
 * o SKU só age quando o tiny falha (id=0 ou sem bridge).
 */
export async function resolverProdutoWmsFlex(
  empresaId: string,
  ref: ProdutoRef,
  deps: MappingDeps = defaultDeps(),
): Promise<string> {
  if (ref.substitutoId) return ref.substitutoId;

  const tiny = ref.tinyProdutoId != null ? String(ref.tinyProdutoId).trim() : "";
  if (tiny && Number(tiny) > 0) {
    const byTiny = await deps.buscarProdutoId(empresaId, tiny);
    if (byTiny) return byTiny;
  }

  const sku = ref.sku?.trim();
  if (sku) {
    const bySku = await deps.buscarProdutoIdPorSku(sku);
    if (bySku) return bySku;
  }

  throw new Error(
    `produto não resolvível (tiny=${tiny || "—"}, sku=${sku || "—"}, empresa ${empresaId}): ` +
      `não mapeado em siso_produto_empresas nem encontrado por SKU em siso_produtos`,
  );
}

/** SKU → uuid WMS (UNIQUE global). null se o SKU não existir no catálogo. */
export async function resolverProdutoWmsPorSku(
  sku: string | null | undefined,
  deps: MappingDeps = defaultDeps(),
): Promise<string | null> {
  const s = sku?.trim();
  if (!s) return null;
  return deps.buscarProdutoIdPorSku(s);
}

/**
 * Resolve produto WMS só por tiny_produto_id (sem fallback SKU). Mantido como
 * primitivo de compat; prefira `resolverProdutoEfetivoDoItem` (tem o item com
 * SKU) ou `resolverProdutoWmsFlex` (passa a pista que tiver).
 */
export async function resolverProdutoWms(
  empresaId: string,
  tinyProdutoId: string,
  deps: MappingDeps = defaultDeps(),
): Promise<string> {
  return resolverProdutoWmsFlex(empresaId, { tinyProdutoId }, deps);
}

/**
 * Resolve o produto FÍSICO (efetivo) de um item de pedido.
 *
 * Troca de equivalência (2026-06-12): quando o item teve troca aprovada,
 * `produto_wms_substituto_id` aponta direto pro uuid WMS da peça que
 * fisicamente sai do estoque — `produto_id` (tiny) fica intocado porque é a
 * camada fiscal (NF/marketplace mantêm o SKU vendido, D3). Todo caminho que
 * cria/consome reserva, pick ou estorno deve resolver por AQUI, nunca por
 * `resolverProdutoWms` direto, senão opera no produto errado pós-troca.
 */
export async function resolverProdutoEfetivoDoItem(
  empresaId: string,
  item: {
    produto_id: number | string;
    sku?: string | null;
    produto_wms_substituto_id?: string | null;
  },
  deps: MappingDeps = defaultDeps(),
): Promise<string> {
  return resolverProdutoWmsFlex(
    empresaId,
    {
      tinyProdutoId: item.produto_id,
      sku: item.sku,
      substitutoId: item.produto_wms_substituto_id,
    },
    deps,
  );
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
  // [INV-07] Exclui locs com lock de inventário ativo — mesma regra de
  // roteamento.ts/sugestao-dinamica.ts. Busca top-20 por disponivel e pega a
  // primeira não-travada (antes era limit(1), que podia cair numa loc em
  // contagem e direcionar pick/reserva pra dentro dela).
  const bloqueadas = await locsBloqueadasSet(supabase);
  if (opts?.apenasVendaveis) {
    const { data } = await supabase
      .from("siso_estoque")
      .select("localizacao_id, siso_localizacoes!inner(tipo)")
      .eq("galpao_id", galpaoId)
      .eq("produto_id", produtoUuid)
      .in("siso_localizacoes.tipo", [...TIPOS_LOC_VENDAVEIS])
      .gt("disponivel", 0)
      .order("disponivel", { ascending: false })
      .limit(20);
    const livre = (data ?? []).find(
      (r) => !bloqueadas.has(r.localizacao_id as string),
    );
    return (livre?.localizacao_id as string | undefined) ?? null;
  }
  const { data } = await supabase
    .from("siso_estoque")
    .select("localizacao_id")
    .eq("galpao_id", galpaoId)
    .eq("produto_id", produtoUuid)
    .gt("disponivel", 0)
    .order("disponivel", { ascending: false })
    .limit(20);
  const livre = (data ?? []).find(
    (r) => !bloqueadas.has(r.localizacao_id as string),
  );
  return (livre?.localizacao_id as string | undefined) ?? null;
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
    buscarProdutoIdPorSku: async (sku) => {
      const supabase = createServiceClient();
      const { data } = await supabase
        .from("siso_produtos")
        .select("id")
        .eq("sku", sku)
        .maybeSingle();
      return data?.id ?? null;
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
