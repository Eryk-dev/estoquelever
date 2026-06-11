/**
 * Helper compartilhado pra resetar o estado de separação de items.
 *
 * Centraliza a lógica hoje duplicada/divergente em:
 *   - `encaminhar/route.ts`
 *   - `reiniciar/route.ts`
 *   - `voltar-etapa/route.ts` (caminho backward)
 *   - `produto-esgotado/route.ts` (modo encaminhar)
 *
 * Comportamento (spec § 2.1):
 *  1. Carrega items + realocs + links de ponte (siso_pedido_item_mov_links).
 *  2. Estorna `item.mov_saida_id` (se existe e ainda não estornada).
 *  3. Estorna `realoc.mov_saida_id` pra realocs com status 'picado' | 'picado_parcial'.
 *  3b. (opt-in `recriarReservas` — SEP-06) Ressuscita R's das L's de pick
 *      (`estornarLiberacaoReserva`) + estorna R's cascade residuais. Usado por
 *      voltar_etapa/reiniciar, onde o pedido fica no galpão aguardando re-pick.
 *  4. Cancela realocs em 'aguardando_picking' (batch UPDATE).
 *  5. Reseta campos do item (10 fields — vide spec linha 211).
 *  6. Apaga linhas órfãs de `siso_pedido_item_mov_links`.
 *  7. Registra evento `'separacao_resetada'` por pedido com `{ motivo, item_ids, estornadas }`.
 *
 * Bug C2 guard: `mov_ajuste_loc_zerou_id` NUNCA é estornada — mov ajuste reflete
 * descoberta física e deve permanecer permanente. Apenas o link da tabela ponte
 * `tipo_link='ajuste_loc_zerou'` é apagado.
 *
 * Dedupe: `item.mov_saida_id` e links com `tipo_link='saida'` podem apontar pro
 * mesmo `mov_id`. O helper deduplica via Set antes de chamar `estornarMovimentacao`.
 *
 * Idempotência: erros do tipo "já estornada" são logados como warn e a mov é
 * pulada (não entra em `estornadas`). Re-rodar o helper duas vezes seguidas é
 * seguro.
 *
 * Erros não-idempotentes (DB, "mov não encontrada", etc) são logados como error
 * e **re-lançados** pro caller — seguir com reset destrutivo escondendo a falha
 * mentiria pra ele e dificultaria recuperação manual.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { estornarMovimentacao } from "@/lib/wms/ledger";
import { estornarLiberacaoReserva } from "@/lib/wms/reservas-picking";
import { registrarEvento } from "@/lib/historico-service";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "separacao-reset-state";

export type ResetMotivo = "encaminhar" | "reiniciar" | "voltar_etapa" | "esgotado";

export interface ResetResult {
  estornadas: string[];
  realocsCanceladas: number;
  reservasRecriadas: number;
}

interface ItemRow {
  id: number;
  pedido_id: string;
  mov_saida_id: string | null;
  mov_ajuste_loc_zerou_id: string | null;
  separacao_parcial: boolean | null;
  quantidade_pega: number | null;
}

interface RealocRow {
  id: string;
  pedido_item_id: number;
  status: "aguardando_picking" | "picado" | "picado_parcial" | "cancelado";
  mov_saida_id: string | null;
}

interface LinkRow {
  id: string;
  pedido_item_id: number;
  mov_id: string;
  qty: number;
  tipo_link: "saida" | "ajuste_loc_zerou" | "liberacao_reserva" | "reserva_cascade";
}

export async function resetarEstadoSeparacaoItens(opts: {
  supabase: SupabaseClient;
  itemIds: number[];
  usuarioId: string;
  motivo: ResetMotivo;
  /**
   * SEP-06: quando true, ressuscita as reservas das L's de pick (e estorna as
   * R's cascade residuais) depois de estornar as S's. Usar pra motivos em que
   * o pedido CONTINUA no mesmo galpão aguardando re-pick (voltar_etapa,
   * reiniciar) — sem isso o pedido volta pra fila com 0 reservas e outro
   * pedido rouba o saldo. NÃO usar em encaminhar/esgotado: lá o pedido sai do
   * galpão (ou vira OC) e as R's recriadas segurariam saldo indevidamente.
   */
  recriarReservas?: boolean;
  estornarMov?: typeof estornarMovimentacao;
  estornarLiberacao?: typeof estornarLiberacaoReserva;
}): Promise<ResetResult> {
  const { supabase, itemIds, usuarioId, motivo } = opts;
  const estornar = opts.estornarMov ?? estornarMovimentacao;
  const ressuscitar = opts.estornarLiberacao ?? estornarLiberacaoReserva;
  const recriarReservas = opts.recriarReservas ?? false;
  const estornadas: string[] = [];
  let realocsCanceladas = 0;
  let reservasRecriadas = 0;

  if (itemIds.length === 0) {
    return { estornadas, realocsCanceladas, reservasRecriadas };
  }

  // 1. Load items, realocs, bridge links
  const { data: itemsRaw } = await supabase
    .from("siso_pedido_itens")
    .select("id, pedido_id, mov_saida_id, mov_ajuste_loc_zerou_id, separacao_parcial, quantidade_pega")
    .in("id", itemIds);

  const items = (itemsRaw ?? []) as ItemRow[];
  if (items.length === 0) {
    return { estornadas, realocsCanceladas, reservasRecriadas };
  }

  const { data: realocsRaw } = await supabase
    .from("siso_pedido_item_realocacoes")
    .select("id, pedido_item_id, status, mov_saida_id")
    .in("pedido_item_id", itemIds);
  const realocs = (realocsRaw ?? []) as RealocRow[];

  const { data: linksRaw } = await supabase
    .from("siso_pedido_item_mov_links")
    .select("id, pedido_item_id, mov_id, qty, tipo_link")
    .in("pedido_item_id", itemIds);
  const links = (linksRaw ?? []) as LinkRow[];

  // 2. Collect mov_ids of OUTPUT (saida) movs to estornar.
  //    Includes: item.mov_saida_id + bridge links of tipo_link='saida' + realoc.mov_saida_id (when picado/picado_parcial)
  //    EXCLUDES: item.mov_ajuste_loc_zerou_id and links of tipo_link='ajuste_loc_zerou' (bug C2 — never estornar ajuste movs)
  const movsToEstornar = new Set<string>();
  for (const it of items) {
    if (it.mov_saida_id) movsToEstornar.add(it.mov_saida_id);
  }
  for (const lk of links) {
    if (lk.tipo_link === "saida") movsToEstornar.add(lk.mov_id);
  }
  for (const r of realocs) {
    if ((r.status === "picado" || r.status === "picado_parcial") && r.mov_saida_id) {
      movsToEstornar.add(r.mov_saida_id);
    }
  }

  // 3. Estornar each — handle "already estornada" gracefully (idempotency).
  //    Outros erros (DB, mov não encontrada, etc) re-lançam pra caller decidir:
  //    seguir adiante com reset destrutivo escondendo a falha mentiria pra ela.
  for (const movId of movsToEstornar) {
    try {
      await estornar({
        mov_id: movId,
        usuario_id: usuarioId,
        motivo: `Reset de separação (motivo=${motivo})`,
      });
      estornadas.push(movId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "já é um estorno" ou "já foi estornada" — idempotência tolera
      if (/já\s+(é\s+um\s+estorno|foi\s+estornada)/i.test(msg)) {
        logger.warn(LOG_SOURCE, "Mov já estornada — skip", { mov_id: movId, motivo });
        continue;
      }
      // Outros erros: loga e re-lança — caller (route handler) decide o que fazer.
      logger.error(LOG_SOURCE, "Falha ao estornar mov", {
        mov_id: movId,
        motivo,
        error: msg,
      });
      throw err;
    }
  }

  // 3b. (opt-in SEP-06) Ressuscita as reservas das L's de pick. O pick converte
  //     R→L+S; o estorno da S (passo 3) devolve o saldo mas NÃO recria a
  //     reserva — sem este passo o pedido volta pra fila com 0 R's e qualquer
  //     pedido novo roteia em cima do saldo (re-pick → 409). Espelha
  //     desfazer-parcial: `estornarLiberacaoReserva` é idempotente (R
  //     existente com estorno_de=L é retornada sem duplicar).
  if (recriarReservas) {
    const itemById = new Map(items.map((it) => [it.id, it]));
    for (const lk of links) {
      if (lk.tipo_link !== "liberacao_reserva") continue;
      const pedidoId = itemById.get(lk.pedido_item_id)?.pedido_id;
      if (!pedidoId) continue;
      try {
        await ressuscitar({
          liberacao_mov_id: lk.mov_id,
          pedido_id: pedidoId,
          usuario_id: usuarioId,
          motivo: `Reset de separação (motivo=${motivo}) — recria reserva`,
        });
        reservasRecriadas++;
      } catch (err) {
        // LOUD: sem a R recriada o saldo volta livre e outro pedido pode
        // rotear em cima (overselling). O reset segue (S já estornada), mas
        // registra erro real pro supervisor — espelha desfazer-parcial.
        logger.logError({
          error: err,
          source: LOG_SOURCE,
          message: "Falhou recriar reserva (estorno de L) — item fica sem R",
          category: "business_logic",
          metadata: { mov_id: lk.mov_id, pedido_item_id: lk.pedido_item_id, motivo },
        });
      }
    }

    // 3c. Estorna R's cascade (residuais de parcial/realocação). A R original
    //     ressuscitada em 3b já cobre a quantidade do item — manter a cascade
    //     viva duplicaria reserva. Cascade já consumida por pick de realoc
    //     (L com estorno_de=R) cai no ramo "já estornada" (idempotência).
    for (const lk of links) {
      if (lk.tipo_link !== "reserva_cascade") continue;
      try {
        await estornar({
          mov_id: lk.mov_id,
          usuario_id: usuarioId,
          motivo: `Reset de separação (motivo=${motivo}) — estorna R cascade`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/já\s+(é\s+um\s+estorno|foi\s+estornada)/i.test(msg)) {
          logger.warn(LOG_SOURCE, "R cascade já estornada — skip", { mov_id: lk.mov_id, motivo });
          continue;
        }
        // Falha aqui deixa reserva EXTRA viva (over-reserve, TTL 30d) — direção
        // conservadora, não bloqueia o reset. Espelha desfazer-parcial.
        logger.warn(LOG_SOURCE, "Falha ao estornar R cascade (segue)", {
          mov_id: lk.mov_id,
          motivo,
          error: msg,
        });
      }
    }
  }

  // 4. Cancel realocs in 'aguardando_picking' (batch UPDATE)
  const aguardandoIds = realocs.filter((r) => r.status === "aguardando_picking").map((r) => r.id);
  if (aguardandoIds.length > 0) {
    const { error } = await supabase
      .from("siso_pedido_item_realocacoes")
      .update({
        status: "cancelado",
      })
      .in("id", aguardandoIds);
    if (error) {
      logger.error(LOG_SOURCE, "Falha ao cancelar realocs aguardando", {
        ids: aguardandoIds,
        motivo,
        error: error.message,
      });
    } else {
      realocsCanceladas = aguardandoIds.length;
    }
  }

  // 5. Reset campos do item (10 fields — spec linha 211)
  const { error: resetError } = await supabase
    .from("siso_pedido_itens")
    .update({
      separacao_marcado: false,
      separacao_marcado_em: null,
      quantidade_pega: null,
      separacao_parcial: false,
      parcial_motivo: null,
      parcial_em: null,
      parcial_por: null,
      mov_saida_id: null,
      mov_ajuste_loc_zerou_id: null,
      quantidade_bipada: 0,
      bipado_completo: false,
    })
    .in("id", itemIds);
  if (resetError) {
    logger.error(LOG_SOURCE, "Falha ao resetar campos dos items", {
      itemIds,
      motivo,
      error: resetError.message,
    });
  }

  // 6. Apagar links órfãos (sem distinção de tipo — todos os links do item perdem sentido após reset)
  if (links.length > 0) {
    const { error: delError } = await supabase
      .from("siso_pedido_item_mov_links")
      .delete()
      .in("pedido_item_id", itemIds);
    if (delError) {
      logger.error(LOG_SOURCE, "Falha ao apagar links de ponte", {
        itemIds,
        motivo,
        error: delError.message,
      });
    }
  }

  // 7. Registra evento `separacao_resetada` por pedido (agrupa items por pedido_id)
  const itemsPorPedido = new Map<string, number[]>();
  for (const it of items) {
    const arr = itemsPorPedido.get(it.pedido_id) ?? [];
    arr.push(it.id);
    itemsPorPedido.set(it.pedido_id, arr);
  }
  for (const [pedidoId, ids] of itemsPorPedido) {
    await registrarEvento({
      pedidoId,
      evento: "separacao_resetada",
      usuarioId,
      detalhes: {
        motivo,
        item_ids: ids,
        estornadas: estornadas,
        realocs_canceladas: realocsCanceladas,
        reservas_recriadas: reservasRecriadas,
      },
    });
  }

  logger.info(LOG_SOURCE, "Reset de separação aplicado", {
    motivo,
    itemIds,
    estornadas,
    realocsCanceladas,
    reservasRecriadas,
  });

  return { estornadas, realocsCanceladas, reservasRecriadas };
}
