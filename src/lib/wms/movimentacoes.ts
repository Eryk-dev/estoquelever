import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao, estornarMovimentacao } from "./ledger";
import type { Quadrupla, Movimentacao, OrigemTipo } from "./types";
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
  empresa_dona_id: string;
  galpao_id: string;
  itens: ItemRecebimento[];
  nf_referencia?: string;
  usuario_id: string;
  /**
   * ISO timestamp da data do recebimento. Se omitido, usa now().
   * Permite lançamento retroativo direto pelo modal de Receber sem fluxo
   * separado em /wms/retroativos.
   */
  data_recebimento?: string;
  /**
   * Tipo de origem. Default "compra_manual". O modal de Receber pode passar
   * "lancamento_retroativo" (data no passado) ou "nf_devolucao_cliente"
   * (devolução). Não validamos contra OrigemTipo aqui — o RPC do ledger
   * aceita qualquer string e a constraint da tabela rejeita inválidos.
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
 */
export async function receberEstoque(
  input: ReceberInput,
): Promise<ReceberResult> {
  const origemTipo = input.origem_tipo ?? "compra_manual";
  const obsBase =
    input.observacoes ??
    (input.nf_referencia
      ? `recebimento NF ${input.nf_referencia}`
      : "recebimento sem NF");
  const loteId = crypto.randomUUID();

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
        quadrupla: {
          produto_id: item.produto_id,
          empresa_dona_id: input.empresa_dona_id,
          galpao_id: input.galpao_id,
          localizacao_id: item.localizacao_destino_id!,
        },
        tipo: "E",
        qty: item.qty,
        origem_tipo: origemTipo,
        origem_id: loteId,
        origem_detalhes: {
          nf_referencia: input.nf_referencia,
          entrada_direta: true,
        },
        custo_unitario: item.custo_unitario,
        usuario_id: input.usuario_id,
        observacoes: obsBase,
        criado_em: input.data_recebimento,
      });
      if (item.custo_unitario !== undefined) {
        await recalcularCustoMedio(
          {
            produto_id: item.produto_id,
            empresa_dona_id: input.empresa_dona_id,
            galpao_id: input.galpao_id,
            localizacao_id: item.localizacao_destino_id!,
          },
          item.qty,
          item.custo_unitario,
        );
      }
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
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_dona_id,
        galpao_id: input.galpao_id,
        localizacao_id: localizacaoRecebimentoId,
      },
      tipo: "E",
      qty: item.qty,
      origem_tipo: origemTipo,
      origem_detalhes: { nf_referencia: input.nf_referencia },
      custo_unitario: item.custo_unitario,
      usuario_id: input.usuario_id,
      observacoes: obsBase,
      criado_em: input.data_recebimento,
    });
    if (item.custo_unitario !== undefined) {
      await recalcularCustoMedio(
        {
          produto_id: item.produto_id,
          empresa_dona_id: input.empresa_dona_id,
          galpao_id: input.galpao_id,
          localizacao_id: localizacaoRecebimentoId,
        },
        item.qty,
        item.custo_unitario,
      );
    }
    // Defense-in-depth: se algo na criação da pendência falhar (FK quebrada,
    // race de loc destino desativada entre validação e insert, falha de
    // rede com supabase), estorna a mov da entrada pra não deixar saldo
    // órfão na RECEBIMENTO sem pendência associada (bug 2026-05-19).
    try {
      const pendenciaId = await criarPendencia({
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_dona_id,
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
      });
      pendenciaIds.push(pendenciaId);
      movIds.push(mov.id);
    } catch (err) {
      try {
        await estornarMovimentacao({
          mov_id: mov.id,
          usuario_id: input.usuario_id,
          observacoes: `Estorno automático: criação de pendência de guarda falhou (${err instanceof Error ? err.message : String(err)})`,
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

/**
 * Recalcula custo médio (média ponderada) ao adicionar uma entrada com custo conhecido.
 * Exportado pra uso em outros fluxos (ex: devolução íntegra recalcula custo no Plano 5).
 *
 * Trade-off conhecido: leitura+escrita em duas chamadas (sem lock). Aceitável pra v1
 * porque custo_medio é informativo e racing entre 2 entradas simultâneas pra mesma
 * quádrupla é raro na operação real.
 */
export async function recalcularCustoMedio(
  q: Quadrupla,
  qtyEntrada: number,
  custoNovo: number,
): Promise<void> {
  const sb = createServiceClient();
  const { data: e } = await sb
    .from("siso_estoque")
    .select("saldo, custo_medio")
    .match(q)
    .single();
  if (!e) return;
  const saldoAnterior = Number(e.saldo) - qtyEntrada;
  if (saldoAnterior < 0) return;
  const custoAnterior = Number(e.custo_medio);
  const novoCusto =
    saldoAnterior > 0
      ? (saldoAnterior * custoAnterior + qtyEntrada * custoNovo) /
        (saldoAnterior + qtyEntrada)
      : custoNovo;
  await sb.from("siso_estoque").update({ custo_medio: novoCusto }).match(q);
}

export interface TransferirGalpaoInput {
  empresa_id: string;
  galpao_origem_id: string;
  localizacao_origem_id: string;
  galpao_destino_id: string;
  localizacao_destino_id: string;
  itens: { produto_id: string; qty: number }[];
  usuario_id: string;
  observacoes?: string;
}

export async function transferirInterGalpao(
  input: TransferirGalpaoInput,
): Promise<{ origem_id: string }> {
  if (input.galpao_origem_id === input.galpao_destino_id) {
    throw new Error(
      "transferência inter-galpão exige galpões diferentes (use replenishment)",
    );
  }
  const origem_id = crypto.randomUUID();
  for (const item of input.itens) {
    await inserirMovimentacao({
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_id,
        galpao_id: input.galpao_origem_id,
        localizacao_id: input.localizacao_origem_id,
      },
      tipo: "S",
      qty: item.qty,
      origem_tipo: "transferencia_galpao",
      origem_id,
      usuario_id: input.usuario_id,
      observacoes: input.observacoes,
    });
    await inserirMovimentacao({
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_id,
        galpao_id: input.galpao_destino_id,
        localizacao_id: input.localizacao_destino_id,
      },
      tipo: "E",
      qty: item.qty,
      origem_tipo: "transferencia_galpao",
      origem_id,
      usuario_id: input.usuario_id,
      observacoes: input.observacoes,
    });
  }
  return { origem_id };
}

export interface ReplenishmentInput {
  empresa_id: string;
  galpao_id: string;
  localizacao_origem_id: string;
  localizacao_destino_id: string;
  itens: { produto_id: string; qty: number }[];
  usuario_id: string;
}

export function validarTransferenciaIntraGalpao(input: {
  localizacao_origem_id: string;
  localizacao_destino_id: string;
}): void {
  if (input.localizacao_origem_id === input.localizacao_destino_id) {
    throw new Error("origem e destino não podem ser a mesma localização");
  }
}

export async function replenishmentIntraGalpao(
  input: ReplenishmentInput,
): Promise<{ origem_id: string }> {
  validarTransferenciaIntraGalpao(input);
  const origem_id = crypto.randomUUID();
  for (const item of input.itens) {
    await inserirMovimentacao({
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_id,
        galpao_id: input.galpao_id,
        localizacao_id: input.localizacao_origem_id,
      },
      tipo: "S",
      qty: item.qty,
      origem_tipo: "transferencia_localizacao",
      origem_id,
      usuario_id: input.usuario_id,
    });
    await inserirMovimentacao({
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_id,
        galpao_id: input.galpao_id,
        localizacao_id: input.localizacao_destino_id,
      },
      tipo: "E",
      qty: item.qty,
      origem_tipo: "transferencia_localizacao",
      origem_id,
      usuario_id: input.usuario_id,
    });
  }
  return { origem_id };
}

