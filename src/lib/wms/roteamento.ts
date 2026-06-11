import { createServiceClient } from "@/lib/supabase-server";

// Modelo 3D (Fase 5 Batch C):
// - Pool físico fungível por (produto, galpao, localização) — sem dona.
// - Não há mais "empréstimo"/"swap" — quem precisa do estoque, usa direto.
// - Decisão simplificada: propria (galpão home cobre tudo) > transferencia
//   (outro galpão cobre tudo) > oc (ninguém cobre).

/**
 * CST-01: tipos de localização VENDÁVEIS — os únicos que contam pra cobertura
 * de roteamento e onde reservas R de pedido podem ser criadas. Saldo em
 * recebimento/quarentena/packing/expedicao NÃO é vendável (ex.: devolução
 * avariada parada na quarentena não pode rotear um pedido pra 'propria').
 */
export const TIPOS_LOC_VENDAVEIS = ["picking", "overstock"] as const;

export interface GalpaoLite {
  id: string;
  cidade: string | null;
  estado: string | null;
}

export interface EmpresaLite {
  id: string;
  /**
   * Galpões preferenciais — usados como "home" pra ordem de preferência
   * geográfica do roteamento. Vazio = sem preferência.
   */
  galpoes_preferenciais: string[];
}

export interface ItemPedido {
  produto_id: string;
  qty: number;
}

export interface LinhaCandidata {
  id: string;
  localizacao_id: string;
  disponivel: number;
}

export interface RotaItem extends ItemPedido {
  galpao_id: string;
  localizacao_id: string;
  tipo: "propria" | "transferencia";
}

export type RotaResult =
  | { decisao: "propria" | "transferencia"; rotas: RotaItem[]; galpao_id: string }
  | { decisao: "oc"; motivo: "sem_cobertura" | "split_galpoes" };

export interface RotearContext {
  vendedora: EmpresaLite;
  galpoes: GalpaoLite[];
  itens: ItemPedido[];
  /**
   * Busca a melhor linha de estoque (qualquer dona) pra essa
   * (produto, galpão) com `disponivel >= qty`. Retorna null se nada cobre.
   *
   * 3D: o estoque é fungível por galpão+loc — quem chama o algoritmo pode
   * ordenar livremente (picking primeiro, mais saldo, etc.).
   */
  buscarLinha: (q: {
    produto_id: string;
    galpao_id: string;
    qty: number;
  }) => Promise<LinhaCandidata | null>;
}

/**
 * Distância geo-priority do `galpao` em relação a um conjunto de "homes"
 * (preferenciais da empresa vendedora). Retorna o MENOR (mais próximo).
 *
 *   0 — galpao está entre os preferenciais (ou empresa sem preferenciais)
 *   1 — mesma cidade + UF de algum preferencial
 *   2 — mesma UF de algum preferencial
 *   3 — outro
 *
 * Quando `homes` está vazio (empresa sem preferenciais), todos os galpões
 * empatam em 0 — i.e. roteamento sem viés geográfico, decisão por cobertura.
 */
export function geoPriority(
  galpao: GalpaoLite,
  homes: GalpaoLite | GalpaoLite[],
): number {
  const lista = Array.isArray(homes) ? homes : [homes];
  if (lista.length === 0) return 0;

  let best = 3;
  for (const home of lista) {
    if (galpao.id === home.id) return 0;
    if (
      galpao.cidade &&
      galpao.cidade === home.cidade &&
      galpao.estado === home.estado
    ) {
      best = Math.min(best, 1);
    } else if (galpao.estado && galpao.estado === home.estado) {
      best = Math.min(best, 2);
    }
  }
  return best;
}

/**
 * Algoritmo de roteamento — pool fungível por galpão.
 *
 * 1. Pra cada galpão, tenta cobrir todos os itens (qty completa por item).
 * 2. Filtra galpões que cobrem 100%.
 * 3. Ordena por geo-priority em relação aos preferenciais da vendedora.
 * 4. Galpão escolhido:
 *    - Se é home da vendedora (prioridade 0): decisao='propria'.
 *    - Se não é home mas cobre tudo: decisao='transferencia'.
 *    - Se nenhum cobre tudo + algum tem cobertura parcial: oc('split_galpoes').
 *    - Senão: oc('sem_cobertura').
 */
