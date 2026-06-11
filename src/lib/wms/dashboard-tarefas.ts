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

/** Entrada direta hoje — movs nf_compra cuja loc destino ≠ recebimento. */
export type EntradaDiretaCard = {
  mov_id: string;
  produto_sku: string;
  produto_descricao: string;
  qty: number;
  galpao_nome: string | null;
  localizacao_codigo: string;
  criado_em: string;
};

/** Pedido travado em erro: pedido status='erro' (job esgotou as tentativas)
 *  OU job de fila status='erro'. Invisível no quadro sem este card — só
 *  aparecia em /wms/pedidos. */
export type PedidoErroCard = {
  pedido_id: string;
  origem: "pedido" | "job";
  criado_em: string | null;
};

export type ExcecoesPayload = {
  devolucoes: { count: number; itens: DevolucaoPendenteCard[] };
  transferencias_transito: { count: number; itens: TransferenciaTransitoCard[] };
  inventario_revisao: { count: number; itens: InventarioRevisaoCard[] };
  reservas_orfas: { count: number; itens: ReservaOrfaCard[] };
  retroativos: { count: number; itens: RetroativoPendenteCard[] };
  recebimento_orfao: { count: number; itens: RecebimentoOrfaoCard[] };
  entradas_diretas: { count: number; itens: EntradaDiretaCard[] };
  pedidos_erro: { count: number; itens: PedidoErroCard[] };
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

type DevolucaoLinha = {
  id: string;
  nota_fiscal_id: number | null;
  criado_em: string;
  empresa_referencia: { nome: string } | Array<{ nome: string }> | null;
};

/**
 * Mapeia linhas de `siso_devolucoes_pendentes` (com join opcional em
 * `siso_empresas` por `empresa_id`) pra cards prontos pro frontend.
 * Função pura — sem side effects.
 */
export function agruparDevolucoesPendentes(
  linhas: DevolucaoLinha[],
): { count: number; itens: DevolucaoPendenteCard[] } {
  const itens: DevolucaoPendenteCard[] = linhas.map((l) => {
    const empresa = Array.isArray(l.empresa_referencia)
      ? l.empresa_referencia[0] ?? null
      : l.empresa_referencia;
    return {
      id: l.id,
      nota_fiscal_id: l.nota_fiscal_id,
      empresa_referencia_nome: empresa?.nome ?? null,
      criada_em: l.criado_em,
    };
  });
  return { count: itens.length, itens };
}

type TransferenciaLinha = {
  id: string;
  criada_em: string;
  origem_galpao: { nome: string } | Array<{ nome: string }> | null;
  destino_galpao: { nome: string } | Array<{ nome: string }> | null;
  itens: Array<{ qty: number }> | null;
};

/**
 * Mapeia linhas de `siso_transferencias_galpao` (com joins de galpões e
 * itens) pra cards de transferência em trânsito. Soma `qty` dos itens
 * pra preencher o badge "qty_itens" no card.
 */
export function agruparTransferenciasTransito(
  linhas: TransferenciaLinha[],
): { count: number; itens: TransferenciaTransitoCard[] } {
  const itens: TransferenciaTransitoCard[] = linhas.map((l) => {
    const origem = Array.isArray(l.origem_galpao)
      ? l.origem_galpao[0] ?? null
      : l.origem_galpao;
    const destino = Array.isArray(l.destino_galpao)
      ? l.destino_galpao[0] ?? null
      : l.destino_galpao;
    const qty_itens = (l.itens ?? []).reduce(
      (acc, i) => acc + Number(i.qty || 0),
      0,
    );
    return {
      id: l.id,
      origem_galpao_nome: origem?.nome ?? null,
      destino_galpao_nome: destino?.nome ?? null,
      criada_em: l.criada_em,
      qty_itens,
    };
  });
  return { count: itens.length, itens };
}

type RevisaoLinha = {
  id: string;
  nome: string | null;
  criado_em: string;
  galpao: { nome: string } | Array<{ nome: string }> | null;
};

/**
 * Mapeia sessões de inventário em status='revisao' pra cards. O contador
 * de divergências vem de um map auxiliar (calculado fora pra evitar N+1).
 */
export function agruparInventarioRevisao(
  linhas: RevisaoLinha[],
  divergenciasPorSessao: Map<string, number>,
): { count: number; itens: InventarioRevisaoCard[] } {
  const itens: InventarioRevisaoCard[] = linhas.map((l) => {
    const galpao = Array.isArray(l.galpao) ? l.galpao[0] ?? null : l.galpao;
    return {
      id: l.id,
      nome:
        l.nome?.trim() ||
        `Inventário · ${new Date(l.criado_em).toLocaleDateString("pt-BR")}`,
      galpao_nome: galpao?.nome ?? null,
      total_divergencias: divergenciasPorSessao.get(l.id) ?? 0,
      criado_em: l.criado_em,
    };
  });
  return { count: itens.length, itens };
}

type ReservaCandidata = {
  id: string;
  pedido_id: string | null;
  quantidade: number;
  criado_em: string;
  produto: { sku: string } | Array<{ sku: string }> | null;
  pedido:
    | { numero: string | null; status: string | null }
    | Array<{ numero: string | null; status: string | null }>
    | null;
};

/**
 * Detecta reservas R órfãs: movs tipo='R' + origem_tipo='reserva_pedido'
 * cujo pedido associado está com status='cancelado' E que ainda não foram
 * estornadas (não aparecem em `movsJaEstornadas`).
 *
 * Função pura. O caller é responsável por:
 *   - Buscar Rs candidatas
 *   - Resolver os pedidos (pode vir via JOIN do PostgREST ou via query
 *     separada — pedido_id é text, sem FK declarada)
 *   - Hidratar `pedido` no objeto antes de chamar
 *   - Montar o set `movsJaEstornadas` (movs que apareceram como `estorno_de`)
 */
export function detectarReservasOrfas(
  reservas: ReservaCandidata[],
  movsJaEstornadas: Set<string>,
): { count: number; itens: ReservaOrfaCard[] } {
  const itens: ReservaOrfaCard[] = [];
  for (const r of reservas) {
    if (movsJaEstornadas.has(r.id)) continue;
    if (!r.pedido_id) continue;
    const pedido = Array.isArray(r.pedido) ? r.pedido[0] ?? null : r.pedido;
    if (!pedido) continue;
    if (pedido.status !== "cancelado") continue;
    const produto = Array.isArray(r.produto) ? r.produto[0] ?? null : r.produto;
    itens.push({
      id: r.id,
      pedido_id: r.pedido_id,
      pedido_numero: pedido.numero ?? null,
      produto_sku: produto?.sku ?? "—",
      qty: Number(r.quantidade),
      criada_em: r.criado_em,
    });
  }
  return { count: itens.length, itens };
}

type RetroativoLinha = {
  id: string;
  criado_em: string;
  quantidade: number;
  motivo: string | null;
  produto:
    | { sku: string; descricao: string | null }
    | Array<{ sku: string; descricao: string | null }>
    | null;
};

/**
 * Mapeia movs com origem_tipo='lancamento_retroativo' pra cards
 * de pendência. Não filtra estornos aqui (caller faz isso usando o
 * `movsJaEstornadas` montado pra reservas órfãs).
 */
export function mapearRetroativosPendentes(
  linhas: RetroativoLinha[],
): { count: number; itens: RetroativoPendenteCard[] } {
  const itens: RetroativoPendenteCard[] = linhas.map((l) => {
    const produto = Array.isArray(l.produto)
      ? l.produto[0] ?? null
      : l.produto;
    return {
      id: l.id,
      produto_sku: produto?.sku ?? "—",
      qty: Number(l.quantidade),
      criado_em: l.criado_em,
      motivo: l.motivo ?? "",
    };
  });
  return { count: itens.length, itens };
}

type EstoqueRecebimentoLinha = {
  produto_id: string;
  galpao_id: string;
  saldo: number;
  produto: { sku: string } | Array<{ sku: string }> | null;
  galpao: { nome: string } | Array<{ nome: string }> | null;
  localizacao: { codigo: string } | Array<{ codigo: string }> | null;
};

/**
 * Detecta saldos órfãos em localização tipo='recebimento'. Uma posição
 * é órfã quando tem saldo > 0 mas não existe pendência viva (`pendente` ou
 * `em_guarda`) cobrindo o par (produto_id, galpao_id). O set
 * `pendenciasVivas` é chaveado por `"<produto_id>::<galpao_id>"`.
 */
export function detectarRecebimentoOrfao(
  saldos: EstoqueRecebimentoLinha[],
  pendenciasVivas: Set<string>,
): { count: number; itens: RecebimentoOrfaoCard[] } {
  const itens: RecebimentoOrfaoCard[] = [];
  for (const s of saldos) {
    if (Number(s.saldo) <= 0) continue;
    const key = `${s.produto_id}::${s.galpao_id}`;
    if (pendenciasVivas.has(key)) continue;
    const produto = Array.isArray(s.produto) ? s.produto[0] ?? null : s.produto;
    const galpao = Array.isArray(s.galpao) ? s.galpao[0] ?? null : s.galpao;
    const loc = Array.isArray(s.localizacao)
      ? s.localizacao[0] ?? null
      : s.localizacao;
    itens.push({
      produto_id: s.produto_id,
      produto_sku: produto?.sku ?? "—",
      galpao_id: s.galpao_id,
      galpao_nome: galpao?.nome ?? null,
      localizacao_codigo: loc?.codigo ?? "—",
      saldo: Number(s.saldo),
    });
  }
  return { count: itens.length, itens };
}

/**
 * Coleta as 6 exceções operacionais expostas no dashboard /wms (P5 §1).
 * Roda 8 queries em paralelo + 1 query suplementar (pedidos por id) pra
 * hidratar reservas órfãs.
 *
 * Decisão de design: corre em Promise.all separado do main pra manter o
 * `montarDashboardTarefas` legível. As 8 queries são independentes —
 * paralelismo aqui não compete com as queries base.
 */
export async function montarExcecoes(
  sb: SupabaseClient,
  galpao_id: string | null,
): Promise<ExcecoesPayload> {
  const [
    devolucoesQ,
    transferenciasQ,
    invRevisaoQ,
    invDivergenciasQ,
    reservasQ,
    estornosQ,
    retroativosQ,
    saldosRecebQ,
    pendenciasVivasQ,
    entradasDiretasQ,
    pedidosErroQ,
    jobsErroQ,
  ] = await Promise.all([
    // Devoluções pendentes — global, sem filtro de galpão (a devolução
    // só ganha galpão quando classificada).
    sb
      .from("siso_devolucoes_pendentes")
      .select(
        "id, nota_fiscal_id, criado_em, empresa_referencia:siso_empresas!empresa_id(nome)",
      )
      .eq("status", "aguardando_classificacao")
      .order("criado_em", { ascending: true })
      .limit(MAX_DETALHE_POR_SECAO + 1),

    // Transferências em trânsito — operador no destino precisa de
    // visibilidade. Quando galpao_id presente, filtra por galpao_destino_id.
    // NOTE: tabela é singular `siso_transferencia_galpao_itens`; FKs são
    // `galpao_origem_id` / `galpao_destino_id`.
    (() => {
      let q = sb
        .from("siso_transferencias_galpao")
        .select(
          "id, criada_em, " +
            "origem_galpao:siso_galpoes!galpao_origem_id(nome), " +
            "destino_galpao:siso_galpoes!galpao_destino_id(nome), " +
            "itens:siso_transferencia_galpao_itens(qty)",
        )
        .eq("status", "em_transito")
        .order("criada_em", { ascending: true })
        .limit(MAX_DETALHE_POR_SECAO + 1);
      if (galpao_id) q = q.eq("galpao_destino_id", galpao_id);
      return q;
    })(),

    // Inventário em revisão — sessão encerrou contagem, supervisor ainda
    // não aprovou.
    (() => {
      let q = sb
        .from("siso_inventario_sessoes")
        .select("id, nome, criado_em, galpao_id, galpao:siso_galpoes(nome)")
        .eq("status", "revisao")
        .order("criado_em", { ascending: true })
        .limit(MAX_DETALHE_POR_SECAO + 1);
      if (galpao_id) q = q.eq("galpao_id", galpao_id);
      return q;
    })(),

    // Divergências pendentes agrupadas por sessão (contador do card)
    sb
      .from("siso_inventario_divergencias")
      .select("sessao_id")
      .eq("status", "pendente"),

    // Reservas R pendentes (últimas 500). pedido_id é text sem FK — pedidos
    // vêm via query separada e são merged em memória.
    sb
      .from("siso_movimentacoes")
      .select(
        "id, pedido_id, quantidade, criado_em, produto:siso_produtos(sku)",
      )
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido")
      .order("criado_em", { ascending: false })
      .limit(500),

    // Movs com estorno_de != null. Usada por reservas órfãs + retroativos.
    sb
      .from("siso_movimentacoes")
      .select("estorno_de")
      .not("estorno_de", "is", null)
      .order("criado_em", { ascending: false })
      .limit(2000),

    // Lançamentos retroativos pendentes (não estornados).
    (() => {
      let q = sb
        .from("siso_movimentacoes")
        .select(
          "id, criado_em, quantidade, motivo, galpao_id, produto:siso_produtos(sku, descricao)",
        )
        .eq("origem_tipo", "lancamento_retroativo")
        .is("estorno_de", null)
        .order("criado_em", { ascending: false })
        .limit(MAX_DETALHE_POR_SECAO + 1);
      if (galpao_id) q = q.eq("galpao_id", galpao_id);
      return q;
    })(),

    // Saldos em localização tipo='recebimento' com saldo > 0.
    (() => {
      let q = sb
        .from("siso_estoque")
        .select(
          "produto_id, galpao_id, saldo, " +
            "produto:siso_produtos(sku), galpao:siso_galpoes(nome), " +
            "localizacao:siso_localizacoes!inner(codigo, tipo)",
        )
        .gt("saldo", 0)
        .eq("localizacao.tipo", "recebimento");
      if (galpao_id) q = q.eq("galpao_id", galpao_id);
      return q;
    })(),

    // Pendências de guarda vivas (pra subtrair do "órfão").
    (() => {
      let q = sb
        .from("siso_wms_pendencias_guarda")
        .select("produto_id, galpao_id")
        .in("status", ["pendente", "em_guarda"]);
      if (galpao_id) q = q.eq("galpao_id", galpao_id);
      return q;
    })(),

    // [Fix-D #5.2] Entradas diretas hoje — movs nf_compra cuja loc destino
    // NÃO é tipo='recebimento' (entrada direta pula o dock).
    (() => {
      const inicioHoje = new Date();
      inicioHoje.setHours(0, 0, 0, 0);
      let q = sb
        .from("siso_movimentacoes")
        .select(
          "id, quantidade, criado_em, " +
            "produto:siso_produtos(sku, descricao), " +
            "galpao:siso_galpoes(nome), " +
            "localizacao:siso_localizacoes!inner(codigo, tipo, galpao_id)",
        )
        .eq("tipo", "E")
        .eq("origem_tipo", "nf_compra")
        .neq("localizacao.tipo", "recebimento")
        .gte("criado_em", inicioHoje.toISOString())
        .order("criado_em", { ascending: false })
        .limit(MAX_DETALHE_POR_SECAO + 1);
      if (galpao_id) q = q.eq("localizacao.galpao_id", galpao_id);
      return q;
    })(),

    // [P2-CST-03] Pedidos travados em erro: job esgotou as tentativas e setou
    // siso_pedidos.status='erro'. Invisíveis no quadro — só apareciam em
    // /wms/pedidos. Filtramos por galpão quando presente (pedido já roteado).
    (() => {
      let q = sb
        .from("siso_pedidos")
        .select("id, criado_em, separacao_galpao_id")
        .eq("status", "erro")
        .order("criado_em", { ascending: true })
        .limit(MAX_DETALHE_POR_SECAO + 1);
      if (galpao_id) {
        // Pedido em erro pode não ter separacao_galpao_id (falhou antes de
        // rotear) — incluímos os NULL pra não esconder do operador do galpão.
        q = q.or(
          `separacao_galpao_id.eq.${galpao_id},separacao_galpao_id.is.null`,
        );
      }
      return q;
    })(),

    // [P2-CST-03] Jobs de fila em erro (status='erro'): cobre o caso em que o
    // job esgotou mas o pedido NÃO foi marcado erro (ex: pedido já cancelado).
    // DISTINCT por pedido_id é feito em memória na união abaixo.
    sb
      .from("siso_fila_execucao")
      .select("pedido_id, atualizado_em")
      .eq("status", "erro")
      .order("atualizado_em", { ascending: true })
      .limit(MAX_DETALHE_POR_SECAO + 1),
  ]);

  // Devoluções
  const devolucoesRows = (devolucoesQ.data ?? []) as DevolucaoLinha[];
  const devolucoes = agruparDevolucoesPendentes(devolucoesRows);

  // Transferências em trânsito
  const transferenciasRows = (transferenciasQ.data ?? []) as unknown as TransferenciaLinha[];
  const transferencias = agruparTransferenciasTransito(transferenciasRows);

  // Inventário em revisão + divergências por sessão
  const revisaoRows = (invRevisaoQ.data ?? []) as RevisaoLinha[];
  const divergenciasRows = (invDivergenciasQ.data ?? []) as Array<{
    sessao_id: string;
  }>;
  const divergenciasPorSessao = new Map<string, number>();
  for (const d of divergenciasRows) {
    divergenciasPorSessao.set(
      d.sessao_id,
      (divergenciasPorSessao.get(d.sessao_id) ?? 0) + 1,
    );
  }
  const inventarioRevisao = agruparInventarioRevisao(
    revisaoRows,
    divergenciasPorSessao,
  );

  // Reservas órfãs (hidrata pedidos em query separada)
  const reservasRawRows = (reservasQ.data ?? []) as Array<{
    id: string;
    pedido_id: string | null;
    quantidade: number;
    criado_em: string;
    produto: { sku: string } | Array<{ sku: string }> | null;
  }>;
  const estornosRows = (estornosQ.data ?? []) as Array<{
    estorno_de: string | null;
  }>;
  const movsJaEstornadas = new Set<string>();
  for (const e of estornosRows) {
    if (e.estorno_de) movsJaEstornadas.add(e.estorno_de);
  }
  const reservaPedidoIds = dedupNonNullIds(
    reservasRawRows.map((r) => r.pedido_id),
  );
  const pedidosPorId = new Map<
    string,
    { numero: string | null; status: string | null }
  >();
  if (reservaPedidoIds.length > 0) {
    const { data: pedidos } = await sb
      .from("siso_pedidos")
      .select("id, numero, status")
      .in("id", reservaPedidoIds);
    for (const p of (pedidos ?? []) as Array<{
      id: string;
      numero: string | null;
      status: string | null;
    }>) {
      pedidosPorId.set(p.id, { numero: p.numero, status: p.status });
    }
  }
  const reservasRows: ReservaCandidata[] = reservasRawRows.map((r) => ({
    id: r.id,
    pedido_id: r.pedido_id,
    quantidade: r.quantidade,
    criado_em: r.criado_em,
    produto: r.produto,
    pedido: r.pedido_id ? pedidosPorId.get(r.pedido_id) ?? null : null,
  }));
  const reservasOrfas = detectarReservasOrfas(reservasRows, movsJaEstornadas);

  // Retroativos (descarta os já estornados)
  const retroativosRows = (retroativosQ.data ?? []) as RetroativoLinha[];
  const retroativosNaoEstornados = retroativosRows.filter(
    (r) => !movsJaEstornadas.has(r.id),
  );
  const retroativos = mapearRetroativosPendentes(retroativosNaoEstornados);

  // Saldo RECEBIMENTO órfão
  const saldosRecebRows = (saldosRecebQ.data ?? []) as unknown as EstoqueRecebimentoLinha[];
  const pendenciasVivasRows = (pendenciasVivasQ.data ?? []) as Array<{
    produto_id: string;
    galpao_id: string;
  }>;
  const pendenciasVivasKeys = new Set<string>();
  for (const p of pendenciasVivasRows) {
    pendenciasVivasKeys.add(`${p.produto_id}::${p.galpao_id}`);
  }
  const recebimentoOrfao = detectarRecebimentoOrfao(
    saldosRecebRows,
    pendenciasVivasKeys,
  );

  // Entradas diretas hoje
  const entradasDiretasRows = (entradasDiretasQ.data ?? []) as unknown as Array<{
    id: string;
    quantidade: number;
    criado_em: string;
    produto: { sku?: string; descricao?: string } | Array<{ sku?: string; descricao?: string }> | null;
    galpao: { nome?: string } | Array<{ nome?: string }> | null;
    localizacao: { codigo?: string } | Array<{ codigo?: string }> | null;
  }>;
  const entradasDiretas = {
    count: entradasDiretasRows.length,
    itens: entradasDiretasRows.slice(0, MAX_DETALHE_POR_SECAO).map((r): EntradaDiretaCard => {
      const produto = Array.isArray(r.produto) ? r.produto[0] ?? null : r.produto;
      const galpao = Array.isArray(r.galpao) ? r.galpao[0] ?? null : r.galpao;
      const loc = Array.isArray(r.localizacao) ? r.localizacao[0] ?? null : r.localizacao;
      return {
        mov_id: r.id,
        produto_sku: produto?.sku ?? "—",
        produto_descricao: produto?.descricao ?? "",
        qty: Number(r.quantidade ?? 0),
        galpao_nome: galpao?.nome ?? null,
        localizacao_codigo: loc?.codigo ?? "—",
        criado_em: r.criado_em,
      };
    }),
  };

  // Pedidos em erro — união dedupada de pedidos status='erro' + jobs status='erro'
  // (DISTINCT por pedido_id). Pedido tem prioridade sobre job pra origem/criado_em.
  const pedidosErroRows = (pedidosErroQ.data ?? []) as Array<{
    id: string;
    criado_em: string | null;
  }>;
  const jobsErroRows = (jobsErroQ.data ?? []) as Array<{
    pedido_id: string | null;
    atualizado_em: string | null;
  }>;
  const erroPorPedido = new Map<string, PedidoErroCard>();
  for (const p of pedidosErroRows) {
    if (!p.id) continue;
    erroPorPedido.set(p.id, {
      pedido_id: p.id,
      origem: "pedido",
      criado_em: p.criado_em,
    });
  }
  for (const j of jobsErroRows) {
    if (!j.pedido_id || j.pedido_id === "MAINT") continue;
    if (erroPorPedido.has(j.pedido_id)) continue;
    erroPorPedido.set(j.pedido_id, {
      pedido_id: j.pedido_id,
      origem: "job",
      criado_em: j.atualizado_em,
    });
  }
  const pedidosErroItens = Array.from(erroPorPedido.values()).slice(
    0,
    MAX_DETALHE_POR_SECAO,
  );
  const pedidosErro = {
    count: erroPorPedido.size,
    itens: pedidosErroItens,
  };

  return {
    devolucoes,
    transferencias_transito: transferencias,
    inventario_revisao: inventarioRevisao,
    reservas_orfas: reservasOrfas,
    retroativos,
    recebimento_orfao: recebimentoOrfao,
    entradas_diretas: entradasDiretas,
    pedidos_erro: pedidosErro,
  };
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
  // P5 §1.17 — exceções extraídas em helper separado pra manter este aqui legível
  const excecoesPromise = montarExcecoes(sb, galpao_id);

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
    // Aprovação pendente — só transferência (propria/oc auto-aprovam no webhook
    // desde FASE 1). Retorna rows pra split marketplace vs manual via `origem_pedido`.
    (() => {
      let q = sb
        .from("siso_pedidos")
        .select("id, origem_pedido")
        .eq("status", "pendente")
        .eq("sugestao", "transferencia");
      if (galpao_id) {
        // Pedidos `pendente` podem ter separacao_galpao_id NULL (ainda não
        // aprovados). Incluir esses no filtro do galpão atual — operador
        // precisa ver pra decidir.
        q = q.or(
          `separacao_galpao_id.eq.${galpao_id},separacao_galpao_id.is.null`,
        );
      }
      return q;
    })(),

    // Separação ativa
    // invariante: após aprovar, separacao_galpao_id sempre setado (status_separacao
    // só sai de NULL via /pedidos/aprovar, que escreve galpão). Por isso aqui o
    // .eq direto é seguro — confirmado em staging em 2026-05-26 (P5 §2.3).
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
    // invariante: status_separacao='separado' implica separacao_galpao_id setado
    // (mesma justificativa da separação acima).
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

  // Aguarda exceções (P5 §1) — disparadas em paralelo no início da função
  const excecoes = await excecoesPromise;

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

  // §1 task 1.15 — Split aprovação manual vs marketplace
  const aprovacaoRows = (aprovacaoQ.data ?? []) as Array<{
    origem_pedido: string | null;
  }>;
  const aprovacaoMarketplace = aprovacaoRows.filter(
    (r) => r.origem_pedido !== "manual",
  ).length;
  const aprovacaoManual = aprovacaoRows.filter(
    (r) => r.origem_pedido === "manual",
  ).length;

  return {
    galpao_id,
    aprovacao: {
      count: aprovacaoRows.length,
      marketplace: aprovacaoMarketplace,
      manual: aprovacaoManual,
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
    excecoes,
  };
}
