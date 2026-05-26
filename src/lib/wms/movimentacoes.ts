import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao, estornarMovimentacao } from "./ledger";
import type { Tripla, Movimentacao, OrigemTipo } from "./types";
import { criarPendencia, resolverLocRecebimento } from "./guarda";
import { logger } from "@/lib/logger";

interface ItemRecebimento {
  produto_id: string;
  qty: number;
  custo_unitario?: number;
  /**
   * Loc destino decidida pelo operador no recebimento (opcional).
   * Salva na pendência pra etiqueta e default do tablet. Se omitida,
   * tablet decide via putaway no momento da guarda.
   */
  localizacao_destino_id?: string;
}

export interface ReceberInput {
  galpao_id: string;
  itens: ItemRecebimento[];
  /**
   * Tag histórica: empresa que fez a compra (quem assina a NF de entrada).
   * Apenas metadata — não é coordenada do estoque.
   */
  empresa_compradora_id?: string | null;
  /** Tag histórica: fornecedor da NF de entrada. */
  fornecedor_id?: string | null;
  nf_referencia?: string;
  /** UUID da NF em siso_notas_fiscais (quando já cadastrada). */
  nota_fiscal_id?: string | null;
  /** Chave de acesso de 44 dígitos (fallback quando nota_fiscal_id ainda não foi populado). */
  chave_acesso_nf?: string | null;
  /** Motivo livre — útil pra lançamento_retroativo e ajustes. */
  motivo?: string | null;
  usuario_id: string;
  /**
   * ISO timestamp da data do recebimento (passado). Quando informado, a mov
   * é registrada com origem `lancamento_retroativo` (a menos que `origem_tipo`
   * sobrescreva) e a data viaja em `origem_detalhes.data_recebimento` —
   * o ledger sempre carimba `criado_em` com now(); a info histórica é apenas
   * informativa.
   */
  data_recebimento?: string;
  /**
   * Tipo de origem. Default `nf_compra`. O modal de Receber pode passar
   * `lancamento_retroativo` (data no passado) ou `devolucao_cliente_integra`
   * (devolução íntegra que volta pro estoque). RPC do ledger valida.
   */
  origem_tipo?: OrigemTipo;
  observacoes?: string;
  /**
   * Se true, pula o dock RECEBIMENTO e escreve 1 mov direto na loc destino
   * de cada item — sem criar pendência de guarda. Exige
   * `localizacao_destino_id` em todos os itens; caso contrário, throw.
   */
  entrada_direta?: boolean;
}

export interface ReceberResult {
  /**
   * IDs das pendências de guarda criadas, na mesma ordem dos itens.
   * Array vazio quando `entrada_direta=true`.
   */
  pendencia_ids: string[];
  /**
   * ID da loc RECEBIMENTO usada (uma por galpão). `null` quando
   * `entrada_direta=true` — mercadoria foi direto pra loc destino.
   */
  localizacao_recebimento_id: string | null;
  /**
   * UUID do lote — compartilhado entre todas as movs (e pendências, se houver)
   * desta chamada. Útil pra agrupar etiquetas e auditoria.
   */
  lote_id: string;
  /**
   * IDs das movs criadas (entrada), na mesma ordem dos itens. Útil pra montar
   * payload de etiqueta em modo entrada_direta.
   */
  mov_ids: string[];
}

/**
 * Registra o recebimento no ledger E cria pendências de guarda.
 *
 * Fluxo de 2 etapas: o caminhão chega, o operador bipa SKU+qty no recebimento,
 * a mercadoria fica na loc tipo='recebimento' (dock de chegada). Cada linha
 * vira uma `siso_wms_pendencias_guarda`, que será consumida pela tela
 * /wms/guarda no tablet (operador imprime etiq, bipa loc destino, confirma).
 *
 * Em 3D, a empresa que comprou viaja como tag (`empresa_compradora_id`),
 * não como coordenada de estoque.
 */