export async function rotearPedido(ctx: RotearContext): Promise<RotaResult> {
  const homes: GalpaoLite[] = (ctx.vendedora.galpoes_preferenciais ?? [])
    .map((id) => ctx.galpoes.find((g) => g.id === id))
    .filter((g): g is GalpaoLite => g != null);
  const homeIds = new Set(homes.map((g) => g.id));

  type Candidato = { galpao: GalpaoLite; rotas: RotaItem[] };
  const candidatos: Candidato[] = [];

  for (const galpao of ctx.galpoes) {
    const rotas: RotaItem[] = [];
    let cobreTudo = true;

    for (const item of ctx.itens) {
      // Pool fungível: pede a qty inteira, qualquer dona. buscarLinha
      // decide locs/ordem internamente. Sem fallback por tier de empresa.
      const linha = await ctx.buscarLinha({
        produto_id: item.produto_id,
        galpao_id: galpao.id,
        qty: item.qty,
      });
      if (!linha || linha.disponivel < item.qty) {
        cobreTudo = false;
        break;
      }
      rotas.push({
        produto_id: item.produto_id,
        qty: item.qty,
        galpao_id: galpao.id,
        localizacao_id: linha.localizacao_id,
        tipo: homeIds.has(galpao.id) || homeIds.size === 0 ? "propria" : "transferencia",
      });
    }

    if (cobreTudo) candidatos.push({ galpao, rotas });
  }

  if (candidatos.length === 0) {
    // Sem candidato 100%. Determina se foi split (alguém cobria algo) ou
    // ausência total (ninguém cobria nada — vai pra OC).
    let algumaCobertura = false;
    outer: for (const g of ctx.galpoes) {
      for (const item of ctx.itens) {
        const linha = await ctx.buscarLinha({
          produto_id: item.produto_id,
          galpao_id: g.id,
          qty: 1,
        });
        if (linha && linha.disponivel > 0) {
          algumaCobertura = true;
          break outer;
        }
      }
    }
    return {
      decisao: "oc",
      motivo: algumaCobertura ? "split_galpoes" : "sem_cobertura",
    };
  }

  // Galpão home preferido. Empate (sem home OU múltiplos homes empatados):
  // mantém ordem da lista de galpões — `galpoes` deve vir ordenada pelo caller.
  candidatos.sort(
    (a, b) => geoPriority(a.galpao, homes) - geoPriority(b.galpao, homes),
  );
  const escolhido = candidatos[0];
  const dist = geoPriority(escolhido.galpao, homes);
  const decisao: "propria" | "transferencia" =
    dist === 0 ? "propria" : "transferencia";
  return {
    decisao,
    rotas: escolhido.rotas,
    galpao_id: escolhido.galpao.id,
  };
}

interface EstoqueRow {
  id: string;
  localizacao_id: string;
  disponivel: number;
  localizacao?: { tipo?: string };
}

/**
 * Wrapper de produção: monta contexto a partir do banco e chama rotearPedido.
 * Filtra localizações com lock ativo, prefere tipo='picking', desempata por
 * maior saldo disponível.
 */
export async function rotearPedidoDoBanco(
  empresaVendedoraId: string,
  itens: ItemPedido[],
): Promise<RotaResult> {
  const sb = createServiceClient();

  const { data: vendedora } = await sb
    .from("siso_empresas")
    .select("id")
    .eq("id", empresaVendedoraId)
    .single();
  if (!vendedora) return { decisao: "oc", motivo: "sem_cobertura" };

  // Galpões preferenciais (N:N) — vazio = sem preferência geográfica.
  const { data: prefRows } = await sb
    .from("siso_empresa_galpoes_preferenciais")
    .select("galpao_id")
    .eq("empresa_id", empresaVendedoraId);
  const galpoesPreferenciais = (prefRows ?? []).map(
    (r) => (r as { galpao_id: string }).galpao_id,
  );

  const { data: galpoes } = await sb
    .from("siso_galpoes")
    .select("id, cidade, estado")
    .eq("ativo", true);

  return rotearPedido({
    vendedora: {
      id: empresaVendedoraId,
      galpoes_preferenciais: galpoesPreferenciais,
    },
    galpoes: (galpoes ?? []) as GalpaoLite[],
    itens,
    buscarLinha: async (q) => {
      // 3D: pool fungível por galpão. Sem filtro por dona. Busca todas as
      // linhas com disponivel >= qty, filtra locs bloqueadas, prioriza
      // picking, depois maior saldo.
      // CST-01: só locs VENDÁVEIS (picking/overstock) contam pra cobertura —
      // recebimento/quarentena/packing/expedicao ficam fora (join !inner).
      const { data } = await sb
        .from("siso_estoque")
        .select(
          "id, localizacao_id, disponivel, localizacao:siso_localizacoes!inner(tipo)",
        )
        .match({
          produto_id: q.produto_id,
          galpao_id: q.galpao_id,
        })
        .in("localizacao.tipo", [...TIPOS_LOC_VENDAVEIS])
        .gte("disponivel", q.qty)
        .order("disponivel", { ascending: false })
        .limit(20);
      if (!data || data.length === 0) return null;

      const locsBloqueadas = await sb
        .from("siso_localizacao_locks")
        .select("localizacao_id")
        .is("finalizado_em", null);
      const blocked = new Set(
        (locsBloqueadas.data ?? []).map(
          (l) => (l as { localizacao_id: string }).localizacao_id,
        ),
      );
      const livres = (data as unknown as EstoqueRow[]).filter(
        (d) => !blocked.has(d.localizacao_id),
      );
      const sorted = livres.sort((a, b) => {
        const ap = a.localizacao?.tipo === "picking" ? 0 : 1;
        const bp = b.localizacao?.tipo === "picking" ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return Number(b.disponivel) - Number(a.disponivel);
      });
      return sorted[0]
        ? {
            id: sorted[0].id,
            localizacao_id: sorted[0].localizacao_id,
            disponivel: Number(sorted[0].disponivel),
          }
        : null;
    },
  });
}
