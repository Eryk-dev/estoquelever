import { createServiceClient } from "@/lib/supabase-server";
import type { PerspectivaEstoque } from "./types";

interface EstoqueRow {
  id: string;
  saldo: number;
  reservado: number;
  disponivel: number;
  atualizado_em: string;
  produto: { id: string; sku: string; descricao: string; imagem_url: string | null; imagens: string[] };
  galpao: { id: string; nome: string; cidade: string | null; estado: string | null };
  localizacao: { id: string; codigo: string; tipo: string };
}

export interface AgregadoSaldo {
  chave: string;
  nome: string;
  saldo: number;
  reservado: number;
  disponivel: number;
  custo_medio: number;
  itens: EstoqueRow[];
}

export async function saldosPorPerspectiva(
  view: PerspectivaEstoque,
  filtro?: { produto_id?: string; galpao_id?: string },
): Promise<AgregadoSaldo[]> {
  const sb = createServiceClient();
  let q = sb
    .from("siso_estoque")
    .select(
      `
        id, saldo, reservado, disponivel, atualizado_em,
        produto:siso_produtos(id, sku, descricao, imagem_url, imagens),
        galpao:siso_galpoes(id, nome, cidade, estado),
        localizacao:siso_localizacoes(id, codigo, tipo)
      `,
    )
    .gt("saldo", 0);

  if (filtro?.produto_id) q = q.eq("produto_id", filtro.produto_id);
  if (filtro?.galpao_id) q = q.eq("galpao_id", filtro.galpao_id);

  const { data, error } = await q.limit(500);
  if (error) throw error;

  const rows = (data ?? []) as unknown as EstoqueRow[];
  // 3D: custo médio é global por SKU. Carrega o lote dos produtos em jogo
  // pra anexar ao agregado.
  const produtoIds = Array.from(new Set(rows.map((r) => r.produto.id)));
  const custoMap = new Map<string, number>();
  if (produtoIds.length > 0) {
    const { data: custos } = await sb
      .from("siso_custo_medio")
      .select("produto_id, custo_medio")
      .in("produto_id", produtoIds);
    for (const c of custos ?? []) {
      custoMap.set(c.produto_id, Number(c.custo_medio));
    }
  }

  return agruparPor(rows, view, custoMap);
}

function agruparPor(
  rows: EstoqueRow[],
  view: PerspectivaEstoque,
  custoMap: Map<string, number>,
): AgregadoSaldo[] {
  const map = new Map<string, AgregadoSaldo>();
  for (const r of rows) {
    const key =
      view === "galpao"
        ? r.galpao.id
        : view === "localizacao"
          ? r.localizacao.id
          : r.produto.id;
    const nome =
      view === "galpao"
        ? r.galpao.nome
        : view === "localizacao"
          ? r.localizacao.codigo
          : `${r.produto.sku} — ${r.produto.descricao}`;
    const existing = map.get(key) ?? {
      chave: key,
      nome,
      saldo: 0,
      reservado: 0,
      disponivel: 0,
      // Em view=produto, custo é único por agregado. Nas demais views
      // (galpao/localizacao) o "custo médio" do agregado fica indefinido
      // já que mistura SKUs — mantemos 0 e o frontend não usa.
      custo_medio:
        view === "produto" ? (custoMap.get(r.produto.id) ?? 0) : 0,
      itens: [],
    };
    existing.saldo += Number(r.saldo);
    existing.reservado += Number(r.reservado);
    existing.disponivel += Number(r.disponivel);
    existing.itens.push(r);
    map.set(key, existing);
  }
  return Array.from(map.values()).sort((a, b) => b.saldo - a.saldo);
}
