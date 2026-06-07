import type { TipoMov, OrigemTipo, Tripla, Movimentacao } from "./types";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

// Regex padrão pra uuid v1-v5 (case-insensitive). Aceita undefined/null/string vazia
// (callers podem omitir o campo). Throw se não-vazio e não-uuid.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuidLike(value: unknown, fieldName: string): void {
  if (value === null || value === undefined || value === "") return;
  if (typeof value !== "string" || !UUID_REGEX.test(value)) {
    throw new Error(
      `inserirMovimentacao: ${fieldName} esperava uuid mas recebeu ${typeof value === "string" ? `"${value}"` : typeof value}. ` +
      `Provável causa: passou um ID text (ex: siso_pedidos.id) em campo uuid. ` +
      `Use origem_detalhes pra preservar valores text não-uuid.`,
    );
  }
}

interface CalcInput {
  tipo: TipoMov;
  qty: number;
  saldoAnterior: number;
  reservadoAnterior: number;
}

export function calcularPosteriores(input: CalcInput): {
  saldo_posterior: number;
  reservado_posterior: number;
} {
  const { tipo, qty, saldoAnterior, reservadoAnterior } = input;
  switch (tipo) {
    case "E":
      return { saldo_posterior: saldoAnterior + qty, reservado_posterior: reservadoAnterior };
    case "S":
      return { saldo_posterior: saldoAnterior - qty, reservado_posterior: reservadoAnterior };
    case "R":
      return { saldo_posterior: saldoAnterior, reservado_posterior: reservadoAnterior + qty };
    case "L":
      return { saldo_posterior: saldoAnterior, reservado_posterior: reservadoAnterior - qty };
  }
}

export function validarCoerencia(input: CalcInput): void {
  const { tipo, qty, saldoAnterior, reservadoAnterior } = input;
  if (qty <= 0) throw new Error("qty deve ser > 0");

  const { saldo_posterior, reservado_posterior } = calcularPosteriores(input);

  if (saldo_posterior < 0) {
    throw new Error(`saldo insuficiente: anterior=${saldoAnterior} qty=${qty} tipo=${tipo}`);
  }
  if (reservado_posterior < 0) {
    throw new Error(
      `não pode liberar mais do que está reservado: reservado=${reservadoAnterior} qty=${qty}`,
    );
  }
  if (reservado_posterior > saldo_posterior) {
    throw new Error(
      `reservado (${reservado_posterior}) excederia saldo (${saldo_posterior})`,
    );
  }
}

interface InserirMovInput {
  tripla: Tripla;
  tipo: TipoMov;
  qty: number;
  origem_tipo: OrigemTipo;
  origem_id?: string;
  origem_detalhes?: Record<string, unknown>;
  /** Tags de empresa (metadata, não chave de coordenada). */
  empresa_compradora_id?: string | null;
  empresa_vendedora_id?: string | null;
  empresa_referencia_id?: string | null;
  /** Fornecedor associado (ex: nf_compra, devolucao_fornecedor_*). */
  fornecedor_id?: string | null;
  /** Motivo livre — usado por ajuste_manual, devolucao_*, inventario_*. */
  motivo?: string | null;
  /** Cliente associado (ex: devolucao_cliente_*). */
  cliente_nome?: string | null;
  /** Pedido associado (FK lógica pra siso_pedidos.id — text, aceita Tiny ID ou `MAN-...`). */
  pedido_id?: string | null;
  /** NF fiscal associada (uuid em siso_notas_fiscais). */
  nota_fiscal_id?: string | null;
  /** Chave de acesso (44 dígitos) da NF — backup quando nota_fiscal_id ainda não foi populado. */
  chave_acesso_nf?: string | null;
  /** Expiração da reserva (tipo R apenas). */
  expira_em?: string;
  /** Custo unitário da entrada — alimenta recálculo do custo médio global. */
  custo_unitario?: number;
  /** Categoria estruturada do motivo (obrigatório quando origem_tipo='ajuste_manual'). */
  motivo_categoria?:
    | "avaria"
    | "perda"
    | "achado"
    | "correcao_inventario"
    | "devolucao_sem_fluxo"
    | "outro";
  usuario_id?: string;
  estorno_de?: string;
  /** FK pra siso_devolucoes_pendentes — populado por classificarDevolucao pra
   *  lookup determinístico em desclassificarDevolucao (elimina window temporal). */
  devolucao_id?: string | null;
}

