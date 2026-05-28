import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getEmpresaById } from "@/lib/empresa-lookup";
import { kickWorker } from "@/lib/execution-worker";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";
import { reservarAtomico, estornarReservaIndividual } from "@/lib/wms/reservas";
import {
  resolverProdutoWms,
  buscarLocComMaiorSaldoNoGalpao,
} from "@/lib/separacao/wms-mapping";
import { rotearPedidoDoBanco } from "@/lib/wms/roteamento";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

type Decisao = "propria" | "transferencia" | "oc";
type DecisaoComRejeicao = Decisao | "rejeitado";

/**
 * POST /api/pedidos/aprovar
 *
 * Operator approves a pending order with a decision.
 * Saves the decision, enqueues a stock-posting job, and kicks the worker.
 *
 * Body: { pedidoId, decisao, operadorId?, operadorNome?, motivo? }
 *
 * `decisao === "rejeitado"` is the "Recusar" path — short-circuits everything
 * (no fila, no reservas), marks pedido cancelado + decisao_final='rejeitado'.
 */
export async function POST(request: NextRequest) {
  // Auth + perm (finding 4.1 — pedidos.aprovar)
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!userCan(session, "pedidos.aprovar")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: {
    pedidoId?: string;
    decisao?: DecisaoComRejeicao;
    operadorId?: string;
    operadorNome?: string;
    motivo?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { pedidoId, decisao, operadorId, operadorNome } = body;

  if (!pedidoId || !decisao) {
    return NextResponse.json(
      { error: "pedidoId e decisao são obrigatórios" },
      { status: 400 },
    );
  }

  // ── Decisão "rejeitado" (botão Recusar) ─────────────────────────────────
  // Short-circuit antes da validação/fila/reservas: marca pedido cancelado
  // + decisao_final='rejeitado' + status_separacao=null, registra evento e
  // retorna. Nada de fila, nada de reserva, nada de worker.
  if (decisao === "rejeitado") {
    const supabase = createServiceClient();
    const { error: updErr } = await supabase
      .from("siso_pedidos")
      .update({
        decisao_final: "rejeitado",
        status: "cancelado",
        status_separacao: null,
      })
      .eq("id", pedidoId);
    if (updErr) {
      logger.error("aprovar", "Falha ao rejeitar pedido", {
        pedidoId,
        err: updErr.message,
      });
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
    registrarEvento({
      pedidoId,
      evento: "cancelado",
      usuarioId: operadorId,
      usuarioNome: operadorNome,
      detalhes: { motivo: body.motivo ?? "recusado pelo operador" },
    }).catch(() => {});
    logger.info("aprovar", "Pedido rejeitado", {
      pedidoId,
      operador: operadorNome,
      motivo: body.motivo,
    });
    return NextResponse.json({ ok: true, pedidoId, decisao: "rejeitado" });
  }

  const validDecisoes: Decisao[] = ["propria", "transferencia", "oc"];
  if (!validDecisoes.includes(decisao)) {
    return NextResponse.json(
      { error: `Decisão inválida. Use: ${validDecisoes.join(", ")}` },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  // Fetch the order (include empresa_origem_id for queue job)
  const { data: pedido, error: fetchError } = await supabase
    .from("siso_pedidos")
    .select("id, filial_origem, empresa_origem_id, status, nota_fiscal_id, chave_acesso_nf")
    .eq("id", pedidoId)
    .single();

  if (fetchError || !pedido) {
    return NextResponse.json(
      { error: "Pedido não encontrado" },
      { status: 404 },
    );
  }

  if (pedido.status !== "pendente") {
    return NextResponse.json(
      { error: `Pedido não está pendente (status: ${pedido.status})` },
      { status: 409 },
    );
  }

  if (!pedido.empresa_origem_id) {
    return NextResponse.json(
      { error: "Pedido sem empresa_origem_id — reprocessar webhook" },
      { status: 422 },
    );
  }

  // Resolve empresa and galpão info
  const empresaOrigem = await getEmpresaById(pedido.empresa_origem_id);
  if (!empresaOrigem) {
    return NextResponse.json(
      { error: "Empresa de origem não encontrada" },
      { status: 404 },
    );
  }

  const filialOrigem = empresaOrigem.galpaoNome;

  // Decisão 1 (28/05): bloqueia OC quando snapshot do pedido cobre 100% dos itens
  // na empresa origem. Sem isso o worker degrada silenciosamente pra Própria sem
  // criar reserva → estoque exposto a outros pedidos.
  if (decisao === "oc") {
    const { data: itensOc } = await supabase
      .from("siso_pedido_itens")
      .select("id, produto_id, quantidade_pedida")
      .eq("pedido_id", pedidoId);
    const { data: estoquesOc } = await supabase
      .from("siso_pedido_item_estoques")
      .select("produto_id, empresa_id, disponivel")
      .in("pedido_id", [pedidoId]);

    if (itensOc && itensOc.length > 0 && estoquesOc) {
      const dispMap = new Map<string, number>();
      for (const e of estoquesOc) {
        if (String(e.empresa_id) === String(pedido.empresa_origem_id)) {
          dispMap.set(String(e.produto_id), Number(e.disponivel ?? 0));
        }
      }
      const todosCobrem = itensOc.every((it) => {
        const qty = Number(it.quantidade_pedida ?? 0);
        const disp = dispMap.get(String(it.produto_id)) ?? 0;
        return qty > 0 && disp >= qty;
      });
      if (todosCobrem) {
        logger.warn("aprovar", "OC bloqueado: snapshot cobre 100%", {
          pedidoId,
          empresa_origem_id: pedido.empresa_origem_id,
        });
        return NextResponse.json(
          {
            error: "oc_bloqueado_snapshot_cobre",
            message:
              "Snapshot mostra saldo completo — aprove como Própria ou Transferência",
          },
          { status: 422 },
        );
      }
    }
  }

  // Determine empresa_id, filialExecucao, and separacao galpao based on decisao
  let empresaExecucaoId: string;
  let filialExecucao: string;
  let separacaoGalpaoId: string;

  if (decisao === "propria" || decisao === "oc") {
    empresaExecucaoId = pedido.empresa_origem_id;
    filialExecucao = filialOrigem;
    separacaoGalpaoId = empresaOrigem.galpaoId;
  } else {
    // transferencia: usa rotearPedidoDoBanco (geo-priority + saldo real WMS).
    // Substitui o getEmpresasDoGrupo legacy que ignorava saldo e escolhia
    // empresa-suporte só pelo grupo+galpão, sem checar cobertura real.

    // Carrega itens pra alimentar roteamento (precisa quantidade)
    const { data: itensParaRotear } = await supabase
      .from("siso_pedido_itens")
      .select("produto_id, quantidade_pedida")
      .eq("pedido_id", pedidoId);

    // Map Tiny produto_id → WMS uuid via empresa origem (que é a dona
    // do tiny_produto_id armazenado em siso_pedido_itens.produto_id).
    const itens: Array<{ produto_id: string; qty: number }> = [];
    for (const it of itensParaRotear ?? []) {
      const { data: map } = await supabase
        .from("siso_produto_empresas")
        .select("produto_id")
        .eq("empresa_id", pedido.empresa_origem_id)
        .eq("tiny_produto_id", Number(it.produto_id))
        .maybeSingle();
      if (map?.produto_id) {
        itens.push({
          produto_id: map.produto_id as string,
          qty: Number(it.quantidade_pedida ?? 0),
        });
      }
    }

    const rota = await rotearPedidoDoBanco(pedido.empresa_origem_id, itens);

    if (rota.decisao === "transferencia" && rota.galpao_id) {
      // Encontra galpão escolhido
      const { data: galpaoEsc } = await supabase
        .from("siso_galpoes")
        .select("id, nome")
        .eq("id", rota.galpao_id)
        .single();
      // Encontra empresa que tem este galpão como preferred (pra tag de tier
      // e fila legada). Em 3D não há "empresa dona" física — usamos qualquer
      // empresa com este galpão como preferred só pra identificar a fila.
      const { data: empresaSuporte } = await supabase
        .from("siso_empresa_galpoes_preferenciais")
        .select("empresa_id")
        .eq("galpao_id", rota.galpao_id)
        .limit(1)
        .maybeSingle();

      empresaExecucaoId =
        (empresaSuporte?.empresa_id as string | null) ?? pedido.empresa_origem_id;
      filialExecucao = galpaoEsc?.nome ?? filialOrigem;
      separacaoGalpaoId = rota.galpao_id;
    } else {
      // Sem cobertura: fallback origem (degrada pra reserva-orphan ou falha
      // em criarReservasPedido). O front-end já deveria estar bloqueando
      // este caso via decisaoIsAvailable.
      empresaExecucaoId = pedido.empresa_origem_id;
      filialExecucao = filialOrigem;
      separacaoGalpaoId = empresaOrigem.galpaoId;
      logger.warn("aprovar", "Roteamento sem cobertura — fallback origem", {
        pedidoId,
        rota_decisao: rota.decisao,
        rota_motivo: (rota as { motivo?: string }).motivo,
      });
    }
  }

  // Build markers (LVR já foi inserido no Tiny no recebimento via webhook-processor,
  // mas mantemos no array do DB para refletir o estado completo do pedido)
  const marcadores: string[] =
    decisao === "oc" ? ["OC", filialOrigem, "LVR"] : [filialExecucao, "LVR"];

  // Quando decisao manual é propria/transferencia, criar as reservas R
  // atomicamente ANTES de transitar status. Se algum item falhar, estorna
  // parciais e devolve 409 sem mexer no pedido. OC permanece intocado
  // (não reserva).
  if (decisao === "propria" || decisao === "transferencia") {
    const reservaResult = await criarReservasPedido({
      supabase,
      pedidoId,
      // empresaOrigemId pra resolver produto: siso_pedido_itens.produto_id é o
      // tiny_produto_id da empresa origem (gravado pelo webhook). Em
      // transferência, empresaExecucaoId é a empresa-tag do galpão destino, que
      // pode ter um tiny_produto_id diferente pro mesmo SKU.
      empresaOrigemId: pedido.empresa_origem_id,
      separacaoGalpaoId,
    });
    if (!reservaResult.ok) {
      return NextResponse.json(reservaResult.body, { status: 409 });
    }
  }

  // Update order to "executando"
  const { error: updateError } = await supabase
    .from("siso_pedidos")
    .update({
      status: "executando",
      decisao_final: decisao,
      operador_id: operadorId ?? null,
      operador_nome: operadorNome ?? null,
      tipo_resolucao: "manual",
      marcadores,
      separacao_galpao_id: separacaoGalpaoId,
      status_separacao:
        decisao === "oc"
          ? null
          : pedido.nota_fiscal_id && pedido.chave_acesso_nf
            ? "aguardando_separacao"
            : "aguardando_nf",
    })
    .eq("id", pedidoId);

  if (updateError) {
    logger.error("aprovar", "Failed to update order", {
      pedidoId,
      supabaseError: updateError.message,
    });
    return NextResponse.json(
      { error: updateError.message },
      { status: 500 },
    );
  }

  // Enqueue execution job (with empresa_id for worker)
  const { error: queueError } = await supabase
    .from("siso_fila_execucao")
    .insert({
      pedido_id: pedidoId,
      tipo: "lancar_estoque",
      filial_execucao: filialExecucao,
      empresa_id: empresaExecucaoId,
      decisao,
      operador_id: operadorId ?? null,
      operador_nome: operadorNome ?? null,
    });

  if (queueError) {
    logger.error("aprovar", "Failed to enqueue job", {
      pedidoId,
      decisao,
      supabaseError: queueError.message,
    });
    // Don't fail — the order status is already updated
  }

  registrarEvento({
    pedidoId,
    evento: "aprovado",
    usuarioId: operadorId,
    usuarioNome: operadorNome,
    detalhes: { decisao, filialExecucao, empresaExecucaoId },
  }).catch(() => {});

  logger.info("aprovar", "Pedido aprovado", {
    pedidoId,
    decisao,
    filialExecucao,
    empresaExecucaoId,
    operador: operadorNome,
  });

  // Kick the worker after response is sent — singleton loop drains all pending jobs
  after(() => {
    kickWorker().catch((err) => {
      logger.error("aprovar", "Worker kick failed", {
        pedidoId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  return NextResponse.json({
    ok: true,
    pedidoId,
    decisao,
    filialExecucao,
    empresaExecucaoId,
    status: "executando",
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers privados do handler
// ────────────────────────────────────────────────────────────────────────────

type ReservaResult =
  | { ok: true; reservasCriadas: number }
  | { ok: false; body: Record<string, unknown> };

/**
 * Cria reservas R atomicamente pra cada item do pedido. Tudo-ou-nada:
 * se alguma falhar, estorna as N-1 já criadas via estornarReservaIndividual
 * e retorna { ok: false, body } pra o handler devolver 409.
 *
 * Idempotência: se já existe qualquer R com origem_id=pedidoId, skipa todo
 * o bloco e retorna ok: true, reservasCriadas: 0.
 */
async function criarReservasPedido(args: {
  supabase: ReturnType<typeof createServiceClient>;
  pedidoId: string;
  /**
   * Empresa origem do pedido — usada pra resolver `tiny_produto_id` em
   * `siso_pedido_itens.produto_id` (que foi gravado pelo webhook com o id
   * do Tiny da empresa que recebeu o pedido). Em transferência, a empresa
   * que executa a saída pode ser diferente — mas o tiny_produto_id no item
   * continua sendo da origem.
   */
  empresaOrigemId: string;
  separacaoGalpaoId: string;
}): Promise<ReservaResult> {
  const { supabase, pedidoId, empresaOrigemId, separacaoGalpaoId } = args;

  // TOCTOU note: o SELECT abaixo + o loop de INSERTs subsequentes formam
  // uma janela onde 2 aprovar() concorrentes pro mesmo pedidoId podem
  // ambos passar pela idempotência e criar 2×N reservas. Mitigação atual:
  // o handler já checa `pedido.status !== 'pendente'` antes de chegar aqui
  // (line 67), reduzindo a janela ao tempo entre o SELECT do pedido e o
  // UPDATE. Pra cenários de double-click via UI, é janela <500ms; pra
  // chamadas API concorrentes, considerar partial unique index ou
  // restruturar pra UPDATE-then-SELECT-affected antes do bloco de
  // reservas. Bug aceitável até evidência de problema real em produção.
  // 1. Idempotência: R *pendente* já existe pro pedido?
  //    Ledger é imutável — uma R "consumida" continua viva como linha. O que
  //    importa pra idempotência é se existe R sem L estorno apontando (=
  //    reserva ainda válida). Sem esse filtro, re-aprovação após reset (ou
  //    qualquer fluxo que libere a R por L) skipa criar R nova erroneamente.
  const { data: jaR, error: jaRErr } = await supabase
    .from("siso_movimentacoes")
    .select("id")
    .eq("origem_id", pedidoId)
    .eq("origem_tipo", "reserva_pedido")
    .eq("tipo", "R");
  if (jaRErr) {
    logger.error("aprovar.reservas", "Falha ao checar reservas existentes", {
      pedidoId,
      err: jaRErr.message,
    });
    return {
      ok: false,
      body: { error: "reserva_falhou", motivo: "db_error", detalhe: jaRErr.message },
    };
  }
  if ((jaR?.length ?? 0) > 0) {
    const reservaIds = (jaR ?? []).map((r) => r.id as string);
    const { data: liberadas, error: libErr } = await supabase
      .from("siso_movimentacoes")
      .select("estorno_de")
      .in("estorno_de", reservaIds)
      .eq("tipo", "L");
    if (libErr) {
      logger.error("aprovar.reservas", "Falha ao checar L estorno", {
        pedidoId,
        err: libErr.message,
      });
      return {
        ok: false,
        body: { error: "reserva_falhou", motivo: "db_error", detalhe: libErr.message },
      };
    }
    const liberadasSet = new Set<string>(
      (liberadas ?? [])
        .map((l) => l.estorno_de as string | null)
        .filter((id): id is string => !!id),
    );
    const pendentes = reservaIds.filter((id) => !liberadasSet.has(id));
    if (pendentes.length > 0) {
      logger.info("aprovar.reservas", "Reservas pendentes já existentes — skip", {
        pedidoId,
        pendentes: pendentes.length,
      });
      return { ok: true, reservasCriadas: 0 };
    }
    logger.info("aprovar.reservas", "Rs antigas todas liberadas — segue criando novas", {
      pedidoId,
      antigas: reservaIds.length,
    });
  }

  // 2. Itens do pedido
  const { data: itens, error: itensErr } = await supabase
    .from("siso_pedido_itens")
    .select("id, produto_id, sku, quantidade_pedida")
    .eq("pedido_id", pedidoId);
  if (itensErr) {
    logger.error("aprovar.reservas", "Falha ao buscar itens do pedido", {
      pedidoId,
      err: itensErr.message,
    });
    return {
      ok: false,
      body: { error: "reserva_falhou", motivo: "db_error", detalhe: itensErr.message },
    };
  }
  if (!itens || itens.length === 0) {
    logger.warn("aprovar.reservas", "Pedido sem itens", { pedidoId });
    return { ok: true, reservasCriadas: 0 };
  }

  // 3. Loop atômico
  const criadas: string[] = []; // ids das R criadas (pra rollback)
  for (const item of itens) {
    const qty = Number(item.quantidade_pedida ?? 0);
    if (qty <= 0) continue;

    try {
      const produtoWmsId = await resolverProdutoWms(
        empresaOrigemId,
        String(item.produto_id),
      );
      const locId = await buscarLocComMaiorSaldoNoGalpao(
        separacaoGalpaoId,
        produtoWmsId,
      );
      if (!locId) {
        const rb = await rollbackReservas(criadas, pedidoId);
        return {
          ok: false,
          body: {
            error: "reserva_falhou",
            motivo: "sem_saldo",
            item: { sku: item.sku, produto_id_tiny: item.produto_id, qty },
            rollback: rb,
          },
        };
      }

      const reservaId = await reservarAtomico({
        tripla: {
          produto_id: produtoWmsId,
          galpao_id: separacaoGalpaoId,
          localizacao_id: locId,
        },
        qty,
        pedido_id: pedidoId,
        ttl_horas: 24 * 30, // 30 dias, alinhado com webhook-processor-wms
      });
      criadas.push(reservaId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const rb = await rollbackReservas(criadas, pedidoId);

      // Classificação por regex sobre err.message é frágil — depende das
      // strings literais retornadas por `resolverProdutoWms` (em
      // `src/lib/separacao/wms-mapping.ts`) e pelo RPC
      // `wms_reservar_atomico` (PL/pgSQL). Se essas mensagens mudarem,
      // a classificação degrada silenciosamente pra `erro_runtime`. Fix
      // proper: typed error classes (MapeamentoAusenteError,
      // SaldoInsuficienteError) ou .code property exportadas pelos
      // modules de origem. Pendente — não bloqueia release.
      const motivo = /mapeado em siso_produto_empresas/i.test(msg)
        ? "mapeamento_ausente"
        : /saldo|reserva|disponivel/i.test(msg)
          ? "saldo_insuficiente"
          : "erro_runtime";

      return {
        ok: false,
        body: {
          error: "reserva_falhou",
          motivo,
          item: { sku: item.sku, produto_id_tiny: item.produto_id, qty },
          rollback: rb,
          detalhe: msg,
        },
      };
    }
  }

  logger.info("aprovar.reservas", "Reservas criadas", {
    pedidoId,
    total: criadas.length,
  });
  return { ok: true, reservasCriadas: criadas.length };
}

async function rollbackReservas(
  reservaIds: string[],
  pedidoId: string,
): Promise<{ tentativas: number; sucesso: number; falhou: number; orfas_ids: string[] }> {
  let sucesso = 0;
  const orfas: string[] = [];
  for (const rId of reservaIds) {
    try {
      await estornarReservaIndividual({
        reserva_id: rId,
        motivo: "rollback_aprovacao",
      });
      sucesso++;
    } catch (err) {
      orfas.push(rId);
      logger.error("aprovar.reservas", "Falha ao estornar R em rollback", {
        pedidoId,
        reservaId: rId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    tentativas: reservaIds.length,
    sucesso,
    falhou: orfas.length,
    orfas_ids: orfas,
  };
}
