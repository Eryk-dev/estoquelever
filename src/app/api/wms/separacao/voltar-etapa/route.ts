import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";
import { registrarEventos } from "@/lib/historico-service";
import { dispararCutoverSePronto, reverterCutoverSeRetrocedeu } from "@/lib/wms/cutover";
import { resetarEstadoSeparacaoItens } from "@/lib/separacao/reset-state";
import type { StatusSeparacao } from "@/types";

/**
 * POST /api/separacao/voltar-etapa
 *
 * Admin-only: move one or more pedidos to ANY separation stage
 * (forward or backward). Cleans up item-level data appropriately.
 *
 * Headers: X-Session-Id
 * Body: { pedido_ids: string[], novo_status: StatusSeparacao }
 */

// P2-SEP-07: 'expedido' é escrito na coluna mas fica fora do type StatusSeparacao
// (gotcha conhecido). Incluído aqui no fim da ordem pra destravar o hop reverso
// expedido→embalado — antes 'expedido' era beco sem saída (nenhuma rota revertia).
// O hop expedido→embalado só muda status_separacao: 'embalado' (target) está muito
// além dos limiares de reset de pick (≤ aguardando_separacao/em_separacao/separado),
// então NÃO dispara resetarEstadoSeparacaoItens — estoque/NF/etiqueta intactos.
// E reverterCutoverSeRetrocedeu(novoStatus='embalado') é no-op (embalado ainda é
// forward) → nada de estoque mexido nesse hop.
type StatusOrdem = StatusSeparacao | "expedido";

const STATUS_ORDER: StatusOrdem[] = [
  "aguardando_nf",
  "validacao_oc",
  "aguardando_separacao",
  "em_separacao",
  "pendente_realocacao",
  "separado",
  "embalado",
  "conferido",
  "expedido",
];