/**
 * Insere uma movimentação no ledger E atualiza siso_estoque, atomicamente,
 * com lock pessimista via RPC (SELECT FOR UPDATE no Postgres).
 *
 * Toda escrita no ledger DEVE passar por aqui — garante chain verificável
 * e protege contra race conditions entre operações concorrentes.
 */
export async function inserirMovimentacao(input: InserirMovInput): Promise<Movimentacao> {
  const { tripla, tipo, qty } = input;

  // Validação defensiva: campos uuid devem ser uuid (ou null/undefined).
  // PostgrestError em uuid inválido vira "[object Object]" no log — caro de
  // debugar. Capturamos antes de chegar na RPC com mensagem clara.
  // IMPORTANTE: roda ANTES de createServiceClient() pra ser testável sem env.
  // NOTA: `origem_id` e `pedido_id` são DELIBERADAMENTE text (colunas
  // `siso_movimentacoes.origem_id` / `pedido_id` são text por design — migration
  // 20260526_movimentacoes_origem_id_pedido_id_text.sql). Convenção: quando
  // origem_tipo ∈ {reserva_pedido, liberacao_reserva}, origem_id carrega
  // `siso_pedidos.id` (Tiny ID, text). `pedido_id` também aceita ID de pedido
  // manual `MAN-...`. Não validamos uuid em nenhum dos dois.
  assertUuidLike(tripla.produto_id, "tripla.produto_id");
  assertUuidLike(tripla.galpao_id, "tripla.galpao_id");
  assertUuidLike(tripla.localizacao_id, "tripla.localizacao_id");
  assertUuidLike(input.estorno_de, "estorno_de");
  assertUuidLike(input.empresa_compradora_id, "empresa_compradora_id");
  assertUuidLike(input.empresa_vendedora_id, "empresa_vendedora_id");
  assertUuidLike(input.empresa_referencia_id, "empresa_referencia_id");
  assertUuidLike(input.fornecedor_id, "fornecedor_id");
  // pedido_id intencionalmente NÃO validado — text por design.
  assertUuidLike(input.nota_fiscal_id, "nota_fiscal_id");
  assertUuidLike(input.usuario_id, "usuario_id");
  assertUuidLike(input.devolucao_id, "devolucao_id");

  // Fix-Final A T8 (R5) — RELAXADO em 2026-05-27 pós-suite-falha (Fix-A hotfix):
  // a versão original throw fazia /receber, /parcial e callers legacy retornar
  // 500 porque populam nota_fiscal_id=null legitimamente (recebimento manual sem NF,
  // separação parcial, lançamento retroativo). Enforcement movido pros webhook
  // handlers (nf-webhook-handler + webhook-processor) onde NF realmente existe.
  // Aqui ficou só warn — observabilidade sem quebrar callers existentes.
  const NF_REQUIRED = new Set<OrigemTipo>([
    "nf_compra",
    "nf_venda",
    "devolucao_cliente_integra",
    "devolucao_cliente_avariada",
    "devolucao_fornecedor_recebida",
    "devolucao_fornecedor_enviada",
  ]);
  if (NF_REQUIRED.has(input.origem_tipo) && !input.nota_fiscal_id) {
    logger.warn(
      "wms/ledger",
      `mov origem_tipo='${input.origem_tipo}' sem nota_fiscal_id — webhook handlers devem popular via upsertNotaFiscal()`,
      { origem_tipo: input.origem_tipo, produto_id: input.tripla?.produto_id, qty: input.qty },
    );
  }

  const sb = createServiceClient();

  // Validação client-side (early fail; RPC valida de novo no DB com FOR UPDATE)
  const { data: estoqueAtual } = await sb
    .from("siso_estoque")
    .select("saldo, reservado")
    .match(tripla)
    .maybeSingle();
  validarCoerencia({
    tipo,
    qty,
    saldoAnterior: Number(estoqueAtual?.saldo ?? 0),
    reservadoAnterior: Number(estoqueAtual?.reservado ?? 0),
  });

  // RPC retorna apenas o uuid da movimentação criada. Carregamos a linha
  // completa em seguida pra manter compat com o tipo `Movimentacao`.
  const { data: movId, error } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: tripla.produto_id,
    p_galpao_id: tripla.galpao_id,
    p_localizacao_id: tripla.localizacao_id,
    p_tipo: tipo,
    p_quantidade: qty,
    p_origem_tipo: input.origem_tipo,
    p_origem_id: input.origem_id ?? null,
    p_origem_detalhes: input.origem_detalhes ?? null,
    p_usuario_id: input.usuario_id ?? null,
    p_expira_em: input.expira_em ?? null,
    p_estorno_de: input.estorno_de ?? null,
    p_empresa_compradora_id: input.empresa_compradora_id ?? null,
    p_empresa_vendedora_id: input.empresa_vendedora_id ?? null,
    p_empresa_referencia_id: input.empresa_referencia_id ?? null,
    p_fornecedor_id: input.fornecedor_id ?? null,
    p_motivo: input.motivo ?? null,
    p_cliente_nome: input.cliente_nome ?? null,
    p_pedido_id: input.pedido_id ?? null,
    p_nota_fiscal_id: input.nota_fiscal_id ?? null,
    p_chave_acesso_nf: input.chave_acesso_nf ?? null,
    p_custo_unitario: input.custo_unitario ?? null,
    p_motivo_categoria: input.motivo_categoria ?? null,
  });
  if (error) {
    // P099/P109: UNIQUE parcial uq_mov_recebimento_nf_chave / _id rejeitou a 2ª
    // entrada da mesma NF de compra (reenvio do integrador / duplo-clique).
    // Idempotente: recarrega e devolve a mov E que já lançou o saldo/custo desta NF.
    // Branch por assinatura disponível: chave_acesso_nf (/api/wms/receber) OU
    // nota_fiscal_id (compras/receber).
    if (
      (error as { code?: string }).code === "23505" &&
      input.origem_tipo === "nf_compra" &&
      (input.chave_acesso_nf || input.nota_fiscal_id)
    ) {
      let q = sb
        .from("siso_movimentacoes")
        .select("*")
        .eq("origem_tipo", "nf_compra")
        .eq("produto_id", tripla.produto_id)
        .eq("galpao_id", tripla.galpao_id)
        .is("estorno_de", null);
      if (input.chave_acesso_nf) {
        q = q.eq("chave_acesso_nf", input.chave_acesso_nf);
      } else if (input.nota_fiscal_id) {
        q = q.eq("nota_fiscal_id", input.nota_fiscal_id);
      }
      const { data: jaLancada } = await q.maybeSingle();
      if (jaLancada) {
        logger.warn("wms.ledger", "recebimento NF duplicado absorvido pelo UNIQUE (idempotente)", {
          chave_acesso_nf: input.chave_acesso_nf ?? null,
          nota_fiscal_id: input.nota_fiscal_id ?? null,
          produto_id: tripla.produto_id,
          mov_id: (jaLancada as { id: string }).id,
        });
        return jaLancada as unknown as Movimentacao;
      }
    }
    logger.error("wms.ledger", "falha ao inserir mov", { error, input });
    throw error;
  }

  const { data: mov, error: errMov } = await sb
    .from("siso_movimentacoes")
    .select("*")
    .eq("id", movId as unknown as string)
    .single();
  if (errMov || !mov) {
    logger.error("wms.ledger", "falha ao recarregar mov", {
      mov_id: movId,
      errMov,
    });
    throw errMov ?? new Error("mov recém-criada não encontrada");
  }

  // Popula devolucao_id via UPDATE-after-insert (não modifica a RPC).
  // Lookup determinístico em desclassificarDevolucao usa este FK.
  if (input.devolucao_id && (mov as { id: string }).id) {
    await sb
      .from("siso_movimentacoes")
      .update({ devolucao_id: input.devolucao_id })
      .eq("id", (mov as { id: string }).id);
  }

  // Decisão 5 (28/05): toda entrada de saldo (mov E) varre pedidos em
  // validacao_oc desse produto+galpão pra marcar flag_saldo_apareceu, e
  // atualiza snapshot de pedidos em separação aberta. Fire-and-forget pra
  // não bloquear a transação. Lazy import pra evitar cycle ledger ↔ varredura.
  if (
    tipo === "E" &&
    tripla.localizacao_id &&
    tripla.produto_id &&
    tripla.galpao_id
  ) {
    void (async () => {
      try {
        const { varrerPedidosAfetadosPorEntrada } = await import(
          "./varredura-validacao-oc"
        );
        await varrerPedidosAfetadosPorEntrada({
          produto_id: tripla.produto_id,
          galpao_id: tripla.galpao_id,
          localizacao_id: tripla.localizacao_id,
        });
        // Reconciliador OC: devolve ao picking pedidos parados por falta cujo
        // saldo livre agora cobre (FIFO). Fire-and-forget; erros não fatais.
        const { reconciliarEntradaEstoque } = await import("./reconciliador-oc");
        await reconciliarEntradaEstoque({
          produtoId: tripla.produto_id,
          galpaoId: tripla.galpao_id,
        });
      } catch (err) {
        // P082/P149: a varredura/reconciliação inline falhou (transitório de
        // banco). Antes só logava e desistia — pedido OC ficava preso e o banner
        // "saldo apareceu" nunca surgia. Agora enfileira um job durável (retry
        // 30s/5min/10min no worker) pra reexecutar a varredura.
        logger.warn("ledger", "varredura pós-entrada falhou inline — enfileirando job durável", {
          error: err instanceof Error ? err.message : String(err),
        });
        const { enfileirarJobManutencao } = await import("./jobs-manutencao");
        await enfileirarJobManutencao({
          tipo: "varredura_pos_entrada",
          payload: {
            produto_id: tripla.produto_id,
            galpao_id: tripla.galpao_id,
            localizacao_id: tripla.localizacao_id,
          },
        });
      }
    })();
  }

  return mov as unknown as Movimentacao;
}

