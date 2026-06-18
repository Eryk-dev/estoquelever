/**
 * Serviço de Troca de Equivalência (plano 2026-06-12-cross-troca-equivalencia).
 *
 * Entidade única `siso_trocas_equivalencia` com 3 superfícies (painel de
 * pedidos, chão de separação, compras). Mecânica:
 *
 *   solicitarTroca  → valida item/pedido, aplica `regraTroca` (pura), cria a
 *                     solicitação + RESERVA FORTE no substituto (R
 *                     origem_tipo='reserva_troca', TTL 48h — D6). Se a regra
 *                     der 'livre' (mesmo tier + par verificado), aprova na
 *                     hora (auto-troca, zero humano).
 *   aprovarTroca    → libera as R vivas do produto VENDIDO deste item
 *                     (precedente P2-CMP-04 do confirmar-equivalente) e chama
 *                     a RPC wms_aprovar_troca_atomico (converte reserva_troca
 *                     → reserva_pedido + seta substituto no item, tudo-ou-nada).
 *   rejeitarTroca / cancelarTroca → RPC wms_encerrar_troca_atomico (libera as
 *                     R de troca remanescentes + fecha a solicitação).
 *
 * O item NUNCA muda `produto_id` (tiny — camada fiscal/NF intocada, D3).
 * O produto FÍSICO passa a ser `produto_wms_substituto_id`; resolução via
 * `resolverProdutoEfetivoDoItem` (wms-mapping).
 */

import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";
import { inserirMovimentacao } from "./ledger";
import { estornarReservaIndividual } from "./reservas";
import { resolverRealocacao } from "@/lib/separacao/realocacao-resolver";
import { resolverProdutoWmsFlex } from "@/lib/separacao/wms-mapping";
import {
  regraTroca,
  type ParVerificacao,
  type TierQualidade,
  type TrocaTipo,
} from "./trocas-equivalencia-regra";

const TTL_RESERVA_TROCA_HORAS = 48;

export type TrocaStatus =
  | "pendente"
  | "aprovada"
  | "rejeitada"
  | "expirada"
  | "cancelada";

export type TrocaOrigem = "roteamento" | "separacao" | "compras" | "painel";

export interface TrocaEquivalencia {
  id: string;
  pedido_id: string;
  pedido_item_id: number;
  galpao_id: string;
  produto_vendido_id: string;
  produto_substituto_id: string;
  sku_vendido: string;
  sku_substituto: string;
  quantidade: number;
  tipo: TrocaTipo;
  origem_solicitacao: TrocaOrigem;
  status: TrocaStatus;
  tier_vendido_snapshot: TierQualidade | null;
  tier_substituto_snapshot: TierQualidade | null;
  reserva_mov_ids: string[] | null;
  solicitado_por: string | null;
  solicitado_em: string;
  decidido_por: string | null;
  decidido_em: string | null;
  motivo_rejeicao: string | null;
}

/** Erro de negócio com código estável pra rota mapear em HTTP. */
export class TrocaError extends Error {
  constructor(
    public code:
      | "ITEM_NAO_ENCONTRADO"
      | "PEDIDO_NAO_ENCONTRADO"
      | "PEDIDO_ESTADO_INVALIDO"
      | "ITEM_JA_SEPARADO"
      | "TROCA_JA_APLICADA"
      | "TROCA_PENDENTE_EXISTE"
      | "SUBSTITUTO_NAO_ENCONTRADO"
      | "SUBSTITUTO_IGUAL_VENDIDO"
      | "SUBSTITUTO_IGUAL_ATUAL"
      | "PRODUTO_VENDIDO_NAO_MAPEADO"
      | "PAR_BLOQUEADO"
      | "SEM_SALDO_SUBSTITUTO"
      | "GALPAO_INDETERMINADO"
      | "TROCA_NAO_ENCONTRADA"
      | "TROCA_NAO_PENDENTE",
    message: string,
  ) {
    super(message);
    this.name = "TrocaError";
  }
}

/**
 * Status do par (sku_a, sku_b) na curadoria — par normalizado lexicográfico
 * (mesma convenção de siso_produto_links / siso_equivalencias_verificadas).
 */
export async function buscarParVerificacao(
  skuA: string,
  skuB: string,
): Promise<ParVerificacao> {
  const sb = createServiceClient();
  const [a, b] = [skuA, skuB].sort();
  const { data } = await sb
    .from("siso_equivalencias_verificadas")
    .select("status")
    .eq("sku_a", a)
    .eq("sku_b", b)
    .maybeSingle();
  return (data?.status as ParVerificacao) ?? null;
}