export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  // AUTH check: ação admin-only (pode pular validações e estornar mov_saida).
  if (!userCan(session, "separacao.administrar")) {
    return NextResponse.json({ error: "sem permissão pra alterar etapa" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);

  // Accept both pedido_ids (array) and pedido_id (single) for backwards compat
  const pedidoIds: string[] = body?.pedido_ids ?? (body?.pedido_id ? [body.pedido_id] : []);
  const novoStatus: StatusOrdem | undefined = body?.novo_status;

  if (pedidoIds.length === 0 || !pedidoIds.every((id: unknown) => typeof id === "string") || !novoStatus) {
    return NextResponse.json(
      { error: "'pedido_ids' (string[]) e 'novo_status' são obrigatórios" },
      { status: 400 },
    );
  }

  if (!STATUS_ORDER.includes(novoStatus)) {
    return NextResponse.json({ error: "status inválido" }, { status: 400 });
  }

  const targetIdx = STATUS_ORDER.indexOf(novoStatus);
  const supabase = createServiceClient();

  // Fetch current pedidos
  const { data: pedidos, error: fetchErr } = await supabase
    .from("siso_pedidos")
    .select("id, numero, status_separacao")
    .in("id", pedidoIds);

  if (fetchErr || !pedidos || pedidos.length === 0) {
    return NextResponse.json({ error: "pedidos_nao_encontrados" }, { status: 404 });
  }

  // Filter pedidos that are at a DIFFERENT status than target
  const validIds = pedidos
    .filter((p) => {
      const currentIdx = STATUS_ORDER.indexOf(p.status_separacao as StatusOrdem);
      return currentIdx !== targetIdx && currentIdx >= 0;
    })
    .map((p) => p.id);

  if (validIds.length === 0) {
    return NextResponse.json(
      { error: "nenhum pedido pode ser movido para esse status" },
      { status: 400 },
    );
  }

  // Determine direction for each pedido
  const goingBack = pedidos.some((p) => {
    const currentIdx = STATUS_ORDER.indexOf(p.status_separacao as StatusOrdem);
    return currentIdx > targetIdx;
  });
  const goingForward = pedidos.some((p) => {
    const currentIdx = STATUS_ORDER.indexOf(p.status_separacao as StatusOrdem);
    return currentIdx < targetIdx;
  });

  try {
    // Build update for siso_pedidos
    const pedidoUpdate: Record<string, unknown> = {
      status_separacao: novoStatus,
    };

    // ── Going backward: clean up future-stage data ──────────────────────
    if (goingBack) {
      if (targetIdx <= STATUS_ORDER.indexOf("aguardando_separacao")) {
        pedidoUpdate.separacao_iniciada_em = null;
        pedidoUpdate.separacao_concluida_em = null;
        pedidoUpdate.separacao_operador_id = null;
        pedidoUpdate.embalagem_concluida_em = null;
      } else if (targetIdx <= STATUS_ORDER.indexOf("em_separacao")) {
        pedidoUpdate.separacao_concluida_em = null;
        pedidoUpdate.embalagem_concluida_em = null;
      } else if (targetIdx <= STATUS_ORDER.indexOf("separado")) {
        pedidoUpdate.embalagem_concluida_em = null;
      }

      // Conferência de embalagem: voltar pra antes de 'conferido' invalida a
      // conferência (re-conferir depois); voltar pra antes de 'embalado'
      // invalida também o registro de quem embalou fisicamente.
      if (targetIdx <= STATUS_ORDER.indexOf("embalado")) {
        pedidoUpdate.conferido_por = null;
        pedidoUpdate.conferido_em = null;
        pedidoUpdate.divergencia_tipo = null;
        pedidoUpdate.divergencia_obs = null;
      }
      if (targetIdx <= STATUS_ORDER.indexOf("separado")) {
        pedidoUpdate.embalado_real_por = null;
        pedidoUpdate.embalado_real_em = null;
      }

      // Keep etiqueta/agrupamento data — never clear cached ZPL labels
    }

    // ── Going forward: set timestamps ───────────────────────────────────
    if (goingForward) {
      const now = new Date().toISOString();

      if (targetIdx >= STATUS_ORDER.indexOf("em_separacao")) {
        pedidoUpdate.separacao_iniciada_em = now;
        pedidoUpdate.separacao_operador_id = session.id;
      }
      if (targetIdx >= STATUS_ORDER.indexOf("separado")) {
        pedidoUpdate.separacao_concluida_em = now;
      }
      if (targetIdx >= STATUS_ORDER.indexOf("embalado")) {
        pedidoUpdate.embalagem_concluida_em = now;
      }
      // Só o hop EXPLÍCITO pra 'conferido' marca conferência — avançar direto
      // pra 'expedido' não fabrica conferido_por (contaminaria o relatório).
      if (targetIdx === STATUS_ORDER.indexOf("conferido")) {
        pedidoUpdate.conferido_em = now;
        pedidoUpdate.conferido_por = session.id;
      }
    }

    // Update pedidos
    const { error: updateErr } = await supabase
      .from("siso_pedidos")
      .update(pedidoUpdate)
      .in("id", validIds);

    if (updateErr) {
      logger.logError({
        error: updateErr,
        source: "voltar-etapa",
        message: "Failed to update pedidos",
        category: "database",
        errorCode: updateErr.code,
        requestPath: "/api/wms/separacao/voltar-etapa",
        requestMethod: "POST",
        metadata: { validIds, novoStatus },
      });
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // Clear etiqueta_status via RPC for each pedido (PostgREST schema cache workaround)
    if (goingBack) {
      await Promise.all(
        validIds.map((pid) =>
          supabase.rpc("siso_set_etiqueta_status", { p_pedido_id: pid, p_status: null })
        )
      );
    }

    // ── Item-level cleanup (backward) ───────────────────────────────────
    if (goingBack) {
      if (targetIdx <= STATUS_ORDER.indexOf("aguardando_separacao")) {
        // Full reset: usa helper compartilhado pra estornar mov_saida_id,
        // cancelar realocs, resetar parciais e registrar evento de auditoria.
        // recriarReservas (SEP-06): o reset ressuscita as R's das S's de pick
        // que estorna — sem isso o pedido voltava pra aguardando_separacao com
        // 0 reservas (a RPC do reverterCutoverSeRetrocedeu abaixo pula S's já
        // estornadas via NOT EXISTS, então não recriava nada). O reverter
        // continua responsável pelas S's residuais do cutover (origem
        // nf_venda não ligadas a item) + flipar estoque_lancado=false; os
        // conjuntos são disjuntos, sem double-estorno nem R duplicada.
        const { data: itensReset } = await supabase
          .from("siso_pedido_itens")
          .select("id")
          .in("pedido_id", validIds);

        await resetarEstadoSeparacaoItens({
          supabase,
          itemIds: (itensReset ?? []).map((i) => i.id),
          usuarioId: session.id,
          motivo: "voltar_etapa",
          recriarReservas: true,
        });

        // Campos não cobertos pelo helper (auditoria de embalagem)
        await supabase
          .from("siso_pedido_itens")
          .update({
            bipado_em: null,
            bipado_por: null,
          })
          .in("pedido_id", validIds);
      } else if (targetIdx <= STATUS_ORDER.indexOf("em_separacao")) {
        await supabase
          .from("siso_pedido_itens")
          .update({
            quantidade_bipada: 0,
            bipado_completo: false,
            bipado_em: null,
            bipado_por: null,
          })
          .in("pedido_id", validIds);
      } else if (targetIdx <= STATUS_ORDER.indexOf("separado")) {
        await supabase
          .from("siso_pedido_itens")
          .update({
            bipado_completo: false,
            bipado_em: null,
            bipado_por: null,
          })
          .in("pedido_id", validIds);
      }
    }

    // ── Item-level completion (forward) ─────────────────────────────────
    if (goingForward) {
      const now = new Date().toISOString();

      if (targetIdx >= STATUS_ORDER.indexOf("separado")) {
        // Mark all items as picked
        await supabase
          .from("siso_pedido_itens")
          .update({
            separacao_marcado: true,
            separacao_marcado_em: now,
          })
          .in("pedido_id", validIds)
          .eq("separacao_marcado", false);
      }

      if (targetIdx >= STATUS_ORDER.indexOf("embalado")) {
        // Mark all items as scanned for packing
        const { data: itens } = await supabase
          .from("siso_pedido_itens")
          .select("id, pedido_id, quantidade_pedida")
          .in("pedido_id", validIds);

        if (itens && itens.length > 0) {
          for (const item of itens) {
            await supabase
              .from("siso_pedido_itens")
              .update({
                quantidade_bipada: item.quantidade_pedida,
                bipado_completo: true,
                bipado_em: now,
                bipado_por: session.id,
              })
              .eq("id", item.id);
          }
        }
      }
    }

    // WMS cutover R→L+S coherence:
    //   - Forward para conjunto {separado, embalado, expedido}: dispararCutoverSePronto
    //   - Backward saindo do conjunto forward com estoque_lancado=true: reverterCutoverSeRetrocedeu
    // Ambos são idempotentes e checkam a invariante internamente — chamar
    // os dois pra cada pid é seguro (um vira no-op pelo motivo).
    for (const pid of validIds) {
      await dispararCutoverSePronto(pid).catch((err) => {
        logger.warn("voltar-etapa", "Falha ao disparar cutover", {
          pedidoId: pid,
          err: err instanceof Error ? err.message : String(err),
        });
      });
      await reverterCutoverSeRetrocedeu(pid, novoStatus, "voltar_etapa", session.id).catch(
        (err) => {
          logger.warn("voltar-etapa", "Falha ao reverter cutover", {
            pedidoId: pid,
            err: err instanceof Error ? err.message : String(err),
          });
        },
      );
    }

    // Record in history
    registrarEventos(
      validIds.map((pid) => {
        const original = pedidos.find((p) => p.id === pid);
        return {
          pedidoId: pid,
          evento: "status_revertido" as const,
          usuarioId: session.id,
          usuarioNome: session.nome,
          detalhes: {
            de: original?.status_separacao ?? "desconhecido",
            para: novoStatus,
            direcao: goingForward ? "avanco" : "retorno",
          },
        };
      }),
    ).catch(() => {});

    logger.info("voltar-etapa", "Status alterado em lote", {
      pedido_ids: validIds,
      novo_status: novoStatus,
      total: String(validIds.length),
      direcao: goingForward && goingBack ? "misto" : goingForward ? "avanco" : "retorno",
      admin: session.nome,
    });

    return NextResponse.json({
      ok: true,
      pedidos_atualizados: validIds,
      total: validIds.length,
      novo_status: novoStatus,
    });
  } catch (err) {
    logger.logError({
      error: err,
      source: "voltar-etapa",
      message: "Unexpected error",
      category: "unknown",
      requestPath: "/api/wms/separacao/voltar-etapa",
      requestMethod: "POST",
      metadata: { pedidoIds, novoStatus },
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