/**
 * Vende N unidades de um kit virtual — explode em N saídas dos componentes
 * proporcionais à composição (qty_no_kit × qtyKits por componente).
 *
 * Compartilha origem_id entre todas as movs geradas pra serem rastreáveis
 * como um único evento de venda.
 *
 * Pré-requisitos:
 * - produto na tripla precisa ser um kit (eh_kit=true)
 * - precisa ter composição cadastrada em siso_produto_kits
 * - estoque dos componentes na MESMA galpao+localizacao da tripla do kit
 *   (limitação: kit "vendido" tem que ter os componentes no mesmo local
 *   físico — ou o chamador passa triplas alternativas)
 */
export async function venderKit(input: {
  kit: Tripla;
  qtyKits: number;
  origem_tipo: OrigemTipo;
  origem_id?: string;
  origem_detalhes?: Record<string, unknown>;
  pedido_id?: string | null;
  nota_fiscal_id?: string | null;
  empresa_vendedora_id?: string | null;
  custo_unitario?: number;
  usuario_id?: string;
  motivo?: string;
}): Promise<Movimentacao[]> {
  if (input.qtyKits <= 0) {
    throw new Error("qtyKits deve ser positivo");
  }
  const sb = createServiceClient();

  const { data: prod } = await sb
    .from("siso_produtos")
    .select("eh_kit, sku")
    .eq("id", input.kit.produto_id)
    .maybeSingle();
  if (!prod) throw new Error("kit não encontrado");
  if (!(prod as { eh_kit: boolean }).eh_kit) {
    throw new Error("Produto não é um kit");
  }

  const { data: composicao } = await sb
    .from("siso_produto_kits")
    .select("componente_produto_id, quantidade")
    .eq("kit_produto_id", input.kit.produto_id);
  if (!composicao || composicao.length === 0) {
    throw new Error("kit sem composição cadastrada");
  }

  const origemId = input.origem_id ?? crypto.randomUUID();
  const movs: Movimentacao[] = [];
  for (const c of composicao as Array<{
    componente_produto_id: string;
    quantidade: number;
  }>) {
    const mov = await inserirMovimentacao({
      tripla: {
        ...input.kit,
        produto_id: c.componente_produto_id,
      },
      tipo: "S",
      qty: Number(c.quantidade) * input.qtyKits,
      origem_tipo: input.origem_tipo,
      origem_id: origemId,
      origem_detalhes: {
        ...(input.origem_detalhes ?? {}),
        kit_produto_id: input.kit.produto_id,
        kit_sku: (prod as { sku: string }).sku,
        kit_qty: input.qtyKits,
        kit_componente: true,
      },
      pedido_id: input.pedido_id ?? null,
      nota_fiscal_id: input.nota_fiscal_id ?? null,
      empresa_vendedora_id: input.empresa_vendedora_id ?? null,
      custo_unitario: input.custo_unitario,
      usuario_id: input.usuario_id,
      motivo:
        input.motivo ??
        `Venda de ${input.qtyKits} kit ${(prod as { sku: string }).sku}`,
    });
    movs.push(mov);
  }
  return movs;
}