export interface AjusteManualInput {
  quadrupla: Quadrupla;
  qty: number;
  motivo: string;
  direcao: "entrada" | "saida";
  usuario_id: string;
}

export async function ajustarEstoque(input: AjusteManualInput): Promise<void> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo do ajuste é obrigatório (≥3 caracteres)");
  }
  await inserirMovimentacao({
    quadrupla: input.quadrupla,
    tipo: input.direcao === "entrada" ? "E" : "S",
    qty: input.qty,
    origem_tipo: "ajuste_manual",
    origem_detalhes: { motivo: input.motivo, direcao: input.direcao },
    usuario_id: input.usuario_id,
    observacoes: input.motivo,
  });
}

export interface LancamentoRetroativoInput {
  quadrupla: Quadrupla;
  qty: number;
  fornecedor_id?: string;
  pedido_id?: string;
  motivo: string;
  usuario_id: string;
}

export async function lancarRetroativo(
  input: LancamentoRetroativoInput,
): Promise<void> {
  await inserirMovimentacao({
    quadrupla: input.quadrupla,
    tipo: "E",
    qty: input.qty,
    origem_tipo: "lancamento_retroativo",
    origem_id: input.pedido_id,
    origem_detalhes: { motivo: input.motivo, fornecedor_id: input.fornecedor_id },
    usuario_id: input.usuario_id,
    observacoes: `emergência: ${input.motivo}`,
  });
}

interface RetroativoPendente {
  id: string;
  criado_em: string;
  quantidade: number;
  observacoes: string | null;
  origem_detalhes: Record<string, unknown>;
  produto: { sku: string; descricao: string } | null;
  empresa: { nome: string } | null;
  galpao: { nome: string } | null;
  localizacao: { codigo: string } | null;
}

export async function listarRetroativosPendentes(): Promise<RetroativoPendente[]> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_movimentacoes")
    .select(
      `
        id, criado_em, quantidade, observacoes, origem_detalhes,
        produto:siso_produtos(sku, descricao),
        empresa:siso_empresas!empresa_dona_id(nome),
        galpao:siso_galpoes(nome),
        localizacao:siso_localizacoes(codigo)
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
    quadrupla: {
      produto_id: m.produto_id,
      empresa_dona_id: m.empresa_dona_id,
      galpao_id: m.galpao_id,
      localizacao_id: m.localizacao_id,
    },
    tipo: "S",
    qty: Number(m.quantidade),
    origem_tipo: "estorno",
    estorno_de: m.id,
    usuario_id: input.usuario_id,
    observacoes: `reconciliado com mov ${input.compra_mov_id}`,
  });
  logger.info("wms.movs", "lançamento retroativo reconciliado", {
    retro: m.id,
    compra: input.compra_mov_id,
  });
}