export async function receberEstoque(
  input: ReceberInput,
): Promise<ReceberResult> {
  const origemTipo = input.origem_tipo ?? "nf_compra";
  const loteId = crypto.randomUUID();

  const origemDetalhesBase: Record<string, unknown> = {
    nf_referencia: input.nf_referencia,
  };
  if (input.data_recebimento) {
    origemDetalhesBase.data_recebimento = input.data_recebimento;
  }

  // Modo entrada direta: pula o dock RECEBIMENTO e escreve direto na loc
  // destino de cada item. Não cria pendência. Exige loc destino em todos.
  if (input.entrada_direta) {
    if (!input.itens.length) {
      throw new Error("recebimento sem itens");
    }
    const semLoc = input.itens.findIndex((i) => !i.localizacao_destino_id);
    if (semLoc !== -1) {
      throw new Error(
        `entrada direta exige localizacao_destino_id em todos os itens (item ${semLoc + 1} sem loc destino)`,
      );
    }
    const movIds: string[] = [];
    for (const item of input.itens) {
      const mov = await inserirMovimentacao({
        tripla: {
          produto_id: item.produto_id,
          galpao_id: input.galpao_id,
          localizacao_id: item.localizacao_destino_id!,
        },
        tipo: "E",
        qty: item.qty,
        origem_tipo: origemTipo,
        origem_id: loteId,
        origem_detalhes: {
          ...origemDetalhesBase,
          entrada_direta: true,
        },
        empresa_compradora_id: input.empresa_compradora_id ?? null,
        fornecedor_id: input.fornecedor_id ?? null,
        nota_fiscal_id: input.nota_fiscal_id ?? null,
        chave_acesso_nf: input.chave_acesso_nf ?? null,
        custo_unitario: item.custo_unitario,
        motivo: input.motivo ?? null,
        usuario_id: input.usuario_id,
      });
      movIds.push(mov.id);
    }
    return {
      pendencia_ids: [],
      localizacao_recebimento_id: null,
      lote_id: loteId,
      mov_ids: movIds,
    };
  }

  // Modo padrão: entra em RECEBIMENTO + cria pendência de guarda.
  const localizacaoRecebimentoId = await resolverLocRecebimento(input.galpao_id);
  // Pré-validação ANTES de qualquer escrita no ledger. Se destino == origem
  // (frontend bugado, race, etc), abortamos sem deixar mov órfã.
  validarItensRecebimento(input.itens, localizacaoRecebimentoId);
  const pendenciaIds: string[] = [];
  const movIds: string[] = [];

  for (const item of input.itens) {
    const mov = await inserirMovimentacao({
      tripla: {
        produto_id: item.produto_id,
        galpao_id: input.galpao_id,
        localizacao_id: localizacaoRecebimentoId,
      },
      tipo: "E",
      qty: item.qty,
      origem_tipo: origemTipo,
      origem_id: loteId,
      origem_detalhes: origemDetalhesBase,
      empresa_compradora_id: input.empresa_compradora_id ?? null,
      fornecedor_id: input.fornecedor_id ?? null,
      nota_fiscal_id: input.nota_fiscal_id ?? null,
      chave_acesso_nf: input.chave_acesso_nf ?? null,
      custo_unitario: item.custo_unitario,
      motivo: input.motivo ?? null,
      usuario_id: input.usuario_id,
    });
    // Defense-in-depth: se algo na criação da pendência falhar (FK quebrada,
    // race de loc destino desativada entre validação e insert, falha de
    // rede com supabase), estorna a mov da entrada pra não deixar saldo
    // órfão na RECEBIMENTO sem pendência associada (bug 2026-05-19).
    try {
      const pendenciaId = await criarPendencia({
        produto_id: item.produto_id,
        galpao_id: input.galpao_id,
        localizacao_origem_id: localizacaoRecebimentoId,
        localizacao_destino_id: item.localizacao_destino_id ?? null,
        mov_entrada_id: mov.id,
        qty_inicial: item.qty,
        origem_tipo: origemTipo,
        nf_referencia: input.nf_referencia,
        custo_unitario: item.custo_unitario,
        observacoes: input.observacoes,
        lote_id: loteId,
        criada_por: input.usuario_id,
      });
      pendenciaIds.push(pendenciaId);
      movIds.push(mov.id);
    } catch (err) {
      try {
        await estornarMovimentacao({
          mov_id: mov.id,
          usuario_id: input.usuario_id,
          motivo: `Estorno automático: criação de pendência de guarda falhou (${err instanceof Error ? err.message : String(err)})`,
        });
        logger.warn(
          "wms.receber",
          "mov de entrada estornada após falha na pendência",
          { movId: mov.id, error: String(err) },
        );
      } catch (estornoErr) {
        // Não pudemos compensar. Loga forte; a mov ficará órfã e precisará
        // de intervenção manual (criar pendência retroativa ou estornar).
        logger.error(
          "wms.receber",
          "FALHA AO ESTORNAR mov após erro na pendência — mov órfã",
          {
            movId: mov.id,
            errOriginal: String(err),
            errEstorno: String(estornoErr),
          },
        );
      }
      throw err;
    }
  }

  return {
    pendencia_ids: pendenciaIds,
    localizacao_recebimento_id: localizacaoRecebimentoId,
    lote_id: loteId,
    mov_ids: movIds,
  };
}