/**
 * Libera as R VIVAS (sem L apontando) do produto informado neste pedido.
 * Mesmo algoritmo de P2-CMP-04 (confirmar-equivalente): só o produto do item,
 * nunca o pedido inteiro. Idempotente (estornarReservaIndividual).
 */
async function liberarReservasVivasDoProduto(args: {
  pedido_id: string;
  produto_wms_id: string;
  usuario_id: string;
  source: string;
}): Promise<number> {
  const sb = createServiceClient();
  const { data: reservas, error } = await sb
    .from("siso_movimentacoes")
    .select("id")
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .eq("origem_id", args.pedido_id)
    .eq("produto_id", args.produto_wms_id);
  if (error) {
    logger.warn(args.source, "falha buscando R do produto vendido (segue)", {
      pedido_id: args.pedido_id,
      error: error.message,
    });
    return 0;
  }
  const ids = (reservas ?? []).map((r) => r.id as string);
  if (ids.length === 0) return 0;

  const { data: ls } = await sb
    .from("siso_movimentacoes")
    .select("estorno_de")
    .eq("tipo", "L")
    .in("estorno_de", ids);
  const liberadas = new Set(
    (ls ?? [])
      .map((l) => l.estorno_de as string | null)
      .filter((x): x is string => !!x),
  );

  let count = 0;
  for (const id of ids) {
    if (liberadas.has(id)) continue;
    try {
      await estornarReservaIndividual({
        reserva_id: id,
        motivo: "outro",
        usuario_id: args.usuario_id,
      });
      count++;
    } catch (e) {
      logger.warn(args.source, "falha estornando R do vendido (segue)", {
        reserva_id: id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return count;
}

export interface SolicitarTrocaInput {
  pedidoItemId: number | string;
  skuSubstituto: string;
  origem: TrocaOrigem;
  usuarioId: string;
  usuarioNome?: string | null;
  /** Override do galpão (roteamento passa explícito; superfícies usam o do pedido). */
  galpaoId?: string;
}

export interface SolicitarTrocaResult {
  troca: TrocaEquivalencia;
  /** true quando a regra deu 'livre' e a troca já foi aplicada (auto). */
  auto: boolean;
}

export async function solicitarTroca(
  input: SolicitarTrocaInput,
): Promise<SolicitarTrocaResult> {
  const sb = createServiceClient();
  const source = "wms.trocas-equivalencia";

  // 1. Item + guards de estado
  const { data: item } = await sb
    .from("siso_pedido_itens")
    .select(
      "id, pedido_id, produto_id, sku, quantidade_pedida, quantidade_pega, produto_wms_substituto_id",
    )
    .eq("id", input.pedidoItemId)
    .maybeSingle();
  if (!item) {
    throw new TrocaError("ITEM_NAO_ENCONTRADO", `item ${input.pedidoItemId} não encontrado`);
  }
  if (item.produto_wms_substituto_id) {
    throw new TrocaError(
      "TROCA_JA_APLICADA",
      "o item já teve troca de equivalente aplicada",
    );
  }

  const { data: pendenteExistente } = await sb
    .from("siso_trocas_equivalencia")
    .select("id")
    .eq("pedido_item_id", item.id)
    .eq("status", "pendente")
    .maybeSingle();
  if (pendenteExistente) {
    throw new TrocaError(
      "TROCA_PENDENTE_EXISTE",
      "já existe troca pendente de aprovação pra este item",
    );
  }

  const { data: pedido } = await sb
    .from("siso_pedidos")
    .select("id, status, status_separacao, empresa_origem_id, separacao_galpao_id")
    .eq("id", item.pedido_id)
    .maybeSingle();
  if (!pedido) {
    throw new TrocaError("PEDIDO_NAO_ENCONTRADO", `pedido ${item.pedido_id} não encontrado`);
  }
  if (!["pendente", "executando"].includes(pedido.status as string)) {
    throw new TrocaError(
      "PEDIDO_ESTADO_INVALIDO",
      `pedido em status '${pedido.status}' não aceita troca`,
    );
  }
  if (
    ["separado", "embalado", "conferido", "expedido"].includes(
      (pedido.status_separacao as string | null) ?? "",
    )
  ) {
    throw new TrocaError(
      "PEDIDO_ESTADO_INVALIDO",
      `pedido já em '${pedido.status_separacao}' — troca não é mais possível`,
    );
  }

  const qtyPedida = Number(item.quantidade_pedida ?? 0);
  const qtyPega = Number(item.quantidade_pega ?? 0);
  const qtyResidual = qtyPedida - qtyPega;
  if (qtyResidual <= 0) {
    throw new TrocaError("ITEM_JA_SEPARADO", "item já totalmente separado — nada a trocar");
  }
  const misto = qtyPega > 0;

  // 2. Galpão: override > pedido > 1º preferencial da empresa
  let galpaoId = input.galpaoId ?? (pedido.separacao_galpao_id as string | null) ?? null;
  if (!galpaoId && pedido.empresa_origem_id) {
    const { data: pref } = await sb
      .from("siso_empresa_galpoes_preferenciais")
      .select("galpao_id")
      .eq("empresa_id", pedido.empresa_origem_id)
      .limit(1)
      .maybeSingle();
    galpaoId = (pref?.galpao_id as string | null) ?? null;
  }
  if (!galpaoId) {
    throw new TrocaError(
      "GALPAO_INDETERMINADO",
      "não foi possível determinar o galpão da troca",
    );
  }

  // 3. Produto vendido (uuid WMS — SKU-first: tiny → SKU). Substituto não entra:
  //    aqui é o produto ORIGINAL vendido (a troca ainda não foi aplicada).
  let produtoVendidoId: string;
  try {
    produtoVendidoId = await resolverProdutoWmsFlex(
      pedido.empresa_origem_id as string,
      { tinyProdutoId: item.produto_id, sku: item.sku },
    );
  } catch {
    throw new TrocaError(
      "PRODUTO_VENDIDO_NAO_MAPEADO",
      `produto Tiny ${item.produto_id} sem mapeamento WMS pra empresa do pedido`,
    );
  }
  const { data: vendido } = await sb
    .from("siso_produtos")
    .select("id, sku, tier_qualidade")
    .eq("id", produtoVendidoId)
    .single();

  // 4. Substituto
  const { data: substituto } = await sb
    .from("siso_produtos")
    .select("id, sku, tier_qualidade")
    .eq("sku", input.skuSubstituto)
    .maybeSingle();
  if (!substituto) {
    throw new TrocaError(
      "SUBSTITUTO_NAO_ENCONTRADO",
      `SKU "${input.skuSubstituto}" não encontrado no catálogo WMS`,
    );
  }
  if (substituto.id === produtoVendidoId) {
    throw new TrocaError("SUBSTITUTO_IGUAL_VENDIDO", "substituto é o próprio produto vendido");
  }

  // 5. Regra (pura)
  const parVerificacao = await buscarParVerificacao(
    vendido?.sku ?? String(item.sku),
    substituto.sku as string,
  );
  const regra = regraTroca({
    tierVendido: (vendido?.tier_qualidade as TierQualidade | null) ?? null,
    tierSubstituto: (substituto.tier_qualidade as TierQualidade | null) ?? null,
    parVerificacao,
    misto,
  });
  if (regra.resultado === "bloqueada") {
    throw new TrocaError(
      "PAR_BLOQUEADO",
      `par ${vendido?.sku} ↔ ${substituto.sku} está BLOQUEADO pra troca (curadoria)`,
    );
  }

  // 6. Cria a solicitação (pendente) — unique parcial protege corrida
  const { data: troca, error: insErr } = await sb
    .from("siso_trocas_equivalencia")
    .insert({
      pedido_id: item.pedido_id,
      pedido_item_id: item.id,
      galpao_id: galpaoId,
      produto_vendido_id: produtoVendidoId,
      produto_substituto_id: substituto.id,
      sku_vendido: vendido?.sku ?? String(item.sku),
      sku_substituto: substituto.sku,
      quantidade: qtyResidual,
      tipo: regra.tipo,
      origem_solicitacao: input.origem,
      tier_vendido_snapshot: vendido?.tier_qualidade ?? null,
      tier_substituto_snapshot: substituto.tier_qualidade ?? null,
      solicitado_por: input.usuarioId,
    })
    .select("*")
    .single();
  if (insErr || !troca) {
    if (insErr?.code === "23505") {
      throw new TrocaError(
        "TROCA_PENDENTE_EXISTE",
        "já existe troca pendente de aprovação pra este item",
      );
    }
    throw new Error(`falha criando troca: ${insErr?.message}`);
  }

  // 7. Reserva FORTE no substituto (D6) — distribuição multi-loc com o mesmo
  // resolver do cascade (picking > overstock, locs bloqueadas fora).
  const resolver = await resolverRealocacao({
    produto_id: substituto.id as string,
    galpao_id: galpaoId,
    qty_residual: qtyResidual,
  });
  if (resolver.status === "sem_cobertura") {
    await sb
      .from("siso_trocas_equivalencia")
      .update({ status: "cancelada", motivo_rejeicao: "sem saldo disponível do substituto" })
      .eq("id", troca.id);
    throw new TrocaError(
      "SEM_SALDO_SUBSTITUTO",
      `substituto ${substituto.sku} sem saldo disponível que cubra ${qtyResidual} un. no galpão`,
    );
  }

  const reservaIds: string[] = [];
  try {
    for (const r of resolver.realocacoes) {
      const mov = await inserirMovimentacao({
        tripla: {
          produto_id: substituto.id as string,
          galpao_id: galpaoId,
          localizacao_id: r.localizacao_id,
        },
        tipo: "R",
        qty: r.quantidade,
        origem_tipo: "reserva_troca",
        origem_id: troca.id as string,
        origem_detalhes: {
          contexto: "solicitacao_troca",
          pedido_id: item.pedido_id,
          pedido_item_id: item.id,
        },
        expira_em: new Date(
          Date.now() + TTL_RESERVA_TROCA_HORAS * 3600 * 1000,
        ).toISOString(),
        pedido_id: String(item.pedido_id),
        motivo: `Reserva de troca equivalência ${vendido?.sku} → ${substituto.sku}`,
        usuario_id: input.usuarioId,
      });
      reservaIds.push(mov.id);
    }
  } catch (e) {
    // Compensa: registra as R já criadas na troca e encerra (RPC libera vivas)
    await sb
      .from("siso_trocas_equivalencia")
      .update({ reserva_mov_ids: reservaIds })
      .eq("id", troca.id);
    await sb.rpc("wms_encerrar_troca_atomico", {
      p_troca_id: troca.id,
      p_usuario_id: input.usuarioId,
      p_status: "cancelada",
      p_motivo: "falha criando reserva do substituto",
    });
    logger.error(source, "falha criando R de troca — solicitação cancelada", {
      troca_id: troca.id,
      error: e instanceof Error ? e.message : String(e),
    });
    throw new TrocaError(
      "SEM_SALDO_SUBSTITUTO",
      "saldo do substituto mudou durante a solicitação — tente de novo",
    );
  }

  const { data: trocaAtualizada } = await sb
    .from("siso_trocas_equivalencia")
    .update({ reserva_mov_ids: reservaIds })
    .eq("id", troca.id)
    .select("*")
    .single();

  // 8. Livre → auto-aplica na hora; senão fica pendente pro aprovador
  if (regra.resultado === "livre") {
    const aprovada = await aprovarTroca({
      trocaId: troca.id as string,
      usuarioId: input.usuarioId,
      usuarioNome: input.usuarioNome,
      auto: true,
    });
    return { troca: aprovada, auto: true };
  }

  await registrarEvento({
    pedidoId: String(item.pedido_id),
    evento: "troca_solicitada",
    usuarioId: input.usuarioId,
    usuarioNome: input.usuarioNome ?? undefined,
    detalhes: {
      troca_id: troca.id,
      sku_vendido: vendido?.sku ?? item.sku,
      sku_substituto: substituto.sku,
      tipo: regra.tipo,
      origem: input.origem,
      quantidade: qtyResidual,
    },
  });

  return { troca: (trocaAtualizada ?? troca) as TrocaEquivalencia, auto: false };
}

export async function aprovarTroca(args: {
  trocaId: string;
  usuarioId: string;
  usuarioNome?: string | null;
  /** true quando veio de auto-troca (regra 'livre') — muda o evento de histórico. */
  auto?: boolean;
}): Promise<TrocaEquivalencia> {
  const sb = createServiceClient();
  const source = "wms.trocas-equivalencia";

  const { data: troca } = await sb
    .from("siso_trocas_equivalencia")
    .select("*")
    .eq("id", args.trocaId)
    .maybeSingle();
  if (!troca) throw new TrocaError("TROCA_NAO_ENCONTRADA", "troca não encontrada");
  if (troca.status !== "pendente") {
    throw new TrocaError("TROCA_NAO_PENDENTE", `troca em status '${troca.status}'`);
  }

  // Libera R vivas do produto VENDIDO deste item ANTES do swap (P2-CMP-04) —
  // idempotente, então retry após falha da RPC é seguro.
  const liberadas = await liberarReservasVivasDoProduto({
    pedido_id: String(troca.pedido_id),
    produto_wms_id: troca.produto_vendido_id as string,
    usuario_id: args.usuarioId,
    source,
  });

  const { data: rpcResult, error: rpcErr } = await sb.rpc("wms_aprovar_troca_atomico", {
    p_troca_id: args.trocaId,
    p_usuario_id: args.usuarioId,
  });
  if (rpcErr) {
    if (rpcErr.message.includes("TROCA_NAO_PENDENTE")) {
      throw new TrocaError("TROCA_NAO_PENDENTE", rpcErr.message);
    }
    throw new Error(`wms_aprovar_troca_atomico falhou: ${rpcErr.message}`);
  }

  logger.info(source, "troca aprovada", {
    troca_id: args.trocaId,
    pedido_id: troca.pedido_id,
    reservas_vendido_liberadas: liberadas,
    rpc: rpcResult,
    auto: args.auto ?? false,
  });

  await registrarEvento({
    pedidoId: String(troca.pedido_id),
    evento: args.auto ? "troca_auto_aplicada" : "troca_aprovada",
    usuarioId: args.usuarioId,
    usuarioNome: args.usuarioNome ?? undefined,
    detalhes: {
      troca_id: args.trocaId,
      sku_vendido: troca.sku_vendido,
      sku_substituto: troca.sku_substituto,
      tipo: troca.tipo,
      quantidade: troca.quantidade,
    },
  });

  const { data: final } = await sb
    .from("siso_trocas_equivalencia")
    .select("*")
    .eq("id", args.trocaId)
    .single();
  return final as TrocaEquivalencia;
}

/**
 * Troca o SUBSTITUTO de uma troca PENDENTE por outro equivalente (operador no
 * modal de aprovação escolhe entre as opções). Valida em TS (regra/saldo) e
 * muta as reservas via RPC atômica `wms_trocar_substituto_atomico` — libera as
 * R reserva_troca do substituto antigo e cria as do novo numa única tx (sem R
 * órfã). Não auto-aprova: segue pendente, operador clica Aprovar depois.
 */
export async function trocarSubstitutoDaTroca(args: {
  trocaId: string;
  novoSku: string;
  usuarioId: string;
  usuarioNome?: string | null;
}): Promise<TrocaEquivalencia> {
  const sb = createServiceClient();
  const source = "wms.trocas-equivalencia";

  const { data: troca } = await sb
    .from("siso_trocas_equivalencia")
    .select("*")
    .eq("id", args.trocaId)
    .maybeSingle();
  if (!troca) throw new TrocaError("TROCA_NAO_ENCONTRADA", "troca não encontrada");
  if (troca.status !== "pendente") {
    throw new TrocaError("TROCA_NAO_PENDENTE", `troca em status '${troca.status}'`);
  }
  if (args.novoSku === troca.sku_substituto) {
    throw new TrocaError("SUBSTITUTO_IGUAL_ATUAL", "substituto já é o atual da troca");
  }

  // Novo substituto (catálogo WMS)
  const { data: novo } = await sb
    .from("siso_produtos")
    .select("id, sku, tier_qualidade")
    .eq("sku", args.novoSku)
    .maybeSingle();
  if (!novo) {
    throw new TrocaError(
      "SUBSTITUTO_NAO_ENCONTRADO",
      `SKU "${args.novoSku}" não encontrado no catálogo WMS`,
    );
  }
  if (novo.id === troca.produto_vendido_id) {
    throw new TrocaError("SUBSTITUTO_IGUAL_VENDIDO", "substituto é o próprio produto vendido");
  }

  // Regra (recalcula tipo sobre o novo par). misto = item já com pick parcial.
  const { data: item } = await sb
    .from("siso_pedido_itens")
    .select("quantidade_pega")
    .eq("id", troca.pedido_item_id)
    .maybeSingle();
  const misto = Number(item?.quantidade_pega ?? 0) > 0;
  const parVerificacao = await buscarParVerificacao(
    troca.sku_vendido as string,
    novo.sku as string,
  );
  const regra = regraTroca({
    tierVendido: (troca.tier_vendido_snapshot as TierQualidade | null) ?? null,
    tierSubstituto: (novo.tier_qualidade as TierQualidade | null) ?? null,
    parVerificacao,
    misto,
  });
  if (regra.resultado === "bloqueada") {
    throw new TrocaError(
      "PAR_BLOQUEADO",
      `par ${troca.sku_vendido} ↔ ${novo.sku} está BLOQUEADO pra troca (curadoria)`,
    );
  }

  // Saldo do novo substituto no MESMO galpão da troca (cascade picking>overstock)
  const resolver = await resolverRealocacao({
    produto_id: novo.id as string,
    galpao_id: troca.galpao_id as string,
    qty_residual: Number(troca.quantidade),
  });
  if (resolver.status === "sem_cobertura") {
    throw new TrocaError(
      "SEM_SALDO_SUBSTITUTO",
      `substituto ${novo.sku} sem saldo disponível que cubra ${troca.quantidade} un. no galpão`,
    );
  }
  const pReservas = resolver.realocacoes.map((r) => ({
    localizacao_id: r.localizacao_id,
    qty: r.quantidade,
  }));

  const { error: rpcErr } = await sb.rpc("wms_trocar_substituto_atomico", {
    p_troca_id: args.trocaId,
    p_usuario_id: args.usuarioId,
    p_novo_produto_id: novo.id,
    p_novo_sku: novo.sku,
    p_novo_tipo: regra.tipo,
    p_novo_tier: novo.tier_qualidade ?? null,
    p_reservas: pReservas,
  });
  if (rpcErr) {
    if (rpcErr.message.includes("TROCA_NAO_PENDENTE")) {
      throw new TrocaError("TROCA_NAO_PENDENTE", rpcErr.message);
    }
    if (rpcErr.message.includes("TROCA_NAO_ENCONTRADA")) {
      throw new TrocaError("TROCA_NAO_ENCONTRADA", rpcErr.message);
    }
    if (rpcErr.message.includes("SUBSTITUTO_IGUAL_VENDIDO")) {
      throw new TrocaError("SUBSTITUTO_IGUAL_VENDIDO", rpcErr.message);
    }
    // TOCTOU: saldo do substituto caiu entre o resolver (TS) e a RPC → a tx
    // reverteu (R antiga sobrevive). Devolve erro claro em vez de 5xx genérico.
    if (rpcErr.message.includes("reserva excede saldo")) {
      throw new TrocaError(
        "SEM_SALDO_SUBSTITUTO",
        "saldo do substituto mudou durante a troca — tente de novo",
      );
    }
    throw new Error(`wms_trocar_substituto_atomico falhou: ${rpcErr.message}`);
  }

  logger.info(source, "substituto da troca alterado", {
    troca_id: args.trocaId,
    pedido_id: troca.pedido_id,
    de: troca.sku_substituto,
    para: novo.sku,
    tipo: regra.tipo,
  });

  await registrarEvento({
    pedidoId: String(troca.pedido_id),
    evento: "troca_substituto_alterado",
    usuarioId: args.usuarioId,
    usuarioNome: args.usuarioNome ?? undefined,
    detalhes: {
      troca_id: args.trocaId,
      sku_anterior: troca.sku_substituto,
      sku_novo: novo.sku,
      tipo: regra.tipo,
    },
  });

  const { data: final } = await sb
    .from("siso_trocas_equivalencia")
    .select("*")
    .eq("id", args.trocaId)
    .single();
  return final as TrocaEquivalencia;
}

export async function rejeitarTroca(args: {
  trocaId: string;
  /** null em encerramentos system-initiated (cancelamento via webhook). */
  usuarioId: string | null;
  usuarioNome?: string | null;
  motivo?: string;
  /** 'cancelada' quando o encerramento veio do sistema (pedido cancelado etc.). */
  status?: "rejeitada" | "cancelada" | "expirada";
}): Promise<TrocaEquivalencia> {
  const sb = createServiceClient();
  const status = args.status ?? "rejeitada";

  const { error: rpcErr } = await sb.rpc("wms_encerrar_troca_atomico", {
    p_troca_id: args.trocaId,
    p_usuario_id: args.usuarioId,
    p_status: status,
    p_motivo: args.motivo ?? null,
  });
  if (rpcErr) {
    if (rpcErr.message.includes("TROCA_NAO_ENCONTRADA")) {
      throw new TrocaError("TROCA_NAO_ENCONTRADA", rpcErr.message);
    }
    if (rpcErr.message.includes("TROCA_NAO_PENDENTE")) {
      throw new TrocaError("TROCA_NAO_PENDENTE", rpcErr.message);
    }
    throw new Error(`wms_encerrar_troca_atomico falhou: ${rpcErr.message}`);
  }

  const { data: troca } = await sb
    .from("siso_trocas_equivalencia")
    .select("*")
    .eq("id", args.trocaId)
    .single();

  await registrarEvento({
    pedidoId: String(troca?.pedido_id ?? ""),
    evento: status === "rejeitada" ? "troca_rejeitada" : "troca_cancelada",
    usuarioId: args.usuarioId ?? undefined,
    usuarioNome: args.usuarioNome ?? undefined,
    detalhes: {
      troca_id: args.trocaId,
      motivo: args.motivo ?? null,
      status,
    },
  });

  return troca as TrocaEquivalencia;
}

/**
 * Encerra (cancelada) toda troca pendente do pedido — chamado quando o pedido
 * é cancelado/encaminhado, pra não deixar R de troca presa.
 */
export async function cancelarTrocasPendentesDoPedido(args: {
  pedidoId: string;
  /** null em encerramentos system-initiated (cancelamento via webhook). */
  usuarioId: string | null;
  motivo: string;
}): Promise<number> {
  const sb = createServiceClient();
  const { data: pendentes } = await sb
    .from("siso_trocas_equivalencia")
    .select("id")
    .eq("pedido_id", args.pedidoId)
    .eq("status", "pendente");
  let count = 0;
  for (const t of pendentes ?? []) {
    try {
      await rejeitarTroca({
        trocaId: t.id as string,
        usuarioId: args.usuarioId,
        motivo: args.motivo,
        status: "cancelada",
      });
      count++;
    } catch (e) {
      logger.warn("wms.trocas-equivalencia", "falha cancelando troca pendente (segue)", {
        troca_id: t.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return count;
}

export interface EquivalenteComEstoque {
  produto_id: string;
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  imagens: string[] | null;
  tier_qualidade: TierQualidade | null;
  par_verificacao: ParVerificacao;
  disponivel_galpao: number;
}

/**
 * Equivalentes do SKU (cluster cross — OEM + links, fecho transitivo) que
 * existem no catálogo WMS, com disponível LIVE no galpão e status de
 * curadoria do par. Alimenta as superfícies (separação, compras, painel).
 */
export async function listarEquivalentesComEstoque(args: {
  sku: string;
  galpaoId: string;
}): Promise<EquivalenteComEstoque[]> {
  const sb = createServiceClient();

  const { data: cluster, error } = await sb.rpc("siso_cross_cluster_skus", {
    p_sku: args.sku,
  });
  if (error || !cluster || cluster.length === 0) return [];
  const skus = (cluster as Array<{ sku: string } | string>).map((r) =>
    typeof r === "string" ? r : r.sku,
  );

  const { data: produtos } = await sb
    .from("siso_produtos")
    .select("id, sku, descricao, imagem_url, imagens, tier_qualidade")
    .in("sku", skus)
    .eq("ativo", true);
  if (!produtos || produtos.length === 0) return [];

  const produtoIds = produtos.map((p) => p.id as string);
  const { data: estoque } = await sb
    .from("siso_estoque")
    .select("produto_id, disponivel, siso_localizacoes!inner(tipo)")
    .eq("galpao_id", args.galpaoId)
    .in("produto_id", produtoIds)
    .in("siso_localizacoes.tipo", ["picking", "overstock"])
    .gt("disponivel", 0);
  const dispPorProduto = new Map<string, number>();
  for (const e of estoque ?? []) {
    const pid = e.produto_id as string;
    dispPorProduto.set(pid, (dispPorProduto.get(pid) ?? 0) + Number(e.disponivel));
  }

  // Curadoria dos pares (sku base ↔ cada equivalente)
  const { data: pares } = await sb
    .from("siso_equivalencias_verificadas")
    .select("sku_a, sku_b, status")
    .or(`sku_a.eq.${args.sku},sku_b.eq.${args.sku}`);
  const parPorSku = new Map<string, ParVerificacao>();
  for (const p of pares ?? []) {
    const outro = p.sku_a === args.sku ? (p.sku_b as string) : (p.sku_a as string);
    parPorSku.set(outro, p.status as ParVerificacao);
  }

  return produtos
    .filter((p) => p.sku !== args.sku)
    .map((p) => ({
      produto_id: p.id as string,
      sku: p.sku as string,
      descricao: (p.descricao as string | null) ?? null,
      imagem_url: (p.imagem_url as string | null) ?? null,
      imagens: (p.imagens as string[] | null) ?? null,
      tier_qualidade: (p.tier_qualidade as TierQualidade | null) ?? null,
      par_verificacao: parPorSku.get(p.sku as string) ?? null,
      disponivel_galpao: dispPorProduto.get(p.id as string) ?? 0,
    }))
    .sort((a, b) => b.disponivel_galpao - a.disponivel_galpao);
}

export interface SaldoGalpaoEquivalente {
  galpao_id: string;
  galpao_nome: string;
  disponivel: number;
}

export interface EquivalenteParaCompra {
  produto_id: string;
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  tier_qualidade: TierQualidade | null;
  par_verificacao: ParVerificacao;
  /** Saldo disponível por galpão (todos os galpões). Informativo. */
  saldo_por_galpao: SaldoGalpaoEquivalente[];
  total_disponivel: number;
}

/**
 * Equivalentes do SKU (cluster cross) pro fluxo de COMPRAS (decisão Eryk
 * 2026-06-14). Diferente de `listarEquivalentesComEstoque` (separação):
 *  - lista TODOS os equivalentes do catálogo WMS, COM ou SEM saldo (o comprador
 *    pode trocar mesmo sem estoque pra comprar o equivalente de outro fornecedor);
 *  - traz o saldo disponível por galpão de CADA equivalente (locs picking+overstock,
 *    mesma definição de sellable do roteamento) — só informativo;
 *  - não recebe galpão nem reserva nada.
 */
export async function listarEquivalentesParaCompra(args: {
  sku: string;
}): Promise<EquivalenteParaCompra[]> {
  const sb = createServiceClient();

  const { data: cluster, error } = await sb.rpc("siso_cross_cluster_skus", {
    p_sku: args.sku,
  });
  if (error || !cluster || cluster.length === 0) return [];
  const skus = (cluster as Array<{ sku: string } | string>).map((r) =>
    typeof r === "string" ? r : r.sku,
  );

  const { data: produtos } = await sb
    .from("siso_produtos")
    .select("id, sku, descricao, imagem_url, tier_qualidade")
    .in("sku", skus)
    .eq("ativo", true);
  if (!produtos || produtos.length === 0) return [];

  const produtoIds = produtos.map((p) => p.id as string);

  // Saldo por galpão (todos os galpões), locs picking+overstock (sellable).
  const { data: estoque } = await sb
    .from("siso_estoque")
    .select("produto_id, galpao_id, disponivel, siso_localizacoes!inner(tipo)")
    .in("produto_id", produtoIds)
    .in("siso_localizacoes.tipo", ["picking", "overstock"])
    .gt("disponivel", 0);

  const porProduto = new Map<string, Map<string, number>>();
  const galpaoIds = new Set<string>();
  for (const e of estoque ?? []) {
    const pid = e.produto_id as string;
    const gid = e.galpao_id as string;
    galpaoIds.add(gid);
    if (!porProduto.has(pid)) porProduto.set(pid, new Map());
    const m = porProduto.get(pid)!;
    m.set(gid, (m.get(gid) ?? 0) + Number(e.disponivel ?? 0));
  }

  const nomePorGalpao = new Map<string, string>();
  if (galpaoIds.size > 0) {
    const { data: galpoes } = await sb
      .from("siso_galpoes")
      .select("id, nome")
      .in("id", [...galpaoIds]);
    for (const g of galpoes ?? [])
      nomePorGalpao.set(g.id as string, g.nome as string);
  }

  // Curadoria dos pares (sku base ↔ cada equivalente)
  const { data: pares } = await sb
    .from("siso_equivalencias_verificadas")
    .select("sku_a, sku_b, status")
    .or(`sku_a.eq.${args.sku},sku_b.eq.${args.sku}`);
  const parPorSku = new Map<string, ParVerificacao>();
  for (const p of pares ?? []) {
    const outro = p.sku_a === args.sku ? (p.sku_b as string) : (p.sku_a as string);
    parPorSku.set(outro, p.status as ParVerificacao);
  }

  return produtos
    .filter((p) => p.sku !== args.sku)
    .map((p) => {
      const m = porProduto.get(p.id as string) ?? new Map<string, number>();
      const saldo_por_galpao: SaldoGalpaoEquivalente[] = [...m.entries()]
        .map(([galpao_id, disponivel]) => ({
          galpao_id,
          galpao_nome: nomePorGalpao.get(galpao_id) ?? "",
          disponivel,
        }))
        .sort((a, b) => b.disponivel - a.disponivel);
      const total_disponivel = saldo_por_galpao.reduce(
        (s, g) => s + g.disponivel,
        0,
      );
      return {
        produto_id: p.id as string,
        sku: p.sku as string,
        descricao: (p.descricao as string | null) ?? null,
        imagem_url: (p.imagem_url as string | null) ?? null,
        tier_qualidade: (p.tier_qualidade as TierQualidade | null) ?? null,
        par_verificacao: parPorSku.get(p.sku as string) ?? null,
        saldo_por_galpao,
        total_disponivel,
      };
    })
    .sort((a, b) => b.total_disponivel - a.total_disponivel);
}
