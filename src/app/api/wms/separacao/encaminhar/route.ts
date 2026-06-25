import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { registrarEvento } from "@/lib/historico-service";
import { resetarEstadoSeparacaoItens } from "@/lib/separacao/reset-state";
import { estornarReservaIndividual } from "@/lib/wms/reservas";
import { cancelarTrocasPendentesDoPedido } from "@/lib/wms/trocas-equivalencia";
import { rotearPedidoPinado, type ItemPedido } from "@/lib/wms/roteamento";
import { criarReservasRotaAtomico } from "@/lib/webhook-processor-wms";
import {
  planejarTrocaRoteamento,
  aplicarTrocasRoteamento,
  type ItemRotearTroca,
} from "@/lib/wms/trocas-roteamento";
import { resolverProdutoEfetivoDoItem } from "@/lib/separacao/wms-mapping";
import { kickWorker } from "@/lib/execution-worker";
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

export async function encaminharPedido(
  supabase: ReturnType<typeof createServiceClient>,
  pedidoId: string,
  galpaoDestino: { id: string; nome: string },
  session: { id: string; nome: string },
): Promise<void> {
  // B1. Fetch + validate
  const { data: pedido, error: pedidoErr } = await supabase
    .from("siso_pedidos")
    .select(
      "id, status, status_separacao, decisao_final, empresa_origem_id, filial_origem, estoque_lancado, nota_fiscal_id, chave_acesso_nf, numero, separacao_galpao_id",
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
  // que o helper não cobre (aplicado após a re-rota).
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

  // B3. Re-rota PINADA no galpão destino — substitui o reset legado que zerava
  // separacao_galpao_id e virava pendente/transferência (re-roteável depois por
  // geo-priority LIVRE, o bug que isto mata: o pedido voltava pro galpão errado).
  // A re-rota avalia cobertura SÓ no destino e decide propria | troca | oc
  // ANCORADA nele, escrevendo status/galpão/decisão. NF preservada. Falha aqui
  // re-lança → o catch do caller registra em falhas[] e o pedido NÃO migra
  // (nenhuma escrita de status/galpão acontece antes da decisão da re-rota).
  const resultadoRota = await reRotearPinadoNoDestino({
    supabase,
    pedido,
    galpaoAtual,
    galpaoDestino,
    session,
  });

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
      decisao_nova: resultadoRota.decisao,
    },
  });

  logger.info(LOG_SOURCE, `Pedido ${pedido.numero} encaminhado de ${galpaoAtual.nome} para ${galpaoDestino.nome}`, {
    pedidoId,
    origem: galpaoAtual.nome,
    destino: galpaoDestino.nome,
    decisaoAnterior: pedido.decisao_final,
    decisaoNova: resultadoRota.decisao,
    operador: session.nome,
    nfPreservada: !!pedido.nota_fiscal_id,
  });
}

// ─── Re-rota PINADA no galpão destino ───────────────────────────────────────

interface PedidoReRota {
  id: string;
  empresa_origem_id: string | null;
  nota_fiscal_id: string | null;
  chave_acesso_nf: string | null;
  decisao_final: string | null;
  numero: string;
}

