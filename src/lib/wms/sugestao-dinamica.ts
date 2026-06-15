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

interface ReservaRow {
  pedido_id: string;
  produto_id: string;
  galpao_id: string;
  tipo: string;
  quantidade: number | string;
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
 * Custo: 6 queries fixas independente do número de pedidos:
 *   1. SELECT produtos por SKU
 *   2. SELECT galpões ativos
 *   3. SELECT preferenciais das empresas envolvidas
 *   4. SELECT siso_estoque dos produtos envolvidos (com tipo da loc)
 *   5. SELECT locs com lock ativo
 *   6. SELECT reservas próprias dos pedidos (movs R/L do ledger)
 *
 * `siso_estoque.disponivel` já é GENERATED (saldo - reservado), então
 * reservas R do ledger são naturalmente respeitadas — dois pedidos do
 * mesmo SKU não conseguem ambos virar "propria" sem que o primeiro
 * libere/cancele a reserva.
 *
 * PORÉM a reserva do PRÓPRIO pedido (R reserva_pedido/reserva_troca criada
 * no webhook) também desconta de `disponivel`. Sem corrigir, o pedido
 * computa a própria reserva como indisponível e uma transferência legítima
 * vira "oc" espúrio (e some da lista de aprovação, que filtra por sugestão
 * viva). Por isso somamos de volta a reserva ATIVA do próprio pedido (net
 * R−L por produto+galpão) ao avaliar a cobertura DELE.
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
  const pedidoIds = [...new Set(pedidos.map((p) => p.pedidoId))];

  const [produtosRes, galpoesRes, prefRes, locksRes, reservasRes] = await Promise.all([
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
    // Reservas próprias dos pedidos sendo recomputados: net R−L por
    // (pedido, produto, galpão). Somadas de volta ao disponivel pra que o
    // pedido não compute a própria reserva como indisponível (ver docstring).
    pedidoIds.length > 0
      ? sb
          .from("siso_movimentacoes")
          .select("pedido_id, produto_id, galpao_id, tipo, quantidade")
          .in("pedido_id", pedidoIds)
          .in("tipo", ["R", "L"])
      : Promise.resolve({ data: [] as ReservaRow[] }),
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

  // Reserva ATIVA do próprio pedido por chave `pedido::produto::galpão`
  // (net R−L do ledger). Somada de volta ao `disponivel` em buscarLinha.
  const reservaPropriaPorChave = new Map<string, number>();
  for (const r of (reservasRes.data ?? []) as ReservaRow[]) {
    const k = `${r.pedido_id}::${r.produto_id}::${r.galpao_id}`;
    const delta = r.tipo === "R" ? toNum(r.quantidade) : -toNum(r.quantidade);
    reservaPropriaPorChave.set(k, (reservaPropriaPorChave.get(k) ?? 0) + delta);
  }

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
        // Soma de volta a reserva ativa DESTE pedido nessa (produto, galpão):
        // ela já desconta de siso_estoque.disponivel, então sem isso o pedido
        // veria a própria reserva como indisponível (transferência → oc espúrio).
        const ownRes = Math.max(
          0,
          reservaPropriaPorChave.get(
            `${pedido.pedidoId}::${q.produto_id}::${q.galpao_id}`,
          ) ?? 0,
        );
        const cobre = candidatos.find((c) => c.disponivel + ownRes >= q.qty);
        return cobre
          ? {
              id: cobre.id,
              localizacao_id: cobre.localizacao_id,
              disponivel: cobre.disponivel + ownRes,
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