/**
 * Pré-valida os itens de um recebimento ANTES de gravar movs.
 * Pura — sem I/O — pra ser fácil de testar.
 *
 * Regras:
 * - destino, se informado, não pode ser igual à loc de RECEBIMENTO
 *   (essa é a origem do put-away; usar como destino quebra a guarda).
 * - duplicidade de destino entre itens é OK (operador pode receber 2 SKUs
 *   no mesmo endereço).
 *
 * Outras validações (loc existe, ativa, mesmo galpão) ficam em `criarPendencia`
 * com I/O — esse JS-side checa só o invariante mais comum e barato.
 */
export function validarItensRecebimento(
  itens: ItemRecebimento[],
  localizacaoRecebimentoId: string,
): void {
  if (!itens.length) {
    throw new Error("recebimento sem itens");
  }
  itens.forEach((item, idx) => {
    if (
      item.localizacao_destino_id &&
      item.localizacao_destino_id === localizacaoRecebimentoId
    ) {
      throw new Error(
        `item ${idx + 1}: loc destino não pode ser a própria área de RECEBIMENTO (escolha uma loc de picking/overstock ou deixe em branco)`,
      );
    }
  });
}

export interface TransferirGalpaoInput {
  galpao_origem_id: string;
  localizacao_origem_id: string;
  galpao_destino_id: string;
  localizacao_destino_id: string;
  itens: { produto_id: string; qty: number }[];
  usuario_id: string;
  observacoes?: string;
  /**
   * UUID compartilhado entre os dois lados da transferência. Quando omitido,
   * é gerado aqui. Use pra correlacionar com `siso_transferencias_galpao` se
   * a transferência tem header próprio.
   */
  origem_id?: string;
}

/**
 * Par S+E NEUTRO (sem empresa) — em 3D a transferência entre galpões não
 * carrega dona; estoque é fungível dentro do pool físico.
 */
export async function transferirInterGalpao(
  input: TransferirGalpaoInput,
): Promise<{ origem_id: string }> {
  if (input.galpao_origem_id === input.galpao_destino_id) {
    throw new Error(
      "transferência inter-galpão exige galpões diferentes (use replenishment)",
    );
  }
  const origem_id = input.origem_id ?? crypto.randomUUID();
  for (const item of input.itens) {
    await inserirMovimentacao({
      tripla: {
        produto_id: item.produto_id,
        galpao_id: input.galpao_origem_id,
        localizacao_id: input.localizacao_origem_id,
      },
      tipo: "S",
      qty: item.qty,
      origem_tipo: "transferencia_galpao",
      origem_id,
      usuario_id: input.usuario_id,
      motivo: input.observacoes,
    });
    await inserirMovimentacao({
      tripla: {
        produto_id: item.produto_id,
        galpao_id: input.galpao_destino_id,
        localizacao_id: input.localizacao_destino_id,
      },
      tipo: "E",
      qty: item.qty,
      origem_tipo: "transferencia_galpao",
      origem_id,
      usuario_id: input.usuario_id,
      motivo: input.observacoes,
    });
  }
  return { origem_id };
}

