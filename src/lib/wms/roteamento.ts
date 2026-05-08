import { createServiceClient } from "@/lib/supabase-server";

export interface GalpaoLite {
  id: string;
  cidade: string | null;
  estado: string | null;
}
export interface EmpresaLite {
  id: string;
  galpao_id: string;
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
  tipo: "propria" | "emprestimo";
}
export type RotaResult =
  | { decisao: "propria" | "emprestimo"; rotas: RotaItem[]; galpao_id: string }
  | { decisao: "oc"; motivo: "sem_cobertura" | "split_galpoes" };

export interface RotearContext {
  vendedora: EmpresaLite;
  galpoes: GalpaoLite[];
  credoras: string[];
  itens: ItemPedido[];
  buscarLinha: (q: {
    produto_id: string;
    empresa_dona_id: string;
    galpao_id: string;
    qty: number;
  }) => Promise<LinhaCandidata | null>;
}

export function geoPriority(galpao: GalpaoLite, home: GalpaoLite): number {
  if (galpao.id === home.id) return 0;
  if (galpao.cidade && galpao.cidade === home.cidade && galpao.estado === home.estado) {
    return 1;
  }
  if (galpao.estado && galpao.estado === home.estado) return 2;
  return 3;
}

/**
 * Algoritmo de roteamento por galpão único:
 * 1. Pra cada galpão, tenta cobrir todos os itens (próprio primeiro, depois empréstimo)
 * 2. Filtra galpões que cobrem 100%
 * 3. Ordena candidatos por geo-priority em relação ao home da vendedora
 * 4. Escolhe o melhor; se nenhum cobre tudo, OC com motivo
 */
export async function rotearPedido(ctx: RotearContext): Promise<RotaResult> {
  const home = ctx.galpoes.find((g) => g.id === ctx.vendedora.galpao_id);
  if (!home) return { decisao: "oc", motivo: "sem_cobertura" };

  type Candidato = { galpao: GalpaoLite; rotas: RotaItem[]; tudoProprio: boolean };
  const candidatos: Candidato[] = [];

  for (const galpao of ctx.galpoes) {
    const rotas: RotaItem[] = [];
    let cobreTudo = true;
    let tudoProprio = true;

    for (const item of ctx.itens) {
      const proprio = await ctx.buscarLinha({
        produto_id: item.produto_id,
        empresa_dona_id: ctx.vendedora.id,
        galpao_id: galpao.id,
        qty: item.qty,
      });
      if (proprio) {
        rotas.push({
          ...item,
          empresa_dona_id: ctx.vendedora.id,
          galpao_id: galpao.id,
          localizacao_id: proprio.localizacao_id,
          tipo: "propria",
        });
        continue;
      }

      let emprestimo: { donaId: string; linha: LinhaCandidata } | null = null;
      for (const credoraId of ctx.credoras) {
        const linha = await ctx.buscarLinha({
          produto_id: item.produto_id,
          empresa_dona_id: credoraId,
          galpao_id: galpao.id,
          qty: item.qty,
        });
        if (linha) {
          emprestimo = { donaId: credoraId, linha };
          break;
        }
      }
      if (emprestimo) {
        rotas.push({
          ...item,
          empresa_dona_id: emprestimo.donaId,
          galpao_id: galpao.id,
          localizacao_id: emprestimo.linha.localizacao_id,
          tipo: "emprestimo",
        });
        tudoProprio = false;
        continue;
      }

      cobreTudo = false;
      break;
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
    (a, b) => geoPriority(a.galpao, home) - geoPriority(b.galpao, home),
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
    .select("id, galpao_id")
    .eq("id", empresaVendedoraId)
    .single();
  if (!vendedora) return { decisao: "oc", motivo: "sem_cobertura" };

  const { data: galpoes } = await sb
    .from("siso_galpoes")
    .select("id, cidade, estado")
    .eq("ativo", true);

  const { data: regras } = await sb
    .from("siso_emprestimo_regras")
    .select("empresa_credora_id, limites_por_produto")
    .eq("empresa_devedora_id", empresaVendedoraId)
    .eq("ativo", true);

  const limitePorCredoraProduto = new Map<string, Map<string, number>>();
  for (const r of (regras ?? []) as Array<{
    empresa_credora_id: string;
    limites_por_produto: Record<string, number>;
  }>) {
    const lim = new Map<string, number>();
    for (const [pid, qty] of Object.entries(r.limites_por_produto ?? {})) {
      lim.set(pid, Number(qty));
    }
    limitePorCredoraProduto.set(r.empresa_credora_id, lim);
  }

  const credoras = (regras ?? []).map(
    (r) => (r as { empresa_credora_id: string }).empresa_credora_id,
  );

  return rotearPedido({
    vendedora: vendedora as EmpresaLite,
    galpoes: (galpoes ?? []) as GalpaoLite[],
    credoras,
    itens,
    buscarLinha: async (q) => {
      // Aplicar limite por produto se a dona é credora (não vendedora)
      if (q.empresa_dona_id !== empresaVendedoraId) {
        const lim = limitePorCredoraProduto.get(q.empresa_dona_id)?.get(q.produto_id);
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
