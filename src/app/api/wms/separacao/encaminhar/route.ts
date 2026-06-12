import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { registrarEvento } from "@/lib/historico-service";
import { resetarEstadoSeparacaoItens } from "@/lib/separacao/reset-state";
import { estornarReservaIndividual } from "@/lib/wms/reservas";
import { cancelarTrocasPendentesDoPedido } from "@/lib/wms/trocas-equivalencia";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "encaminhar";

/**
 * POST /api/separacao/encaminhar
 *
 * Forward one or more orders to another galpão.
 * Reverses any stock execution, resets pedido to pendente with
 * sugestao="transferencia" so the destination galpão sees it.
 *
 * Reroute contract (early-agrupamento safe):
 *  - NF fields PRESERVED: nota_fiscal_id, chave_acesso_nf, url_danfe
 *    → The NF belongs to the pedido regardless of destination galpão.
 *  - Shipping artifacts CLEARED: agrupamento_expedicao_id, expedicao_id,
 *    etiqueta_url, etiqueta_zpl, etiqueta_status
 *    → These are destination-specific and must be recreated after reroute.
 *  - After reset the pedido is eligible for a new fase-1 agrupamento via
 *    any second-chance entrypoint (approval worker, webhook, forcar-pendente).
 *
 * Body: { pedido_ids: string[], galpao_destino_id: string }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  let body: { pedido_ids?: unknown; galpao_destino_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { pedido_ids, galpao_destino_id } = body;

  if (
    !Array.isArray(pedido_ids) ||
    pedido_ids.length === 0 ||
    !pedido_ids.every((id) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "pedido_ids deve ser um array de strings não vazio" },
      { status: 400 },
    );
  }

  if (typeof galpao_destino_id !== "string" || !galpao_destino_id) {
    return NextResponse.json(
      { error: "galpao_destino_id obrigatório" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  // Validate destination galpão
  const { data: galpaoDestino } = await supabase
    .from("siso_galpoes")
    .select("id, nome")
    .eq("id", galpao_destino_id)
    .eq("ativo", true)
    .single();

  if (!galpaoDestino) {
    return NextResponse.json(
      { error: "Galpão destino não encontrado ou inativo" },
      { status: 400 },
    );
  }

  const encaminhados: string[] = [];
  const falhas: Array<{ id: string; erro: string }> = [];

  for (const pedidoId of pedido_ids as string[]) {
    try {
      await encaminharPedido(
        supabase,
        pedidoId,
        galpaoDestino,
        session,
      );
      encaminhados.push(pedidoId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      falhas.push({ id: pedidoId, erro: msg });
      logger.warn(LOG_SOURCE, `Falha ao encaminhar pedido ${pedidoId}`, {
        error: msg,
        galpaoDestino: galpaoDestino.nome,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    encaminhados,
    falhas,
    galpao_destino_nome: galpaoDestino.nome,
  });
}

// ─── Core logic per pedido ──────────────────────────────────────────────────

async function encaminharPedido(
  supabase: ReturnType<typeof createServiceClient>,
  pedidoId: string,
  galpaoDestino: { id: string; nome: string },
  session: { id: string; nome: string },
): Promise<void> {
  // B1. Fetch + validate
  const { data: pedido, error: pedidoErr } = await supabase
    .from("siso_pedidos")
    .select(
      "id, status, status_separacao, decisao_final, empresa_origem_id, filial_origem, estoque_lancado, nota_fiscal_id, numero, separacao_galpao_id",
    )
    .eq("id", pedidoId)
    .single();

  if (pedidoErr || !pedido) {
    throw new Error("Pedido não encontrado");
  }

  if (
    pedido.status_separacao !== "aguardando_separacao" &&
    pedido.status_separacao !== "em_separacao" &&
    pedido.status_separacao !== "pendente_realocacao"
  ) {
    throw new Error(
      `Status inválido para encaminhar: ${pedido.status_separacao ?? "null"}`,
    );
  }

  // Resolve the actual galpão currently handling this order.
  // separacao_galpao_id is set when separation starts; fallback to the execution queue.
  const galpaoAtual = await resolveGalpaoAtual(supabase, pedido, pedidoId);

  if (galpaoAtual.id === galpaoDestino.id) {
    throw new Error("Não é possível encaminhar para o mesmo galpão");
  }

  // B2. Reverse stock execution (libera R vivas)
  await reverseStockExecution(supabase, pedido, session.id);

  // P2-SEP-04: ESTORNAR as S do pick ANTES de mexer no pedido. Antes, o pedido
  // virava pendente + galpão=null PRIMEIRO; se o reset (estorno das S) falhasse
  // depois, o pedido ficava re-roteável com S vivas no galpão antigo (saldo
  // fantasma). Se o reset lançar agora, o catch do caller registra em falhas[]
  // e o pedido permanece INTACTO no estado atual — nada move.
  //
  // (estorna mov_saida_id, cancela realocs, reseta 10 campos do item, registra evento).
  // Mantém o reset de campos legados (estoque_saida_lancada, empresa_deducao_id, quantidade_bipada)
  // que o helper não cobre (aplicado após o UPDATE).
  const { data: pedidoItens } = await supabase
    .from("siso_pedido_itens")
    .select("id")
    .eq("pedido_id", pedidoId);
  const itemIdsTodos = (pedidoItens ?? []).map((i) => i.id);

  await resetarEstadoSeparacaoItens({
    supabase,
    itemIds: itemIdsTodos,
    usuarioId: session.id,
    motivo: "encaminhar",
  });

  // B3. Reset pedido to pendente — só depois das S estornadas.
  // NF fields (nota_fiscal_id, chave_acesso_nf, url_danfe) are intentionally
  // NOT cleared — the NF belongs to the pedido regardless of destination.
  // Shipping artifacts (agrupamento, expedicao, etiqueta ZPL/URL) are PRESERVED —
  // they are tied to the NF, not the galpão. Only etiqueta_status is reset
  // so the label can be reprinted at the new destination.
  //
  // sugestao is set dynamically so the galpão filter shows the order in the
  // correct destination: "propria" if dest == filial_origem, else "transferencia".
  const sugestao = galpaoDestino.nome === pedido.filial_origem ? "propria" : "transferencia";

  const { error: updateErr } = await supabase
    .from("siso_pedidos")
    .update({
      status: "pendente",
      sugestao,
      encaminhado_de: galpaoAtual.nome,
      decisao_final: null,
      operador_id: null,
      operador_nome: null,
      tipo_resolucao: null,
      processado_em: null,
      estoque_lancado: false,
      status_separacao: null,
      separacao_galpao_id: null,
      separacao_operador_id: null,
      separacao_iniciada_em: null,
      separacao_concluida_em: null,
      embalagem_concluida_em: null,
      // etiqueta_status reset so label can be reprinted at new galpão
      etiqueta_status: null,
    })
    .eq("id", pedidoId);

  if (updateErr) {
    throw new Error(`Falha ao resetar pedido: ${updateErr.message}`);
  }

  // Reset campos legados não cobertos pelo helper
  await supabase
    .from("siso_pedido_itens")
    .update({
      quantidade_bipada: 0,
      bipado_completo: false,
      estoque_saida_lancada: false,
      empresa_deducao_id: null,
    })
    .eq("pedido_id", pedidoId);

  // B4. Audit event
  registrarEvento({
    pedidoId,
    evento: "encaminhado",
    usuarioId: session.id,
    usuarioNome: session.nome,
    detalhes: {
      origem: galpaoAtual.nome,
      destino: galpaoDestino.nome,
      decisao_anterior: pedido.decisao_final,
    },
  });

  logger.info(LOG_SOURCE, `Pedido ${pedido.numero} encaminhado de ${galpaoAtual.nome} para ${galpaoDestino.nome}`, {
    pedidoId,
    origem: galpaoAtual.nome,
    destino: galpaoDestino.nome,
    decisaoAnterior: pedido.decisao_final,
    operador: session.nome,
    nfPreservada: !!pedido.nota_fiscal_id,
    sugestao,
  });
}

// ─── Resolve current galpão ─────────────────────────────────────────────────

async function resolveGalpaoAtual(
  supabase: ReturnType<typeof createServiceClient>,
  pedido: { separacao_galpao_id: string | null; filial_origem: string },
  pedidoId: string,
): Promise<{ id: string; nome: string }> {
  // 1. If separacao already started, the galpão is assigned
  if (pedido.separacao_galpao_id) {
    const { data } = await supabase
      .from("siso_galpoes")
      .select("id, nome")
      .eq("id", pedido.separacao_galpao_id)
      .single();
    if (data) return data;
  }

  // 2. Fallback: resolve from the most recent execution queue entry
  const { data: job } = await supabase
    .from("siso_fila_execucao")
    .select("empresa_id")
    .eq("pedido_id", pedidoId)
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (job) {
    const { data: empresa } = await supabase
      .from("siso_empresas")
      .select("galpao_id")
      .eq("id", job.empresa_id)
      .single();

    if (empresa) {
      const { data: galpao } = await supabase
        .from("siso_galpoes")
        .select("id, nome")
        .eq("id", empresa.galpao_id)
        .single();
      if (galpao) return galpao;
    }
  }

  // 3. Last resort: use filial_origem as galpão name lookup
  const { data: galpaoByNome } = await supabase
    .from("siso_galpoes")
    .select("id, nome")
    .eq("nome", pedido.filial_origem)
    .single();

  if (galpaoByNome) return galpaoByNome;

  // Should never reach here — return a safe fallback
  return { id: "", nome: pedido.filial_origem };
}

// ─── Stock reversal ─────────────────────────────────────────────────────────

interface PedidoForReversal {
  id: string;
  decisao_final: string | null;
  empresa_origem_id: string | null;
  estoque_lancado: boolean | null;
  numero: string;
}

async function reverseStockExecution(
  supabase: ReturnType<typeof createServiceClient>,
  pedido: PedidoForReversal,
  usuarioId: string,
): Promise<void> {
  // Encaminhar só roda em status não-forward (aguardando_separacao /
  // em_separacao / pendente_realocacao). Nesse ponto estoque_lancado=false e o
  // cutover nunca rodou, então NÃO há S de cutover a reverter aqui — as S do
  // PICK (se o operador bipou algo) são estornadas por resetarEstadoSeparacaoItens
  // no caller (encaminharPedido). Aqui só liberamos as R VIVAS dos itens ainda
  // não pegos, pra `reservado` voltar a 0 antes do pedido migrar de galpão.
  //
  // (Fase 1.3 — 2026-05-28) Removida a reversa via Tiny estornarEstoque/
  // movimentarEstoque: estoque vive 100% no ledger WMS; Tiny é só camada fiscal.
  //
  // Per-R via `estornarReservaIndividual` (idempotente: acha L com
  // estorno_de=R.id e retorna sem criar novo). Seguro chamar pra TODAS as Rs —
  // as já liberadas por picking retornam o L existente. Evita o short-circuit
  // de `liberarReserva` que pulava Rs não-bipadas deixando reservado zumbi.
  try {
    const { data: reservasAbertas } = await supabase
      .from("siso_movimentacoes")
      .select("id")
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido")
      .eq("origem_id", String(pedido.id));
    const lista = (reservasAbertas ?? []) as Array<{ id: string }>;
    let liberadas = 0;
    for (const r of lista) {
      try {
        await estornarReservaIndividual({
          reserva_id: r.id,
          motivo: "outro",
          usuario_id: usuarioId,
        });
        liberadas++;
      } catch (e) {
        logger.warn(LOG_SOURCE, "falha estornando R individual (segue)", {
          pedido_id: pedido.id,
          reserva_id: r.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    logger.info(LOG_SOURCE, `Rs liberadas no encaminhar: ${liberadas}`, {
      pedidoId: pedido.id,
      tentadas: lista.length,
    });
  } catch (e) {
    logger.warn(LOG_SOURCE, "falha liberando Rs (segue com reverse)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // Troca de equivalência: solicitação pendente carrega R forte no SUBSTITUTO
  // (origem_tipo='reserva_troca') no galpão ATUAL — encerra antes do pedido
  // migrar de galpão, senão a peça fica presa numa troca que não vale mais.
  try {
    const canceladas = await cancelarTrocasPendentesDoPedido({
      pedidoId: String(pedido.id),
      usuarioId,
      motivo: "pedido encaminhado pra outro galpão",
    });
    if (canceladas > 0) {
      logger.info(LOG_SOURCE, "trocas pendentes canceladas no encaminhar", {
        pedidoId: pedido.id,
        canceladas,
      });
    }
  } catch (e) {
    logger.warn(LOG_SOURCE, "falha cancelando trocas pendentes (segue)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