/**
 * INVARIANTE CENTRAL: a re-rota é PINADA no galpão destino — avalia cobertura
 * SÓ nele (via `rotearPedidoPinado`), nunca por geo-priority livre. As únicas
 * decisões possíveis pro destino: `propria` (cobre), `troca` (equivalente no
 * destino) ou `oc` (não cobre). Jamais `transferencia` (escolher outro galpão
 * quebraria o pino).
 *
 * Espelha o intake do webhook (webhook-processor-wms §3b/7b/8) e a aprovação
 * pós-troca (trocas-roteamento `aprovarPedidoPosTroca`), mas SEM troca remota
 * (D2: o pino é só o destino) e ancorando todo status/galpão no destino:
 *  - propria              → R reserva_pedido na loc + wms_aprovar_e_enfileirar.
 *  - troca todos-auto     → vira propria (substituto reservado) + enfileira.
 *  - troca c/ aprovação   → pendente + sugestao='troca_equivalente', galpão JÁ
 *                           pinado no destino (R reserva_troca via aplicar...).
 *  - sem cobertura/cross  → OC ancorada (decisao_final='oc', job lancar_estoque).
 *
 * Ordem (D5, "falha não move"): resolve itens → roteia (read-only) → cria
 * reservas (atômico, rollback no erro) → SÓ ENTÃO escreve status/galpão. Se
 * qualquer passo lança, nenhuma escrita de decisão aconteceu e o caller registra
 * a falha (o pedido fica no estado pós-reset, sem migrar pro destino).
 */
