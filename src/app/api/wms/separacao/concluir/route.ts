import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { registrarEventos } from "@/lib/historico-service";
import { preCriarAgrupamentosEmLote, recarregarEtiquetasFaltantes } from "@/lib/agrupamento-service";
import { dispararCutoverSePronto } from "@/lib/wms/cutover";
import { getSessionUser } from "@/lib/session";

/**
 * Estágios em 'separado' ou depois dele na ordem canônica de separação.
 * Pedido nesses estados já foi concluído — reconcluir é no-op, não falha.
 */
const STATUS_POS_SEPARADO = new Set([
  "separado",
  "embalado",
  "conferido",
  "expedido",
]);

/**
 * POST /api/separacao/concluir
 *
 * Finish separation for selected orders. Only pedidos where ALL items
 * have separacao_marcado = true are moved to 'separado'.
 *
 * Body: { pedido_ids: string[] }
 * Returns: { separados: string[], pendentes: string[] }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (
    !body?.pedido_ids ||
    !Array.isArray(body.pedido_ids) ||
    body.pedido_ids.length === 0 ||
    !body.pedido_ids.every((id: unknown) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "'pedido_ids' (string[]) é obrigatório" },
      { status: 400 },
    );
  }

  const { pedido_ids } = body as { pedido_ids: string[] };
  const supabase = createServiceClient();

  try {
    // Fetch all items for the given pedidos
    const { data: items, error: fetchError } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, separacao_marcado, compra_status, compra_quantidade_solicitada, compra_quantidade_recebida, sku",
      )
      .in("pedido_id", pedido_ids);

    if (fetchError) {
      logger.logError({
        error: fetchError,
        source: "separacao-concluir",
        message: "Failed to fetch items",
        category: "database",
        errorCode: fetchError.code,
        requestPath: "/api/wms/separacao/concluir",
        requestMethod: "POST",
        metadata: { pedido_ids, table: "siso_pedido_itens" },
      });
      return NextResponse.json(
        { error: fetchError.message },
        { status: 500 },
      );
    }

    // Coleta pedidos com realocações ainda em aguardando_picking — bloqueiam concluir.
    // Sem isso, um item parcial (separacao_marcado=true) com cascade pendente passaria
    // direto pra 'separado' sem o residual ter sido pego.
    const itemIds = (items ?? []).map((i) => i.id);
    const pedidosComRealocPendente = new Set<string>();
    if (itemIds.length > 0) {
      const { data: realocsPend } = await supabase
        .from("siso_pedido_item_realocacoes")
        .select("pedido_item_id, siso_pedido_itens!inner(pedido_id)")
        .in("pedido_item_id", itemIds)
        .eq("status", "aguardando_picking");
      for (const r of realocsPend ?? []) {
        const pid = (r.siso_pedido_itens as unknown as { pedido_id: string })
          .pedido_id;
        if (pid) pedidosComRealocPendente.add(pid);
      }
    }

    // Group items by pedido_id
    const itemsByPedido = new Map<
      string,
      { separacao_marcado: boolean | null; compra_status: string | null }[]
    >();
    for (const item of items ?? []) {
      const list = itemsByPedido.get(item.pedido_id) ?? [];
      list.push({
        separacao_marcado: item.separacao_marcado,
        compra_status: item.compra_status,
      });
      itemsByPedido.set(item.pedido_id, list);
    }

    const separados: string[] = [];
    const aguardandoCompra: string[] = [];
    const validacaoOc: string[] = [];
    const pendentes: string[] = [];

    for (const pid of pedido_ids) {
      const pedidoItems = itemsByPedido.get(pid);
      if (!pedidoItems || pedidoItems.length === 0) {
        pendentes.push(pid);
        continue;
      }

      // Pedido com realocação pendente sempre fica como pendente — o residual ainda
      // precisa ser pego, mesmo que separacao_marcado já esteja true nos itens.
      if (pedidosComRealocPendente.has(pid)) {
        pendentes.push(pid);
        continue;
      }

      // Items being handled by compras module or still pending OC validation
      // (not checked for separacao_marcado — they'll be resolved separately)
      const compraItems = pedidoItems.filter(
        (i) =>
          i.compra_status === "aguardando_compra" ||
          i.compra_status === "comprado" ||
          i.compra_status === "oc_pendente",
      );
      // Itens OC ainda NÃO decididos (ninguém clicou Encontrei/Esgotado) — o
      // pedido NÃO pode ir pra compras por arrasto: volta pra validacao_oc.
      const hasOcPendente = pedidoItems.some(
        (i) => i.compra_status === "oc_pendente",
      );
      // Normal items that need separacao_marcado check
      const normalItems = pedidoItems.filter(
        (i) =>
          i.compra_status !== "aguardando_compra" &&
          i.compra_status !== "comprado" &&
          i.compra_status !== "oc_pendente",
      );

      const allNormalMarcado =
        normalItems.length > 0
          ? normalItems.every((i) => i.separacao_marcado === true)
          : true;

      if (!allNormalMarcado) {
        pendentes.push(pid);
      } else if (hasOcPendente) {
        // Itens OC sem decisão explícita → pedido volta pra validação OC.
        // Só Esgotado explícito (ou o restante de uma contagem parcial) manda
        // item pra compras — concluir não decide pelo operador.
        validacaoOc.push(pid);
      } else if (compraItems.length > 0) {
        // All normal items marcado but has compra items → pause for purchases
        aguardandoCompra.push(pid);
      } else {
        // All items marcado, no compra items → fully separated
        separados.push(pid);
      }
    }

    // PR-1 safety: bloqueia conclusão por-pedido se algum item OC ainda não
    // foi totalmente coberto pelo recebimento (qty_recebida < qty_solicitada)
    // — evita 'separado' mentir. Aplica só ao conjunto que iria pra 'separado'
    // (aguardandoCompra pausa de propósito; pendentes já não avançam).
    //
    // Semântica de batch: pedidos com cobertura incompleta saem do bucket
    // `separados` e vão pro `coberturaIncompleta` na resposta (200, não 409),
    // pra não abortar `aguardandoCompra` e `separados` limpos do mesmo lote.
    // Skip: 'cancelado' (já hidden), 'indisponivel' (released, hidden — qty_recebida
    // foi zerada por buildCompraFieldReset, geraria false-positive), null (normal).
    const coberturaIncompleta: Array<{
      pedido_id: string;
      sku: string;
      recebido: number;
      solicitado: number;
      mensagem: string;
    }> = [];
    const pedidosComCoberturaIncompleta = new Set<string>();
    if (separados.length > 0) {
      const separadosSet = new Set(separados);
      for (const it of items ?? []) {
        if (!separadosSet.has(it.pedido_id)) continue;
        if (it.compra_status === "cancelado") continue;
        if (it.compra_status === "indisponivel") continue;
        if (it.compra_status === null) continue;
        const recebido = Number(it.compra_quantidade_recebida ?? 0);
        const solicitado = Number(it.compra_quantidade_solicitada ?? 0);
        if (recebido < solicitado) {
          pedidosComCoberturaIncompleta.add(it.pedido_id);
          coberturaIncompleta.push({
            pedido_id: it.pedido_id,
            sku: it.sku,
            recebido,
            solicitado,
            mensagem: `Item ${it.sku} aguardando recebimento (recebido ${recebido} de ${solicitado})`,
          });
        }
      }
    }

    // Filtra pedidos incompletos de `separados` — eles ficam pendentes de cobertura.
    const separadosCompletos = separados.filter(
      (pid) => !pedidosComCoberturaIncompleta.has(pid),
    );
    // Pedidos cujo UPDATE não casou o filtro de status. Só depois de reler o
    // status ATUAL dá pra saber se é "já estava lá" (no-op, retry do operador)
    // ou "mudou pra um estado inesperado" (race real).
    const naoClaimados: Array<{ pedido_id: string; destino: string }> = [];

    // Pedidos com itens OC sem decisão voltam pra validação OC (preserva o
    // pick dos normais; libera o operador da wave).
    if (validacaoOc.length > 0) {
      const { error: validacaoError } = await supabase
        .from("siso_pedidos")
        .update({
          status_separacao: "validacao_oc",
          separacao_operador_id: null,
          separacao_iniciada_em: null,
        })
        .in("id", validacaoOc)
        .eq("status_separacao", "em_separacao");

      if (validacaoError) {
        logger.logError({
          error: validacaoError,
          source: "separacao-concluir",
          message: "Failed to update pedidos to validacao_oc",
          category: "database",
          errorCode: validacaoError.code,
          requestPath: "/api/wms/separacao/concluir",
          requestMethod: "POST",
          metadata: { validacaoOc, table: "siso_pedidos" },
        });
        return NextResponse.json(
          { error: validacaoError.message },
          { status: 500 },
        );
      }
    }

    // Update pedidos transitioning to aguardando_compra (partial — waiting for purchases)
    let aguardandoCompraAtualizados = aguardandoCompra;
    if (aguardandoCompra.length > 0) {
      const { data: claimadosCompra, error: compraError } = await supabase
        .from("siso_pedidos")
        .update({
          status_separacao: "aguardando_compra",
          // Do NOT set separacao_concluida_em — this is a partial pause, not completion
          // Do NOT reset separacao_marcado/bipado_completo — preserve pick state
        })
        .in("id", aguardandoCompra)
        // Um item pode mandar o pedido inteiro para validacao_oc enquanto os
        // itens normais continuam sendo separados. Ao concluir os normais
        // depois da decisão Esgotado, esse é um estado de origem válido.
        .in("status_separacao", ["em_separacao", "validacao_oc"])
        .select("id");

      if (compraError) {
        logger.logError({
          error: compraError,
          source: "separacao-concluir",
          message: "Failed to update pedidos to aguardando_compra",
          category: "database",
          errorCode: compraError.code,
          requestPath: "/api/wms/separacao/concluir",
          requestMethod: "POST",
          metadata: { aguardandoCompra, table: "siso_pedidos" },
        });
        return NextResponse.json(
          { error: compraError.message },
          { status: 500 },
        );
      }

      const claimadosCompraSet = new Set(
        (claimadosCompra ?? []).map((pedido) => String(pedido.id)),
      );
      aguardandoCompraAtualizados = aguardandoCompra.filter((pid) =>
        claimadosCompraSet.has(pid),
      );
      for (const pid of aguardandoCompra) {
        if (!claimadosCompraSet.has(pid)) {
          naoClaimados.push({ pedido_id: pid, destino: "aguardando_compra" });
        }
      }
    }

    // Update fully completed pedidos to 'separado' (apenas os com cobertura OK)
    // P2-SEP-06: o filtro de status agora aceita em_separacao E aguardando_separacao
    // — o estado "tudo marcado + aguardando_separacao" existe (marcar-item aceita
    // marcar nesse status). Sem isso, um pedido nesse estado não casava o
    // `.eq("em_separacao")`, o UPDATE atualizava 0 linhas e a resposta mentia
    // "separado". `.select("id")` devolve os ids realmente claimados pra detectar
    // quem ficou de fora.
    let claimadosSeparado = new Set<string>();
    if (separadosCompletos.length > 0) {
      const { data: claimados, error: updateError } = await supabase
        .from("siso_pedidos")
        .update({
          status_separacao: "separado",
          separacao_concluida_em: new Date().toISOString(),
        })
        .in("id", separadosCompletos)
        .in("status_separacao", [
          "em_separacao",
          "aguardando_separacao",
          "validacao_oc",
        ])
        .select("id");

      if (updateError) {
        logger.logError({
          error: updateError,
          source: "separacao-concluir",
          message: "Failed to update pedidos to separado",
          category: "database",
          errorCode: updateError.code,
          requestPath: "/api/wms/separacao/concluir",
          requestMethod: "POST",
          metadata: { separados: separadosCompletos, table: "siso_pedidos" },
        });
        return NextResponse.json(
          { error: updateError.message },
          { status: 500 },
        );
      }

      // Pedidos que NÃO foram claimados: ou já estavam em 'separado'+ (retry do
      // operador / outro operador concluiu antes) ou o status mudou pra algo
      // inesperado. A classificação vem depois, relendo o status atual.
      const claimadosSet = new Set((claimados ?? []).map((p) => String(p.id)));
      for (const pid of separadosCompletos) {
        if (!claimadosSet.has(pid)) {
          naoClaimados.push({ pedido_id: pid, destino: "separado" });
        }
      }
      claimadosSeparado = claimadosSet;
    }

    // Reconcilia os não-claimados com o status ATUAL. Concluir é idempotente:
    // pedido que já está em 'separado' ou depois (embalado/conferido/expedido)
    // já passou por aqui — não é falha, é no-op. Só o que ficou em outro estado
    // (aguardando_compra por mando de compras, cancelado, voltou etapa…) vira
    // aviso de verdade.
    const jaConcluidos: string[] = [];
    const naoConcluidos: Array<{ pedido_id: string; motivo: string }> = [];
    if (naoClaimados.length > 0) {
      const { data: atuais } = await supabase
        .from("siso_pedidos")
        .select("id, status_separacao")
        .in(
          "id",
          naoClaimados.map((n) => n.pedido_id),
        );
      const statusAtual = new Map(
        (atuais ?? []).map((p) => [
          String(p.id),
          (p.status_separacao as string | null) ?? null,
        ]),
      );
      for (const { pedido_id, destino } of naoClaimados) {
        const atual = statusAtual.get(pedido_id) ?? null;
        if (atual !== null && (STATUS_POS_SEPARADO.has(atual) || atual === destino)) {
          jaConcluidos.push(pedido_id);
        } else {
          naoConcluidos.push({
            pedido_id,
            motivo: atual ? `status_atual:${atual}` : "status_desconhecido",
          });
        }
      }
    }

    // Só os que REALMENTE viraram 'separado' agora disparam cutover/histórico/
    // agrupamento — os `jaConcluidos` já dispararam na conclusão original.
    const separadosConcluidos = separadosCompletos.filter((pid) =>
      claimadosSeparado.has(pid),
    );

    logger.info("separacao-concluir", "Separação concluída", {
      separados: separadosConcluidos,
      jaConcluidos,
      naoConcluidos,
      aguardandoCompra: aguardandoCompraAtualizados,
      validacaoOc,
      pendentes,
      coberturaIncompleta: [...pedidosComCoberturaIncompleta],
    });

    // History: pedidos devolvidos pra validação OC
    if (validacaoOc.length > 0) {
      registrarEventos(
        validacaoOc.map((pid) => ({
          pedidoId: pid,
          evento: "status_revertido" as const,
          usuarioId: session.id,
          usuarioNome: session.nome,
          detalhes: {
            motivo: "concluir_com_oc_pendente",
            para: "validacao_oc",
          },
        })),
      ).catch(() => {});
    }

    // Record history for pedidos transitioning to aguardando_compra
    if (aguardandoCompraAtualizados.length > 0) {
      registrarEventos(
        aguardandoCompraAtualizados.map((pid) => ({
          pedidoId: pid,
          evento: "separacao_aguardando_compra" as const,
          usuarioId: session.id,
          usuarioNome: session.nome,
        })),
      ).catch(() => {});
    }

    // Record history for completed pedidos
    if (separadosConcluidos.length > 0) {
      registrarEventos(
        separadosConcluidos.map((pid) => ({
          pedidoId: pid,
          evento: "separacao_concluida" as const,
          usuarioId: session.id,
          usuarioNome: session.nome,
        })),
      ).catch(() => {});

      // WMS cutover R→L+S: pedido entrou no conjunto forward (separado).
      // Helper é idempotente — dispara se NF já emitida (caso normal).
      for (const pid of separadosConcluidos) {
        dispararCutoverSePronto(pid).catch((err) => {
          logger.warn("separacao-concluir", "Falha ao disparar cutover", {
            pedidoId: pid,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }

      // Fire-and-forget: ensure agrupamentos exist and ZPL labels are cached.
      // This is a second chance — the first attempt was at iniciar time.
      // 1. Create agrupamentos for any pedidos that don't have one yet
      preCriarAgrupamentosEmLote(separadosConcluidos).catch((err) => {
        logger.error("separacao-concluir", "Falha ao pré-criar agrupamentos no concluir", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // 2. Re-download ZPL for pedidos that have agrupamento but missing ZPL
      recarregarEtiquetasFaltantes(separadosConcluidos).catch((err) => {
        logger.error("separacao-concluir", "Falha ao recarregar etiquetas faltantes", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return NextResponse.json({
      separados: separadosConcluidos,
      ja_concluidos: jaConcluidos,
      aguardandoCompra: aguardandoCompraAtualizados,
      validacaoOc,
      pendentes,
      nao_concluidos: naoConcluidos,
      cobertura_incompleta: coberturaIncompleta,
    });
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-concluir",
      message: "Unexpected error in concluir",
      category: "unknown",
      requestPath: "/api/wms/separacao/concluir",
      requestMethod: "POST",
      metadata: { pedido_ids },
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
