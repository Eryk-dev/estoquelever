// src/lib/wms/dashboard-tarefas.ts
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Recebe lista possivelmente com nulls/undefined e duplicatas; retorna
 * apenas IDs únicos, em ordem de primeira aparição.
 */
export function dedupNonNullIds(
  ids: Array<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export type Executor = {
  id: string;
  nome: string;
  foto_url: string | null;
};

/**
 * Hidrata uma lista de IDs com os dados do usuário, ignorando IDs que
 * não estão no map (usuário deletado ou inacessível). Preserva a ordem
 * de entrada.
 */
export function hidratarExecutores(
  ids: string[],
  usuarios: Map<string, Executor>,
): Executor[] {
  const out: Executor[] = [];
  for (const id of ids) {
    const u = usuarios.get(id);
    if (u) out.push(u);
  }
  return out;
}

/** 1 pendência de guarda renderizada como card individual no kanban. */
export type GuardaItem = {
  id: string;
  produto_sku: string;
  produto_descricao: string | null;
  qty_pendente: number;
  qty_inicial: number;
  status: "pendente" | "em_guarda";
  iniciada_por: Executor | null;
  criada_em: string;
  galpao_nome: string | null;
};

/** 1 ciclo (sessão) de inventário ativo. Renderizado com barra de progresso. */
export type CicloInventario = {
  id: string;
  nome: string;
  tipo: "cycle_count" | "completo";
  galpao_nome: string | null;
  locs_total: number;
  locs_contadas: number;
  locs_pendentes: number;
  progresso_pct: number; // 0..100
  iniciada_em: string | null;
  operadores: Executor[];
};

/** Card de compras agrupado por fornecedor. */
export type FornecedorCompras = {
  fornecedor: string;
  a_comprar: number;
  a_receber: number;
};

/** 1 devolução aguardando classificação na fila. */
export type DevolucaoPendenteCard = {
  id: string;
  nota_fiscal_id: number | null;
  empresa_referencia_nome: string | null;
  criada_em: string;
};

/** 1 transferência inter-galpão em trânsito. */
export type TransferenciaTransitoCard = {
  id: string;
  origem_galpao_nome: string | null;
  destino_galpao_nome: string | null;
  criada_em: string;
  qty_itens: number;
};

/** 1 sessão de inventário em estado `revisao` (aguardando supervisor). */
export type InventarioRevisaoCard = {
  id: string;
  nome: string;
  galpao_nome: string | null;
  total_divergencias: number;
  criado_em: string;
};

/** 1 reserva R órfã = mov tipo R + origem_tipo='reserva_pedido' onde
 *  o pedido associado está cancelado e a R nunca foi liberada (estorno_de NULL
 *  E não existe mov L com mesmo pedido_id). */
export type ReservaOrfaCard = {
  id: string;
  pedido_id: string | null;
  pedido_numero: string | null;
  produto_sku: string;
  qty: number;
  criada_em: string;
};

/** Pendência de lançamento retroativo aguardando reconciliação. */
export type RetroativoPendenteCard = {
  id: string;
  produto_sku: string;
  qty: number;
  criado_em: string;
  motivo: string;
};

/** Saldo em RECEBIMENTO sem pendência viva (após cancelamento de guarda). */
export type RecebimentoOrfaoCard = {
  produto_id: string;
  produto_sku: string;
  galpao_id: string;
  galpao_nome: string | null;
  localizacao_codigo: string;
  saldo: number;
};

export type ExcecoesPayload = {
  devolucoes: { count: number; itens: DevolucaoPendenteCard[] };
  transferencias_transito: { count: number; itens: TransferenciaTransitoCard[] };
  inventario_revisao: { count: number; itens: InventarioRevisaoCard[] };
  reservas_orfas: { count: number; itens: ReservaOrfaCard[] };
  retroativos: { count: number; itens: RetroativoPendenteCard[] };
  recebimento_orfao: { count: number; itens: RecebimentoOrfaoCard[] };
};

export type DashboardTarefasResult = {
  galpao_id: string | null;
  aprovacao: {
    count: number;
    /** Split por origem do pedido — útil pra distinguir prioridade. */
    marketplace: number;
    manual: number;
  };
  separacao: { count: number; executores: Executor[] };
  embalagem: { count: number; executores: Executor[] };
  guarda: { count: number; executores: Executor[]; itens: GuardaItem[] };
  compras: {
    aComprar: number;
    aReceber: number;
    fornecedores: FornecedorCompras[];
  };
  inventario: {
    sessoesAtivas: number;
    executores: Executor[];
    ciclos: CicloInventario[];
  };
  /** Cards novos do P5 — visibilidade de exceções operacionais. */
  excecoes: ExcecoesPayload;
};

/**
 * Limite de cards detalhados que voltam por seção. Acima disso truncamos
 * pra não estourar a home — o usuário entra na tela específica pra ver
 * o resto.
 */
const MAX_DETALHE_POR_SECAO = 50;

type FornecedorAcc = { fornecedor: string; a_comprar: number; a_receber: number };

/**
 * Agrega contagens de "a comprar" (por SKU em siso_pedido_itens) e
 * "a receber" (por ordem em siso_ordens_compra) em uma única lista
 * ordenada por total desc. Função pura — testável isolada.
 */
export function agruparFornecedoresCompras(
  itensAComprar: Array<{ fornecedor_oc: string | null }>,
  ordensAReceber: Array<{ fornecedor: string | null }>,
): FornecedorCompras[] {
  const map = new Map<string, FornecedorAcc>();
  const get = (nome: string) => {
    let acc = map.get(nome);
    if (!acc) {
      acc = { fornecedor: nome, a_comprar: 0, a_receber: 0 };
      map.set(nome, acc);
    }
    return acc;
  };
  for (const it of itensAComprar) {
    const nome = (it.fornecedor_oc ?? "").trim() || "Sem fornecedor";
    get(nome).a_comprar += 1;
  }
  for (const oc of ordensAReceber) {
    const nome = (oc.fornecedor ?? "").trim() || "Sem fornecedor";
    get(nome).a_receber += 1;
  }
  return Array.from(map.values())
    .filter((f) => f.a_comprar + f.a_receber > 0)
    .sort(
      (a, b) =>
        b.a_comprar + b.a_receber - (a.a_comprar + a.a_receber) ||
        a.fornecedor.localeCompare(b.fornecedor),
    );
}

/**
 * Monta o payload do quadro de tarefas pendentes da home /wms.
 *
 * Quando `galpao_id` é null, agrega de todos os galpões (modo "Todos").
 * Quando é um uuid, filtra por `separacao_galpao_id` (em pedidos),
 * `galpao_id` (em guarda/inventário). Compras é sempre global.
 */
export async function montarDashboardTarefas(
  sb: SupabaseClient,
  galpao_id: string | null,
): Promise<DashboardTarefasResult> {
  const [
    aprovacaoQ,
    separacaoQ,
    embalagemQ,
    guardaQ,
    invSessoesQ,
    invOperadoresQ,
    invLocsQ,
    comprasComprarItensQ,
    comprasOrdensQ,
  ] = await Promise.all([
    // Aprovação pendente
    (() => {
      let q = sb
        .from("siso_pedidos")
        .select("id", { count: "exact", head: true })
        .eq("status", "pendente");
      if (galpao_id) q = q.eq("separacao_galpao_id", galpao_id);
      return q;
    })(),

    // Separação ativa
    (() => {
      let q = sb
        .from("siso_pedidos")
        .select("id, status_separacao, separacao_operador_id")
        .in("status_separacao", [
          "aguardando_separacao",
          "em_separacao",
          "pendente_realocacao",
          "validacao_oc",
        ]);
      if (galpao_id) q = q.eq("separacao_galpao_id", galpao_id);
      return q;
    })(),

    // Embalagem
    (() => {
      let q = sb
        .from("siso_pedidos")
        .select("id, embalagem_operador_id")
        .eq("status_separacao", "separado");
      if (galpao_id) q = q.eq("separacao_galpao_id", galpao_id);
      return q;
    })(),

    // Guarda — agora com detalhe (limitamos a MAX_DETALHE p/ não exagerar).
    // O count total continua vindo de rows.length (carregamos só MAX).
    (() => {
      let q = sb
        .from("siso_wms_pendencias_guarda")
        .select(
          "id, status, iniciada_por, qty_inicial, qty_guardada, criada_em, galpao_id, " +
            "produto:siso_produtos(sku, descricao), galpao:siso_galpoes(nome)",
        )
        .in("status", ["pendente", "em_guarda"])
        .order("criada_em", { ascending: true })
        .limit(MAX_DETALHE_POR_SECAO + 1);
      if (galpao_id) q = q.eq("galpao_id", galpao_id);
      return q;
    })(),

    // Inventário — sessões em andamento
    (() => {
      let q = sb
        .from("siso_inventario_sessoes")
        .select(
          "id, nome, tipo, iniciada_em, criado_em, galpao_id, galpao:siso_galpoes(nome)",
        )
        .eq("status", "em_andamento")
        .order("iniciada_em", { ascending: true, nullsFirst: false });
      if (galpao_id) q = q.eq("galpao_id", galpao_id);
      return q;
    })(),

    // Inventário — operadores ativos (party)
    (() => {
      let q = sb
        .from("siso_inventario_operadores")
        .select(
          "usuario_id, sessao_id, sessao:siso_inventario_sessoes!inner(id, galpao_id, status)",
        )
        .is("finalizado_em", null)
        .eq("sessao.status", "em_andamento");
      if (galpao_id) q = q.eq("sessao.galpao_id", galpao_id);
      return q;
    })(),

    // Inventário — locs por sessão (pra calcular progresso)
    (() => {
      let q = sb
        .from("siso_inventario_localizacoes")
        .select(
          "sessao_id, status, sessao:siso_inventario_sessoes!inner(id, galpao_id, status)",
        )
        .eq("sessao.status", "em_andamento");
      if (galpao_id) q = q.eq("sessao.galpao_id", galpao_id);
      return q;
    })(),

    // Compras — itens "a comprar" (cross-galpão), com fornecedor_oc pra agrupar
    sb
      .from("siso_pedido_itens")
      .select("id, fornecedor_oc")
      .eq("compra_status", "aguardando_compra"),

    // Compras — ordens "a receber" (cross-galpão), com fornecedor pra agrupar
    sb
      .from("siso_ordens_compra")
      .select("id, fornecedor")
      .in("status", ["comprado", "parcialmente_recebido"]),
  ]);

  type SepRow = {
    id: string;
    status_separacao: string;
    separacao_operador_id: string | null;
  };
  type EmbRow = { id: string; embalagem_operador_id: string | null };
  type ProdutoJoin =
    | { sku: string; descricao: string | null }
    | Array<{ sku: string; descricao: string | null }>
    | null;
  type GalpaoJoin = { nome: string } | Array<{ nome: string }> | null;
  type GuardaRow = {
    id: string;
    status: "pendente" | "em_guarda" | "guardada" | "cancelada";
    iniciada_por: string | null;
    qty_inicial: number;
    qty_guardada: number;
    criada_em: string;
    galpao_id: string;
    produto: ProdutoJoin;
    galpao: GalpaoJoin;
  };
  type InvSessao = {
    id: string;
    nome: string | null;
    tipo: "cycle_count" | "completo";
    iniciada_em: string | null;
    criado_em: string;
    galpao_id: string;
    galpao: GalpaoJoin;
  };
  const first = <T,>(v: T | T[] | null | undefined): T | null => {
    if (!v) return null;
    return Array.isArray(v) ? v[0] ?? null : v;
  };
  type InvOpRow = { usuario_id: string; sessao_id: string };
  type InvLocRow = {
    sessao_id: string;
    status: "pendente" | "em_contagem" | "contada" | "divergente" | "aprovada";
  };

  const sepRows = (separacaoQ.data ?? []) as SepRow[];
  const embRows = (embalagemQ.data ?? []) as EmbRow[];
  const guardaRows = (guardaQ.data ?? []) as unknown as GuardaRow[];
  const invSessoes = (invSessoesQ.data ?? []) as unknown as InvSessao[];
  const invOpRows = (invOperadoresQ.data ?? []) as InvOpRow[];
  const invLocRows = (invLocsQ.data ?? []) as InvLocRow[];

  const sepIds = dedupNonNullIds(
    sepRows
      .filter((r) => r.status_separacao === "em_separacao")
      .map((r) => r.separacao_operador_id),
  );
  const embIds = dedupNonNullIds(embRows.map((r) => r.embalagem_operador_id));
  const guardaIds = dedupNonNullIds(
    guardaRows
      .filter((r) => r.status === "em_guarda")
      .map((r) => r.iniciada_por),
  );
  const invIds = dedupNonNullIds(invOpRows.map((r) => r.usuario_id));

  // Hidrata avatares em uma query única
  const allIds = dedupNonNullIds([...sepIds, ...embIds, ...guardaIds, ...invIds]);
  const usuariosMap = new Map<string, Executor>();
  if (allIds.length > 0) {
    const { data: usuarios } = await sb
      .from("siso_usuarios")
      .select("id, nome, foto_url")
      .in("id", allIds);
    for (const u of (usuarios ?? []) as Executor[]) {
      usuariosMap.set(u.id, u);
    }
  }

  // Monta cards detalhados de guarda. O count total = guardaRows.length até
  // MAX+1 (sinalizamos truncamento implicitamente exibindo MAX).
  const guardaItens: GuardaItem[] = guardaRows
    .slice(0, MAX_DETALHE_POR_SECAO)
    .map((r) => {
      const produto = first(r.produto);
      const galpao = first(r.galpao);
      return {
        id: r.id,
        produto_sku: produto?.sku ?? "—",
        produto_descricao: produto?.descricao ?? null,
        qty_pendente: Number(r.qty_inicial) - Number(r.qty_guardada),
        qty_inicial: Number(r.qty_inicial),
        status: r.status === "em_guarda" ? "em_guarda" : "pendente",
        iniciada_por: r.iniciada_por
          ? usuariosMap.get(r.iniciada_por) ?? null
          : null,
        criada_em: r.criada_em,
        galpao_nome: galpao?.nome ?? null,
      };
    });

  // Agrega locs por sessão pra calcular progresso
  type LocAcc = { total: number; contadas: number };
  const locsBySessao = new Map<string, LocAcc>();
  for (const l of invLocRows) {
    let acc = locsBySessao.get(l.sessao_id);
    if (!acc) {
      acc = { total: 0, contadas: 0 };
      locsBySessao.set(l.sessao_id, acc);
    }
    acc.total += 1;
    if (l.status !== "pendente" && l.status !== "em_contagem") {
      acc.contadas += 1;
    }
  }

  // Agrupa operadores ativos por sessão
  const opsBySessao = new Map<string, string[]>();
  for (const op of invOpRows) {
    const arr = opsBySessao.get(op.sessao_id) ?? [];
    arr.push(op.usuario_id);
    opsBySessao.set(op.sessao_id, arr);
  }

  const ciclos: CicloInventario[] = invSessoes.map((s) => {
    const loc = locsBySessao.get(s.id) ?? { total: 0, contadas: 0 };
    const pct =
      loc.total > 0 ? Math.round((loc.contadas / loc.total) * 100) : 0;
    const opIds = dedupNonNullIds(opsBySessao.get(s.id) ?? []);
    const galpao = first(s.galpao);
    return {
      id: s.id,
      nome:
        s.nome?.trim() ||
        `${s.tipo === "completo" ? "Inventário completo" : "Cycle count"} · ${new Date(s.criado_em).toLocaleDateString("pt-BR")}`,
      tipo: s.tipo,
      galpao_nome: galpao?.nome ?? null,
      locs_total: loc.total,
      locs_contadas: loc.contadas,
      locs_pendentes: loc.total - loc.contadas,
      progresso_pct: pct,
      iniciada_em: s.iniciada_em,
      operadores: hidratarExecutores(opIds, usuariosMap),
    };
  });

  const itensAComprarRows = (comprasComprarItensQ.data ?? []) as Array<{
    id: string;
    fornecedor_oc: string | null;
  }>;
  const ordensRows = (comprasOrdensQ.data ?? []) as Array<{
    id: string;
    fornecedor: string | null;
  }>;
  const fornecedores = agruparFornecedoresCompras(
    itensAComprarRows,
    ordensRows,
  );

  return {
    galpao_id,
    aprovacao: {
      count: aprovacaoQ.count ?? 0,
      marketplace: 0,
      manual: 0,
    },
    separacao: {
      count: sepRows.length,
      executores: hidratarExecutores(sepIds, usuariosMap),
    },
    embalagem: {
      count: embRows.length,
      executores: hidratarExecutores(embIds, usuariosMap),
    },
    guarda: {
      count: guardaRows.length,
      executores: hidratarExecutores(guardaIds, usuariosMap),
      itens: guardaItens,
    },
    compras: {
      aComprar: itensAComprarRows.length,
      aReceber: ordensRows.length,
      fornecedores,
    },
    inventario: {
      sessoesAtivas: invSessoes.length,
      executores: hidratarExecutores(invIds, usuariosMap),
      ciclos,
    },
    excecoes: {
      devolucoes: { count: 0, itens: [] },
      transferencias_transito: { count: 0, itens: [] },
      inventario_revisao: { count: 0, itens: [] },
      reservas_orfas: { count: 0, itens: [] },
      retroativos: { count: 0, itens: [] },
      recebimento_orfao: { count: 0, itens: [] },
    },
  };
}