export interface ReplenishmentInput {
  galpao_id: string;
  localizacao_origem_id: string;
  localizacao_destino_id: string;
  itens: { produto_id: string; qty: number }[];
  usuario_id: string;
  observacoes?: string;
  origem_id?: string;
}

export function validarTransferenciaIntraGalpao(input: {
  localizacao_origem_id: string;
  localizacao_destino_id: string;
}): void {
  if (input.localizacao_origem_id === input.localizacao_destino_id) {
    throw new Error("origem e destino não podem ser a mesma localização");
  }
}

/**
 * Par S+E NEUTRO intra-galpão (replenishment / put-away). Em 3D não há
 * empresa — estoque migra de uma loc física pra outra.
 */
export async function replenishmentIntraGalpao(
  input: ReplenishmentInput,
): Promise<{ origem_id: string }> {
  validarTransferenciaIntraGalpao(input);
  const origem_id = input.origem_id ?? crypto.randomUUID();
  for (const item of input.itens) {
    await inserirMovimentacao({
      tripla: {
        produto_id: item.produto_id,
        galpao_id: input.galpao_id,
        localizacao_id: input.localizacao_origem_id,
      },
      tipo: "S",
      qty: item.qty,
      origem_tipo: "transferencia_localizacao",
      origem_id,
      usuario_id: input.usuario_id,
      motivo: input.observacoes,
    });
    await inserirMovimentacao({
      tripla: {
        produto_id: item.produto_id,
        galpao_id: input.galpao_id,
        localizacao_id: input.localizacao_destino_id,
      },
      tipo: "E",
      qty: item.qty,
      origem_tipo: "transferencia_localizacao",
      origem_id,
      usuario_id: input.usuario_id,
      motivo: input.observacoes,
    });
  }
  return { origem_id };
}

/**
 * Categorias estruturadas pra ajuste manual. Pareada com o enum SQL
 * `wms_motivo_categoria_enum` (migration `20260527_ajuste_manual_motivo_categoria`).
 */
export type MotivoCategoria =
  | "avaria"
  | "perda"
  | "achado"
  | "correcao_inventario"
  | "devolucao_sem_fluxo"
  | "outro";

export interface AjusteManualInput {
  tripla: Tripla;
  qty: number;
  motivo: string;
  /** Categoria estruturada — obrigatória pra ajuste manual. */
  motivo_categoria: MotivoCategoria;
  direcao: "entrada" | "saida";
  usuario_id: string;
}

/**
 * Ajuste manual de saldo numa tripla. `motivo` é obrigatório (>=3 chars) e
 * `motivo_categoria` precisa ser uma das 6 categorias estruturadas — ajuste
 * sem justificativa ou sem categoria não passa.
 */
export async function ajustarEstoque(input: AjusteManualInput): Promise<void> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo do ajuste é obrigatório (≥3 caracteres)");
  }
  if (!input.motivo_categoria) {
    throw new Error("motivo_categoria do ajuste é obrigatório");
  }
  await inserirMovimentacao({
    tripla: input.tripla,
    tipo: input.direcao === "entrada" ? "E" : "S",
    qty: input.qty,
    origem_tipo: "ajuste_manual",
    origem_detalhes: { direcao: input.direcao },
    motivo: input.motivo.trim(),
    motivo_categoria: input.motivo_categoria,
    usuario_id: input.usuario_id,
  });
}

export interface LancamentoRetroativoInput {
  tripla: Tripla;
  qty: number;
  motivo: string;
  usuario_id: string;
  /** Tag histórica: empresa compradora da NF que não chegou. */
  empresa_compradora_id?: string | null;
  /** Custo unitário (alimenta recálculo do custo médio global). */
  custo_unitario?: number;
  fornecedor_id?: string | null;
  /** Pedido associado (opcional — quando o retroativo vem dum pedido específico). */
  pedido_id?: string | null;
}

