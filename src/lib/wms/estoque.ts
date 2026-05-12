import { createServiceClient } from "@/lib/supabase-server";
import type { PerspectivaEstoque } from "./types";

interface EstoqueRow {
  id: string;
  saldo: number;
  reservado: number;
  disponivel: number;
  custo_medio: number;
  atualizado_em: string;
  produto: { id: string; sku: string; descricao: string; imagem_url: string | null };
  empresa: { id: string; nome: string };
  galpao: { id: string; nome: string; cidade: string | null; estado: string | null };
  localizacao: { id: string; codigo: string; tipo: string };
}

export interface AgregadoSaldo {
  chave: string;
  nome: string;
  saldo: number;
  reservado: number;
  disponivel: number;
  itens: EstoqueRow[];
}

export async function saldosPorPerspectiva(
  view: PerspectivaEstoque,
  filtro?: { produto_id?: string; empresa_id?: string; galpao_id?: string },
): Promise<AgregadoSaldo[]> {
  const sb = createServiceClient();
  let q = sb
    .from("siso_estoque")
    .select(
      `
        id, saldo, reservado, disponivel, custo_medio, atualizado_em,
        produto:siso_produtos(id, sku, descricao, imagem_url),
        empresa:siso_empresas(id, nome),
        galpao:siso_galpoes(id, nome, cidade, estado),
        localizacao:siso_localizacoes(id, codigo, tipo)
      `,
    )
    .gt("saldo", 0);

  if (filtro?.produto_id) q = q.eq("produto_id", filtro.produto_id);
  if (filtro?.empresa_id) q = q.eq("empresa_dona_id", filtro.empresa_id);
  if (filtro?.galpao_id) q = q.eq("galpao_id", filtro.galpao_id);

  const { data, error } = await q.limit(500);
  if (error) throw error;

  return agruparPor((data ?? []) as unknown as EstoqueRow[], view);
}

function agruparPor(rows: EstoqueRow[], view: PerspectivaEstoque): AgregadoSaldo[] {
  const map = new Map<string, AgregadoSaldo>();
  for (const r of rows) {
    const key =
      view === "dono"
        ? r.empresa.id
        : view === "galpao"
          ? r.galpao.id
          : view === "localizacao"
            ? r.localizacao.id
            : r.produto.id;
    const nome =
      view === "dono"
        ? r.empresa.nome
        : view === "galpao"
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