async function reRotearPinadoNoDestino(args: {
  supabase: ReturnType<typeof createServiceClient>;
  pedido: PedidoReRota;
  galpaoAtual: { id: string; nome: string };
  galpaoDestino: { id: string; nome: string };
  session: { id: string; nome: string };
}): Promise<{ decisao: "propria" | "pendente_troca" | "oc" }> {
  const { supabase, pedido, galpaoAtual, galpaoDestino, session } = args;
  const empresaId = pedido.empresa_origem_id ?? "";

  // Campos de artefato (operador de separação, etiqueta, timestamps) que NÃO são
  // decisão de rota — limpos em todo branch. NF/agrupamento ficam (presos à NF).
  // etiqueta_status=null força reimpressão no novo galpão. operador_id/nome NÃO
  // entram aqui: o RPC os define no branch propria; os branches pendente/oc os
  // zeram explicitamente.
  const artefatos = {
    processado_em: null,
    estoque_lancado: false,
    separacao_operador_id: null,
    separacao_iniciada_em: null,
    separacao_concluida_em: null,
    embalagem_concluida_em: null,
    etiqueta_status: null,
    encaminhado_de: galpaoAtual.nome,
  };

  const statusSeparacaoComNf =
    pedido.nota_fiscal_id && pedido.chave_acesso_nf
      ? "aguardando_separacao"
      : "aguardando_nf";

  // 1. Itens → produto FÍSICO efetivo (substituto > tiny > SKU). Throw em item
  //    não-resolvível ⇒ falha não move (consistente com intake do webhook).
  const { data: itensRaw } = await supabase
    .from("siso_pedido_itens")
    .select("produto_id, sku, quantidade_pedida, produto_wms_substituto_id")
    .eq("pedido_id", pedido.id);

  const itensRotear: ItemPedido[] = [];
  const itensTroca: ItemRotearTroca[] = [];
  for (const it of itensRaw ?? []) {
    const uuid = await resolverProdutoEfetivoDoItem(empresaId, it);
    const qty = Number(it.quantidade_pedida ?? 0);
    itensRotear.push({ produto_id: uuid, qty });
    itensTroca.push({
      tiny_id: String(it.produto_id),
      sku: it.sku ?? "",
      produto_uuid: uuid,
      qty,
    });
  }

  // 2. Roteia PINADO no destino (read-only): propria (cobre) ou oc (não cobre).
  const rota = await rotearPedidoPinado(galpaoDestino.id, itensRotear);

  // 3a. PRÓPRIA — destino cobre com o produto efetivo.
  if (rota.decisao === "propria") {
    await criarReservasRotaAtomico({
      pedidoId: pedido.id,
      rotas: rota.rotas.map((r) => ({
        produto_id: r.produto_id,
        galpao_id: r.galpao_id,
        localizacao_id: r.localizacao_id,
        qty: r.qty,
      })),
    });
    await aprovarPropriaNoDestino({
      supabase,
      pedidoId: pedido.id,
      empresaId: pedido.empresa_origem_id,
      galpaoDestino,
      session,
      statusSeparacao: statusSeparacaoComNf,
      artefatos,
    });
    return { decisao: "propria" };
  }

  // 3b. Destino não cobre com o original → tenta TROCA local no destino (sem
  //     remota: D2). Plano fecha quando todo item descoberto tem equivalente que
  //     cobre no destino.
  const plano = await planejarTrocaRoteamento({
    galpaoId: galpaoDestino.id,
    itens: itensTroca,
  });

  if (plano) {
    await aplicarTrocasRoteamento({
      pedidoId: pedido.id,
      galpaoId: galpaoDestino.id,
      swaps: plano.swaps,
      forcarPendente: false,
    });
    const autoSwaps = plano.swaps.filter((s) => s.auto);
    const rotasTroca = [
      ...plano.cobertosOriginal.map((c) => ({
        produto_id: c.produto_uuid,
        galpao_id: galpaoDestino.id,
        localizacao_id: c.localizacao_id,
        qty: c.qty,
      })),
      ...autoSwaps.map((s) => ({
        produto_id: s.produto_substituto_id,
        galpao_id: galpaoDestino.id,
        localizacao_id: s.localizacao_id,
        qty: s.qty,
      })),
    ];
    if (rotasTroca.length > 0) {
      await criarReservasRotaAtomico({ pedidoId: pedido.id, rotas: rotasTroca });
    }

    if (plano.todosAuto) {
      // Todas as trocas são livres (par verificado, mesmo tier) → vira propria.
      await aprovarPropriaNoDestino({
        supabase,
        pedidoId: pedido.id,
        empresaId: pedido.empresa_origem_id,
        galpaoDestino,
        session,
        statusSeparacao: statusSeparacaoComNf,
        artefatos,
      });
      return { decisao: "propria" };
    }

    // Alguma troca exige aprovação humana → pendente, MAS já pinado no destino.
    // aprovarPedidoPosTroca (rota /trocas) lê separacao_galpao_id → finaliza no
    // destino sem re-rotear.
    const { error } = await supabase
      .from("siso_pedidos")
      .update({
        ...artefatos,
        status: "pendente",
        sugestao: "troca_equivalente",
        sugestao_motivo:
          "Equivalente em estoque no galpão destino — aguardando aprovação de troca",
        decisao_final: null,
        tipo_resolucao: null,
        operador_id: null,
        operador_nome: null,
        separacao_galpao_id: galpaoDestino.id,
        status_separacao: null,
      })
      .eq("id", pedido.id);
    if (error) throw new Error(`re-rota troca pendente falhou: ${error.message}`);
    return { decisao: "pendente_troca" };
  }

  // 3c. Sem cobertura nem equivalente no destino → OC ANCORADA no destino
  //     (D2: nunca troca remota). Espelha autoEnfileiraOc do webhook.
  const { error: ocErr } = await supabase
    .from("siso_pedidos")
    .update({
      ...artefatos,
      status: "executando",
      sugestao: "oc",
      sugestao_motivo: "Re-rota encaminhar — sem cobertura no destino, vai pra OC",
      decisao_final: "oc",
      tipo_resolucao: "auto",
      operador_id: null,
      operador_nome: null,
      separacao_galpao_id: galpaoDestino.id,
      // status_separacao=null: o worker (executarMarcadoresOnly) seta validacao_oc
      // ancorado no separacao_galpao_id que acabamos de pinar no destino.
      status_separacao: null,
      marcadores: ["OC", galpaoDestino.nome, "LVR"],
    })
    .eq("id", pedido.id);
  if (ocErr) throw new Error(`re-rota oc falhou: ${ocErr.message}`);

  // Job lancar_estoque (decisao=oc) — dedup por (pedido, tipo, status vivo).
  const { data: jobExistente } = await supabase
    .from("siso_fila_execucao")
    .select("id")
    .eq("pedido_id", pedido.id)
    .eq("tipo", "lancar_estoque")
    .in("status", ["pendente", "executando"])
    .maybeSingle();
  if (!jobExistente) {
    await supabase.from("siso_fila_execucao").insert({
      pedido_id: pedido.id,
      tipo: "lancar_estoque",
      filial_execucao: galpaoDestino.nome,
      empresa_id: pedido.empresa_origem_id,
      decisao: "oc",
    });
  }
  kickWorker().catch((err) => {
    logger.error(LOG_SOURCE, "kickWorker falhou na re-rota OC", {
      pedidoId: pedido.id,
      err: err instanceof Error ? err.message : String(err),
    });
  });
  return { decisao: "oc" };
}

