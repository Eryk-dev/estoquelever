/**
 * Helpers PUROS da tela de compras item-cêntrica (Fase 1, 2026-06-18).
 *
 * A API de compras ainda devolve os itens agrupados por fornecedor; a tela é
 * item-cêntrica (1 linha por SKU). Estas funções fazem a ponte sem efeito
 * colateral, então são testáveis isoladas.
 */

export interface PedidoVincLike {
  pedido_id: string;
  item_id: string;
  galpao_id: string | null;
  galpao_nome: string | null;
  aging_dias: number;
}

export interface ComprarItemLike {
  sku: string;
  quantidade_necessaria: number;
  aging_dias: number;
  pedidos: PedidoVincLike[];
}

/**
 * Achata os grupos por fornecedor numa lista plana de 1 linha por SKU. O mesmo
 * SKU em fornecedores diferentes (itens com `fornecedor_oc` distinto) vira UMA
 * linha: `quantidade_necessaria` é o número líquido GLOBAL por SKU (idêntico em
 * cada grupo — NÃO somar), os pedidos são unidos (dedupe por item_id) e o aging
 * fica o maior. Ordena por aging desc (mais antigo primeiro).
 */
export function flattenItensPorSku<I extends ComprarItemLike>(
  grupos: { itens: I[] }[],
): I[] {
  const bySku = new Map<string, I>();
  for (const g of grupos) {
    for (const it of g.itens) {
      const prev = bySku.get(it.sku);
      if (!prev) {
        bySku.set(it.sku, { ...it, pedidos: [...it.pedidos] });
        continue;
      }
      const vistos = new Set(prev.pedidos.map((p) => p.item_id));
      for (const p of it.pedidos) {
        if (!vistos.has(p.item_id)) {
          prev.pedidos.push(p);
          vistos.add(p.item_id);
        }
      }
      prev.aging_dias = Math.max(prev.aging_dias, it.aging_dias);
    }
  }
  return [...bySku.values()].sort((a, b) => b.aging_dias - a.aging_dias);
}

export type SortKey = "sku" | "urgencia" | "fornecedor" | "quanto";
export type SortDir = "asc" | "desc";

export interface LinhaCompra {
  sku: string;
  descricao: string;
  fornecedorNome: string;
  galpaoId: string | null;
  galpaoNome: string | null;
  /** quanto comprar (qty atual, override ou sugestão). */
  quantidade: number;
  aging_dias: number;
}

export interface FiltroOrdenacao {
  /** casa em sku, descrição ou fornecedor (case-insensitive). */
  busca?: string;
  /** filtra por nome de fornecedor exato. */
  fornecedor?: string | null;
  /** filtra por galpão (id) exato. */
  galpao?: string | null;
  sortKey?: SortKey;
  sortDir?: SortDir;
}

/**
 * Filtra (busca + fornecedor + galpão) e ordena as linhas da lista de compras.
 * Não muta a entrada. Default = urgência (aging) desc — mais antigo primeiro.
 */
export function filtrarOrdenarLinhas<L extends LinhaCompra>(
  linhas: L[],
  f: FiltroOrdenacao,
): L[] {
  const busca = (f.busca ?? "").trim().toLowerCase();
  const filtradas = linhas.filter((l) => {
    if (busca) {
      const alvo = `${l.sku} ${l.descricao} ${l.fornecedorNome}`.toLowerCase();
      if (!alvo.includes(busca)) return false;
    }
    if (f.fornecedor && l.fornecedorNome !== f.fornecedor) return false;
    if (f.galpao && l.galpaoId !== f.galpao) return false;
    return true;
  });

  const sortKey: SortKey = f.sortKey ?? "urgencia";
  const dir: SortDir = f.sortDir ?? (sortKey === "urgencia" ? "desc" : "asc");
  const mult = dir === "desc" ? -1 : 1;

  const cmpBase = (a: L, b: L): number => {
    switch (sortKey) {
      case "sku":
        return a.sku.localeCompare(b.sku, "pt-BR");
      case "fornecedor":
        return (
          a.fornecedorNome.localeCompare(b.fornecedorNome, "pt-BR") ||
          a.sku.localeCompare(b.sku, "pt-BR")
        );
      case "quanto":
        return a.quantidade - b.quantidade;
      case "urgencia":
      default:
        return a.aging_dias - b.aging_dias;
    }
  };

  return [...filtradas].sort((a, b) => cmpBase(a, b) * mult);
}