/**
 * Estorna uma movimentação anterior gerando uma nova com tipo invertido
 * (E↔S, R↔L) e origem_tipo='estorno' + estorno_de=mov_id.
 *
 * Valida que a movimentação original:
 * - existe
 * - não é ela mesma um estorno (estorno_de não null)
 * - ainda não foi estornada (não existe outra mov com estorno_de = mov_id)
 */
export async function estornarMovimentacao(input: {
  mov_id: string;
  usuario_id: string;
  motivo?: string;
}): Promise<Movimentacao> {
  const sb = createServiceClient();

  const { data: original } = await sb
    .from("siso_movimentacoes")
    .select("*")
    .eq("id", input.mov_id)
    .single();
  if (!original) throw new Error(`mov ${input.mov_id} não encontrada`);
  if (original.estorno_de)
    throw new Error(`mov ${input.mov_id} já é um estorno (estorno_de=${original.estorno_de})`);

  const { data: existente } = await sb
    .from("siso_movimentacoes")
    .select("id")
    .eq("estorno_de", input.mov_id)
    .maybeSingle();
  if (existente) throw new Error(`mov ${input.mov_id} já foi estornada (estorno id=${existente.id})`);

  // Defense-in-depth: full estorno exige qty_estornada=0. Estorno parcial prévio
  // bloqueia o full — use wms_estornar_parcial_movimentacao pro residual.
  if (Number(original.qty_estornada ?? 0) > 0) {
    throw new Error(
      `mov ${input.mov_id} tem qty_estornada=${original.qty_estornada} (>0). Use wms_estornar_parcial_movimentacao para estornar o residual.`,
    );
  }

  const tipoMap: Record<string, TipoMov> = { E: "S", S: "E", R: "L", L: "R" };
  const tipoInverso = tipoMap[original.tipo as string];
  if (!tipoInverso)
    throw new Error(`tipo desconhecido na mov original: ${original.tipo}`);

  try {
    return await inserirMovimentacao({
      tripla: {
        produto_id: original.produto_id,
        galpao_id: original.galpao_id,
        localizacao_id: original.localizacao_id,
      },
      tipo: tipoInverso,
      qty: Number(original.quantidade),
      origem_tipo: "estorno",
      origem_id: input.mov_id,
      origem_detalhes: {
        estorno_de: input.mov_id,
        mov_original_origem: original.origem_tipo,
      },
      motivo: input.motivo ?? `Estorno de mov ${input.mov_id}`,
      usuario_id: input.usuario_id,
      estorno_de: input.mov_id,
    });
  } catch (err) {
    // Backstop de concorrência: o pré-guard acima é TOCTOU. Sob 2 estornos
    // simultâneos da mesma mov, o UNIQUE parcial uq_mov_estorno_unico (P106)
    // mata o 2º INSERT com 23505. Tratamos como idempotente: recarregamos e
    // devolvemos o estorno já gravado em vez de propagar erro.
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      const { data: jaEstornada } = await sb
        .from("siso_movimentacoes")
        .select("*")
        .eq("estorno_de", input.mov_id)
        .maybeSingle();
      if (jaEstornada) {
        logger.warn("wms.ledger", "estorno duplicado absorvido pelo UNIQUE (idempotente)", {
          mov_id: input.mov_id,
          estorno_id: (jaEstornada as { id: string }).id,
        });
        return jaEstornada as unknown as Movimentacao;
      }
    }
    throw err;
  }
}
