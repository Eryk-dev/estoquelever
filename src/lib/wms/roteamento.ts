import { createServiceClient } from "@/lib/supabase-server";

export interface GalpaoLite {
  id: string;
  cidade: string | null;
  estado: string | null;
}
export interface EmpresaLite {
  id: string;
  /**
   * Galpões preferenciais (geo-priority=0 no roteamento). 0..N.
   * - Vazio: todos os galpões empatam (a empresa não tem preferência geográfica).
   * - 1 ou mais: cada um vira "home" — o roteador prefere candidatos nesses
   *   galpões; outros caem em cidade/UF/outro conforme distância geográfica
   *   ao MAIS PRÓXIMO dos preferenciais.
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
  empresa_dona_id: string;
  galpao_id: string;
  localizacao_id: string;
  tipo: "propria" | "emprestimo" | "swap";
  /**
   * Detalhes do swap quando tipo='swap'. A "vendedora" recebe a quadrupla
   * (empresa_dona_id, galpao_id, localizacao_id) após swap, e o "par" recebe
   * a quadrupla do espelho (mesmo produto, mesmo qty) no swap.galpao_par.
   */
  swap?: {
    empresa_par_id: string;
    galpao_par_id: string;
    localizacao_par_id: string;
  };
}
export type RotaResult =
  | { decisao: "propria" | "emprestimo"; rotas: RotaItem[]; galpao_id: string }
  | { decisao: "oc"; motivo: "sem_cobertura" | "split_galpoes" };