/**
 * Lançamento retroativo: registra uma entrada que "já aconteceu" mas não
 * foi capturada no momento. Origem `lancamento_retroativo` permite
 * reconciliar depois quando a NF/compra real chegar.
 */
export async function lancarRetroativo(
  input: LancamentoRetroativoInput,
): Promise<void> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo do lançamento retroativo é obrigatório (≥3 caracteres)");
  }
  await inserirMovimentacao({
    tripla: input.tripla,
    tipo: "E",
    qty: input.qty,
    origem_tipo: "lancamento_retroativo",
    pedido_id: input.pedido_id ?? null,
    empresa_compradora_id: input.empresa_compradora_id ?? null,
    fornecedor_id: input.fornecedor_id ?? null,
    custo_unitario: input.custo_unitario,
    motivo: input.motivo.trim(),
    usuario_id: input.usuario_id,
  });
}

interface RetroativoPendente {
  id: string;
  criado_em: string;
  quantidade: number;
  observacoes: string | null;
  origem_detalhes: Record<string, unknown>;
  motivo: string | null;
  custo_unitario: number | null;
  produto: { sku: string; descricao: string } | null;
  galpao: { nome: string } | null;
  localizacao: { codigo: string } | null;
  // Tags 3D: compradora histórica (NF que não chegou) e fornecedor.
  compradora: { nome: string } | null;
  fornecedor: { nome: string } | null;
}

export async function listarRetroativosPendentes(): Promise<RetroativoPendente[]> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_movimentacoes")
    .select(
      `
        id, criado_em, quantidade, observacoes, origem_detalhes,
        motivo, custo_unitario,
        produto:siso_produtos(sku, descricao),
        galpao:siso_galpoes(nome),
        localizacao:siso_localizacoes(codigo),
        compradora:siso_empresas!empresa_compradora_id(nome),
        fornecedor:siso_fornecedores(nome)
      `,
    )
    .eq("origem_tipo", "lancamento_retroativo")
    .order("criado_em", { ascending: false })
    .limit(200);
  if (error) throw error;
  const rows = (data ?? []) as unknown as RetroativoPendente[];
  if (rows.length === 0) return [];
  const ids = rows.map((d) => d.id);
  const { data: estornos } = await sb
    .from("siso_movimentacoes")
    .select("estorno_de")
    .in("estorno_de", ids);
  const estornados = new Set(
    (estornos ?? [])
      .map((e) => (e as { estorno_de: string | null }).estorno_de)
      .filter((x): x is string => !!x),
  );
  return rows.filter((d) => !estornados.has(d.id));
}

export interface ReconciliarRetroativoInput {
  retroativo_mov_id: string;
  compra_mov_id: string;
  usuario_id: string;
}

export async function reconciliarRetroativo(
  input: ReconciliarRetroativoInput,
): Promise<void> {
  const sb = createServiceClient();
  const { data: retro, error } = await sb
    .from("siso_movimentacoes")
    .select("*")
    .eq("id", input.retroativo_mov_id)
    .single();
  if (error || !retro) throw new Error("lançamento retroativo não encontrado");
  const m = retro as Movimentacao;
  if (m.origem_tipo !== "lancamento_retroativo") {
    throw new Error("mov não é um lançamento retroativo");
  }
  await inserirMovimentacao({
    tripla: {
      produto_id: m.produto_id,
      galpao_id: m.galpao_id,
      localizacao_id: m.localizacao_id,
    },
    tipo: "S",
    qty: Number(m.quantidade),
    origem_tipo: "estorno",
    estorno_de: m.id,
    usuario_id: input.usuario_id,
    motivo: `reconciliado com mov ${input.compra_mov_id}`,
  });
  logger.info("wms.movs", "lançamento retroativo reconciliado", {
    retro: m.id,
    compra: input.compra_mov_id,
  });
}
