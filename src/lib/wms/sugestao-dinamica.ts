import type { SupabaseClient } from "@supabase/supabase-js";
import { rotearPedido, TIPOS_LOC_VENDAVEIS, type GalpaoLite } from "./roteamento";

export type Sugestao = "propria" | "transferencia" | "oc";

export interface PedidoInput {
  pedidoId: string;
  empresaOrigemId: string;
  itens: Array<{ sku: string; quantidade: number }>;
}

export interface SugestaoRecomputada {
  sugestao: Sugestao;
  motivo: string;
  galpaoId: string | null;
}

interface ProdutoRow {
  id: string;
  sku: string;
}

interface GalpaoRow {
  id: string;
  nome: string;
  cidade: string | null;
  estado: string | null;
}

interface PrefRow {
  empresa_id: string;
  galpao_id: string;
}

interface EstoqueRowRaw {
  id: string;
  produto_id: string;
  galpao_id: string;
  localizacao_id: string;
  disponivel: number | string | null;
  siso_localizacoes: { tipo: string | null } | null;
}

interface EstoqueLinhaIndex {
  id: string;
  localizacao_id: string;
  disponivel: number;
  tipo: string | null;
}

interface LockRow {
  localizacao_id: string;
}

const toNum = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v) || 0;
};

/**
 * Recomputa sugestão de N pedidos pendentes em batch usando o estado
 * atual de `siso_estoque`. Reusa `rotearPedido` (mesma função pura que
 * o webhook usa), garantindo consistência de comportamento.
 *
 * Custo: 5 queries fixas independente do número de pedidos:
 *   1. SELECT produtos por SKU
 *   2. SELECT galpões ativos
 *   3. SELECT preferenciais das empresas envolvidas
 *   4. SELECT siso_estoque dos produtos envolvidos (com tipo da loc)
 *   5. SELECT locs com lock ativo
 *
 * `siso_estoque.disponivel` já é GENERATED (saldo - reservado), então
 * reservas R do ledger são naturalmente respeitadas — dois pedidos do
 * mesmo SKU não conseguem ambos virar "propria" sem que o primeiro
 * libere/cancele a reserva.
 */