export interface RotearContext {
  vendedora: EmpresaLite;
  galpoes: GalpaoLite[];
  credoras: string[];
  /**
   * Empresas com regra de swap ATIVA com a vendedora (par bidirecional).
   * Usadas pra tentar swap antes de empréstimo. Pode incluir empresas que
   * NÃO estão em `credoras` (regras swap-only com permite_emprestimo=false).
   */
  swapPartners?: string[];
  itens: ItemPedido[];
  buscarLinha: (q: {
    produto_id: string;
    empresa_dona_id: string;
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
 * Algoritmo de roteamento por galpão único:
 * 1. Pra cada galpão, tenta cobrir todos os itens (próprio primeiro, depois empréstimo)
 * 2. Filtra galpões que cobrem 100%
 * 3. Ordena candidatos por geo-priority em relação ao home da vendedora
 * 4. Escolhe o melhor; se nenhum cobre tudo, OC com motivo
 */
export async function rotearPedido(ctx: RotearContext): Promise<RotaResult> {
  // Resolve preferenciais → GalpaoLite[]. Empresa sem preferenciais → array
  // vazio, geoPriority retorna 0 pra qualquer galpão (decisão por cobertura).
  const homes: GalpaoLite[] = (ctx.vendedora.galpoes_preferenciais ?? [])
    .map((id) => ctx.galpoes.find((g) => g.id === id))
    .filter((g): g is GalpaoLite => g != null);

  type Candidato = { galpao: GalpaoLite; rotas: RotaItem[]; tudoProprio: boolean };
  const candidatos: Candidato[] = [];

  for (const galpao of ctx.galpoes) {
    const rotas: RotaItem[] = [];
    let cobreTudo = true;
    let tudoProprio = true;

    for (const item of ctx.itens) {
      let qtyRestante = item.qty;

      // ─── 1. Próprio: pega o que estiver disponível no galpão ─────────────
      // buscarLinha(qty=1) retorna linha com `disponivel` real; tomamos min.
      const proprio = await ctx.buscarLinha({
        produto_id: item.produto_id,
        empresa_dona_id: ctx.vendedora.id,
        galpao_id: galpao.id,
        qty: 1,
      });
      if (proprio && proprio.disponivel > 0) {
        const qtyTomada = Math.min(qtyRestante, proprio.disponivel);
        rotas.push({
          produto_id: item.produto_id,
          qty: qtyTomada,
          empresa_dona_id: ctx.vendedora.id,
          galpao_id: galpao.id,
          localizacao_id: proprio.localizacao_id,
          tipo: "propria",
        });
        qtyRestante -= qtyTomada;
      }

      // ─── 2. Swap parcial com cada partner em ordem ───────────────────────
      // Toma min(qtyRestante, partner_disp_no_galpao, V_disp_no_espelho).
      // Espelho preferido por geo-priority em relação ao partner.
      if (qtyRestante > 0) {
        for (const partnerId of ctx.swapPartners ?? []) {
          if (qtyRestante <= 0) break;
          const linhaPartner = await ctx.buscarLinha({
            produto_id: item.produto_id,
            empresa_dona_id: partnerId,
            galpao_id: galpao.id,
            qty: 1,
          });
          if (!linhaPartner || linhaPartner.disponivel <= 0) continue;

          const espelhosOrdenados = ctx.galpoes
            .filter((g) => g.id !== galpao.id)
            .sort((a, b) => geoPriority(a, galpao) - geoPriority(b, galpao));
          let escolhido: { galpaoEspelho: GalpaoLite; linhaEspelho: LinhaCandidata } | null = null;
          for (const espelho of espelhosOrdenados) {
            const linhaEspelho = await ctx.buscarLinha({
              produto_id: item.produto_id,
              empresa_dona_id: ctx.vendedora.id,
              galpao_id: espelho.id,
              qty: 1,
            });
            if (linhaEspelho && linhaEspelho.disponivel > 0) {
              escolhido = { galpaoEspelho: espelho, linhaEspelho };
              break;
            }
          }
          if (!escolhido) continue;

          const qtyTomada = Math.min(
            qtyRestante,
            linhaPartner.disponivel,
            escolhido.linhaEspelho.disponivel,
          );
          rotas.push({
            produto_id: item.produto_id,
            qty: qtyTomada,
            empresa_dona_id: ctx.vendedora.id,
            galpao_id: galpao.id,
            localizacao_id: linhaPartner.localizacao_id,
            tipo: "swap",
            swap: {
              empresa_par_id: partnerId,
              galpao_par_id: escolhido.galpaoEspelho.id,
              localizacao_par_id: escolhido.linhaEspelho.localizacao_id,
            },
          });
          qtyRestante -= qtyTomada;
        }
      }

      // ─── 3. Empréstimo parcial com cada credora em ordem ─────────────────
      if (qtyRestante > 0) {
        for (const credoraId of ctx.credoras) {
          if (qtyRestante <= 0) break;
          const linha = await ctx.buscarLinha({
            produto_id: item.produto_id,
            empresa_dona_id: credoraId,
            galpao_id: galpao.id,
            qty: 1,
          });
          if (!linha || linha.disponivel <= 0) continue;
          const qtyTomada = Math.min(qtyRestante, linha.disponivel);
          rotas.push({
            produto_id: item.produto_id,
            qty: qtyTomada,
            empresa_dona_id: credoraId,
            galpao_id: galpao.id,
            localizacao_id: linha.localizacao_id,
            tipo: "emprestimo",
          });
          qtyRestante -= qtyTomada;
          tudoProprio = false;
        }
      }

      if (qtyRestante > 0) {
        cobreTudo = false;
        break;
      }
    }

    if (cobreTudo) candidatos.push({ galpao, rotas, tudoProprio });
  }

  if (candidatos.length === 0) {
    let algumaCobertura = false;
    outer: for (const g of ctx.galpoes) {
      for (const item of ctx.itens) {
        const linha = await ctx.buscarLinha({
          produto_id: item.produto_id,
          empresa_dona_id: ctx.vendedora.id,
          galpao_id: g.id,
          qty: item.qty,
        });
        if (linha) {
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

  candidatos.sort(
    (a, b) => geoPriority(a.galpao, homes) - geoPriority(b.galpao, homes),
  );
  const escolhido = candidatos[0];
  return {
    decisao: escolhido.tudoProprio ? "propria" : "emprestimo",
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
 * Filtra localizações com lock ativo, prefere localizações tipo='picking'.
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

  // Carrega galpões preferenciais (N:N) — empresa pode ter 0..N. Vazio = sem
  // preferência geográfica (roteamento decide por cobertura).
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

  // Empréstimo: vendedora é devedora, credora "empresta" estoque dela.
  // Filtra apenas regras com permite_emprestimo=true.
  const { data: regrasEmprestimo } = await sb
    .from("siso_emprestimo_regras")
    .select("empresa_credora_id, limites_por_produto")
    .eq("empresa_devedora_id", empresaVendedoraId)
    .eq("ativo", true)
    .eq("permite_emprestimo", true);

  const limitePorCredoraProduto = new Map<string, Map<string, number>>();
  for (const r of (regrasEmprestimo ?? []) as Array<{
    empresa_credora_id: string;
    limites_por_produto: Record<string, number>;
  }>) {
    const lim = new Map<string, number>();
    for (const [pid, qty] of Object.entries(r.limites_por_produto ?? {})) {
      lim.set(pid, Number(qty));
    }
    limitePorCredoraProduto.set(r.empresa_credora_id, lim);
  }

  const credoras = (regrasEmprestimo ?? []).map(
    (r) => (r as { empresa_credora_id: string }).empresa_credora_id,
  );

  // ─── Plano 4: parceiros de swap (bidirecional) ────────────────────────────
  // Swap é simétrico: se A↔B é permitido, qualquer um pode iniciar. Carrega
  // regras com permite_swap=true onde a vendedora aparece em qualquer lado.
  const { data: regrasSwap } = await sb
    .from("siso_emprestimo_regras")
    .select("empresa_credora_id, empresa_devedora_id, limites_por_produto")
    .or(
      `empresa_credora_id.eq.${empresaVendedoraId},empresa_devedora_id.eq.${empresaVendedoraId}`,
    )
    .eq("ativo", true)
    .eq("permite_swap", true);

  const limitePorPartnerProduto = new Map<string, Map<string, number>>();
  const swapPartners = new Set<string>();
  for (const r of (regrasSwap ?? []) as Array<{
    empresa_credora_id: string;
    empresa_devedora_id: string;
    limites_por_produto: Record<string, number>;
  }>) {
    const partnerId =
      r.empresa_credora_id === empresaVendedoraId
        ? r.empresa_devedora_id
        : r.empresa_credora_id;
    swapPartners.add(partnerId);
    const lim = limitePorPartnerProduto.get(partnerId) ?? new Map();
    for (const [pid, qty] of Object.entries(r.limites_por_produto ?? {})) {
      // Em swap o limite é compartilhado entre os dois sentidos — usa o maior
      // entre o já registrado e o atual (regras simétricas tendem a ter mesmo limite)
      lim.set(pid, Math.max(lim.get(pid) ?? 0, Number(qty)));
    }
    limitePorPartnerProduto.set(partnerId, lim);
  }

  return rotearPedido({
    vendedora: {
      id: empresaVendedoraId,
      galpoes_preferenciais: galpoesPreferenciais,
    },
    galpoes: (galpoes ?? []) as GalpaoLite[],
    credoras,
    swapPartners: Array.from(swapPartners),
    itens,
    buscarLinha: async (q) => {
      // Aplicar limite por produto se a dona é credora (não vendedora).
      // Empréstimo unidirecional usa limitePorCredoraProduto; swap usa
      // limitePorPartnerProduto (regras com permite_swap=true).
      if (q.empresa_dona_id !== empresaVendedoraId) {
        const limCred = limitePorCredoraProduto.get(q.empresa_dona_id)?.get(q.produto_id);
        const limSwap = limitePorPartnerProduto.get(q.empresa_dona_id)?.get(q.produto_id);
        const lim = limCred ?? limSwap;
        if (lim !== undefined && q.qty > lim) return null;
      }
      const { data } = await sb
        .from("siso_estoque")
        .select(
          "id, localizacao_id, disponivel, localizacao:siso_localizacoes(tipo)",
        )
        .match({
          produto_id: q.produto_id,
          empresa_dona_id: q.empresa_dona_id,
          galpao_id: q.galpao_id,
        })
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
        return ap - bp;
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