export interface CompraSelecionada {
  sku: string;
  descricao: string;
  qty: number;
  fornecedorNome: string;
  galpaoId: string;
  galpaoNome: string;
  custoUnitario: number | null;
  pedidosCobertos: { numero: string }[];
}

export interface CompraOcPreview {
  fornecedorNome: string;
  galpaoId: string;
  galpaoNome: string;
  itens: CompraSelecionada[];
  qtyTotal: number;
  /** null quando nenhum item tem custo cadastrado. */
  custoTotal: number | null;
  /** números de pedido únicos que o grupo destrava. */
  pedidosCobertos: string[];
}

/**
 * Agrupa as seleções por (fornecedor, galpão) — espelha a consolidação de OC do
 * backend (1 OC por fornecedor+galpão). Mostra ao comprador exatamente quantas
 * compras vão nascer antes de confirmar.
 */
export function agruparCompra(sel: CompraSelecionada[]): CompraOcPreview[] {
  const map = new Map<string, CompraOcPreview>();
  for (const s of sel) {
    const key = `${s.fornecedorNome}::${s.galpaoId}`;
    let g = map.get(key);
    if (!g) {
      g = {
        fornecedorNome: s.fornecedorNome,
        galpaoId: s.galpaoId,
        galpaoNome: s.galpaoNome,
        itens: [],
        qtyTotal: 0,
        custoTotal: null,
        pedidosCobertos: [],
      };
      map.set(key, g);
    }
    g.itens.push(s);
    g.qtyTotal += s.qty;
    if (s.custoUnitario != null) {
      g.custoTotal = (g.custoTotal ?? 0) + s.custoUnitario * s.qty;
    }
    for (const p of s.pedidosCobertos) {
      if (!g.pedidosCobertos.includes(p.numero)) g.pedidosCobertos.push(p.numero);
    }
  }
  return [...map.values()];
}

// ── Buckets de urgência (redesign 2026-06-19) ─────────────────────────────
// A tela agrupa as peças por severidade em vez de uma ordenação plana:
// esgotado (sem estoque) → crítico → atenção → sem pressa.

export type UrgenciaBucket = "esgotado" | "critico" | "atencao" | "ok";

export interface UrgenciaItemLike {
  /** estoque livre GLOBAL do SKU; 0 = esgotado (ruptura). */
  estoque_livre: number;
  /** status da MV de cobertura. */
  status_cobertura: "critico" | "atencao" | "ok" | "sem_giro" | "lead_time_risco";
  aging_dias: number;
}

/** Bucket do item: esgotado vence o status; lead_time_risco→atenção; sem_giro→ok. */
export function bucketDeUrgencia(it: UrgenciaItemLike): UrgenciaBucket {
  if (it.estoque_livre <= 0) return "esgotado";
  switch (it.status_cobertura) {
    case "critico":
      return "critico";
    case "atencao":
    case "lead_time_risco":
      return "atencao";
    default:
      return "ok";
  }
}

export interface BucketGrupo<L> {
  bucket: UrgenciaBucket;
  linhas: L[];
}

const ORDEM_BUCKET: UrgenciaBucket[] = ["esgotado", "critico", "atencao", "ok"];

/**
 * Agrupa as linhas nos 4 buckets de urgência (ordem fixa esgotado→ok), ordenando
 * cada bucket por aging desc (mais antigo primeiro). Buckets vazios são omitidos.
 * `extrair` projeta a linha pros campos de urgência (a lista é item-cêntrica, mas
 * a urgência mora no item subjacente). Não muta a entrada.
 */
export function agruparPorUrgencia<L>(
  linhas: L[],
  extrair: (l: L) => UrgenciaItemLike,
): BucketGrupo<L>[] {
  const map = new Map<UrgenciaBucket, L[]>();
  for (const l of linhas) {
    const b = bucketDeUrgencia(extrair(l));
    const arr = map.get(b);
    if (arr) arr.push(l);
    else map.set(b, [l]);
  }
  return ORDEM_BUCKET.filter((b) => (map.get(b)?.length ?? 0) > 0).map((b) => ({
    bucket: b,
    linhas: [...(map.get(b) ?? [])].sort(
      (a, z) => extrair(z).aging_dias - extrair(a).aging_dias,
    ),
  }));
}