export async function recomputarSugestaoBatch(
  sb: SupabaseClient,
  pedidos: PedidoInput[],
): Promise<Map<string, SugestaoRecomputada>> {
  const out = new Map<string, SugestaoRecomputada>();
  if (pedidos.length === 0) return out;

  const todosSkus = [
    ...new Set(
      pedidos.flatMap((p) => p.itens.map((i) => i.sku)).filter((s): s is string => !!s),
    ),
  ];
  const empresaIds = [...new Set(pedidos.map((p) => p.empresaOrigemId))];

  const [produtosRes, galpoesRes, prefRes, locksRes] = await Promise.all([
    todosSkus.length > 0
      ? sb.from("siso_produtos").select("id, sku").in("sku", todosSkus)
      : Promise.resolve({ data: [] as ProdutoRow[] }),
    sb.from("siso_galpoes").select("id, nome, cidade, estado").eq("ativo", true),
    empresaIds.length > 0
      ? sb
          .from("siso_empresa_galpoes_preferenciais")
          .select("empresa_id, galpao_id")
          .in("empresa_id", empresaIds)
      : Promise.resolve({ data: [] as PrefRow[] }),
    sb.from("siso_localizacao_locks").select("localizacao_id").is("finalizado_em", null),
  ]);

  const skuToProdutoId = new Map<string, string>(
    ((produtosRes.data ?? []) as ProdutoRow[]).map((p) => [p.sku, p.id]),
  );

  const galpoesRows = (galpoesRes.data ?? []) as GalpaoRow[];
  const galpoes: GalpaoLite[] = galpoesRows.map((g) => ({
    id: g.id,
    cidade: g.cidade,
    estado: g.estado,
  }));

  const prefsByEmpresa = new Map<string, string[]>();
  for (const r of (prefRes.data ?? []) as PrefRow[]) {
    const arr = prefsByEmpresa.get(r.empresa_id) ?? [];
    arr.push(r.galpao_id);
    prefsByEmpresa.set(r.empresa_id, arr);
  }

  const locsBloqueadas = new Set(
    ((locksRes.data ?? []) as LockRow[]).map((l) => l.localizacao_id),
  );

  const todosProdutoIds = [...new Set(skuToProdutoId.values())];
  const { data: estoqueRows } =
    todosProdutoIds.length === 0
      ? { data: [] as EstoqueRowRaw[] }
      : await sb
          .from("siso_estoque")
          .select(
            "id, produto_id, galpao_id, localizacao_id, disponivel, " +
              "siso_localizacoes!inner(tipo)",
          )
          .in("produto_id", todosProdutoIds)
          // CST-01: só locs vendáveis contam pra cobertura (mesma regra do
          // rotearPedidoDoBanco — senão a sugestão diverge do roteamento real).
          .in("siso_localizacoes.tipo", [...TIPOS_LOC_VENDAVEIS]);

  const estoquePorChave = new Map<string, EstoqueLinhaIndex[]>();
  for (const r of (estoqueRows ?? []) as unknown as EstoqueRowRaw[]) {
    if (locsBloqueadas.has(r.localizacao_id)) continue;
    const key = `${r.produto_id}::${r.galpao_id}`;
    const arr = estoquePorChave.get(key) ?? [];
    arr.push({
      id: r.id,
      localizacao_id: r.localizacao_id,
      disponivel: toNum(r.disponivel),
      tipo: r.siso_localizacoes?.tipo ?? null,
    });
    estoquePorChave.set(key, arr);
  }
  for (const arr of estoquePorChave.values()) {
    arr.sort((a, b) => {
      const ap = a.tipo === "picking" ? 0 : 1;
      const bp = b.tipo === "picking" ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return b.disponivel - a.disponivel;
    });
  }

  const galpaoNomeById = new Map(galpoesRows.map((g) => [g.id, g.nome]));

  for (const pedido of pedidos) {
    const itensRotear: Array<{ produto_id: string; qty: number }> = [];
    let temSkuNaoMapeado = false;
    for (const it of pedido.itens) {
      const produtoId = skuToProdutoId.get(it.sku);
      if (!produtoId) {
        temSkuNaoMapeado = true;
        break;
      }
      itensRotear.push({ produto_id: produtoId, qty: it.quantidade });
    }

    if (temSkuNaoMapeado || itensRotear.length === 0) {
      out.set(pedido.pedidoId, {
        sugestao: "oc",
        motivo: "Item sem mapeamento WMS — vai pra OC",
        galpaoId: null,
      });
      continue;
    }

    const galpoesPreferenciais = prefsByEmpresa.get(pedido.empresaOrigemId) ?? [];
    const rota = await rotearPedido({
      vendedora: {
        id: pedido.empresaOrigemId,
        galpoes_preferenciais: galpoesPreferenciais,
      },
      galpoes,
      itens: itensRotear,
      buscarLinha: async (q) => {
        const key = `${q.produto_id}::${q.galpao_id}`;
        const candidatos = estoquePorChave.get(key) ?? [];
        const cobre = candidatos.find((c) => c.disponivel >= q.qty);
        return cobre
          ? {
              id: cobre.id,
              localizacao_id: cobre.localizacao_id,
              disponivel: cobre.disponivel,
            }
          : null;
      },
    });

    if (rota.decisao === "oc") {
      out.set(pedido.pedidoId, {
        sugestao: "oc",
        motivo:
          rota.motivo === "split_galpoes"
            ? "Itens em galpões diferentes — vai pra OC"
            : "Sem cobertura de estoque — vai pra OC",
        galpaoId: null,
      });
    } else {
      const nome = galpaoNomeById.get(rota.galpao_id) ?? "galpão";
      const motivo =
        rota.decisao === "propria"
          ? `${nome} tem estoque de todos os itens`
          : `Outro galpão (${nome}) tem cobertura — transferência`;
      out.set(pedido.pedidoId, {
        sugestao: rota.decisao,
        motivo,
        galpaoId: rota.galpao_id,
      });
    }
  }

  return out;
}