/**
 * Aprova o pedido como PROPRIA no destino: transição de status + job
 * lancar_estoque na MESMA tx (wms_aprovar_e_enfileirar, espelha
 * aprovarPedidoPosTroca) + limpeza dos artefatos de separação (que o RPC não
 * cobre) + kickWorker. As reservas R já devem ter sido criadas pelo caller.
 */
async function aprovarPropriaNoDestino(args: {
  supabase: ReturnType<typeof createServiceClient>;
  pedidoId: string;
  empresaId: string | null;
  galpaoDestino: { id: string; nome: string };
  session: { id: string; nome: string };
  statusSeparacao: "aguardando_separacao" | "aguardando_nf";
  artefatos: Record<string, unknown>;
}): Promise<void> {
  const { supabase, pedidoId, empresaId, galpaoDestino, session, statusSeparacao, artefatos } =
    args;

  const { error } = await supabase.rpc("wms_aprovar_e_enfileirar", {
    p_pedido_id: pedidoId,
    p_decisao: "propria",
    p_status_separacao: statusSeparacao,
    p_empresa_id: empresaId,
    p_filial_execucao: galpaoDestino.nome,
    p_operador_id: session.id,
    p_operador_nome: session.nome,
    p_marcadores: [galpaoDestino.nome, "LVR"],
    p_separacao_galpao_id: galpaoDestino.id,
  });
  if (error) throw new Error(`re-rota propria (aprovar/enfileirar) falhou: ${error.message}`);

  // Limpa os artefatos de separação que o RPC não toca + sugestao/tipo_resolucao.
  // Não mexe em status/galpão/decisão/operador/marcadores (o RPC já os definiu).
  await supabase
    .from("siso_pedidos")
    .update({
      ...artefatos,
      sugestao: "propria",
      sugestao_motivo: "Re-rota encaminhar — cobertura própria no destino",
      tipo_resolucao: "auto",
    })
    .eq("id", pedidoId);

  kickWorker().catch((err) => {
    logger.error(LOG_SOURCE, "kickWorker falhou na re-rota propria", {
      pedidoId,
      err: err instanceof Error ? err.message : String(err),
    });
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
    const naoLiberadas: string[] = [];
    for (const r of lista) {
      try {
        await estornarReservaIndividual({
          reserva_id: r.id,
          motivo: "outro",
          usuario_id: usuarioId,
        });
        liberadas++;
      } catch (e) {
        // LOUD: o pedido vai migrar de galpão; uma R não-liberada vira RESERVADO
        // FANTASMA no galpão origem (saldo travado, escapa de detectarReservasOrfas
        // que só flaga status=cancelado). Direção conservadora (trava, não vende
        // dobrado), mas precisa de visibilidade pra limpeza — logError, não warn.
        naoLiberadas.push(r.id);
        logger.logError({
          error: e,
          source: LOG_SOURCE,
          message: "Falhou liberar R no encaminhar — reservado fantasma no galpão origem",
          category: "business_logic",
          metadata: { pedido_id: pedido.id, reserva_id: r.id },
        });
      }
    }
    logger.info(LOG_SOURCE, `Rs liberadas no encaminhar: ${liberadas}`, {
      pedidoId: pedido.id,
      tentadas: lista.length,
      nao_liberadas: naoLiberadas.length,
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
