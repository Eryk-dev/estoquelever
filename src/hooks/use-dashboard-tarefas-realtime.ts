// src/hooks/use-dashboard-tarefas-realtime.ts
"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

/**
 * Subscreve às tabelas que afetam o quadro de tarefas da home /wms e
 * invalida o React Query a cada evento, forçando refetch.
 *
 * Lista canônica de subscribes (8 channels):
 *   1. `siso_pedidos`                 — pipeline aprovação / separação / embalagem
 *   2. `siso_wms_pendencias_guarda`   — coluna Guarda do kanban
 *   3. `siso_inventario_sessoes`      — ciclos de inventário em andamento
 *   4. `siso_inventario_operadores`   — party (entradas/saídas) e progresso
 *   5. `siso_pedido_itens`            — contadores de Compras (a_comprar / a_receber)
 *   6. `siso_devolucoes_pendentes`    — fila de devoluções aguardando classificação
 *   7. `siso_transferencias_galpao`   — transferências inter-galpão em trânsito
 *   8. `siso_movimentacoes` (tipo=R)  — reservas pendentes (R/L) que afetam disponível
 *
 * Quando `galpaoId` é null, subscreve sem filtros server-side (modo
 * "todos os galpões"). Quando muda, fecha os channels antigos e
 * reabre com novos filtros.
 *
 * **Filtro server-side por galpão (finding 1.14):** apenas 3 das 8 tables
 * têm coluna direta `galpao_id` e ganham `filter:` no `postgres_changes`:
 *   - `siso_pedidos` (col `separacao_galpao_id`)
 *   - `siso_wms_pendencias_guarda` (col `galpao_id`)
 *   - `siso_inventario_sessoes` (col `galpao_id`)
 * As outras 5 (operadores, pedido_itens, devolucoes, transf-galpao, movs-r)
 * permanecem sem filtro: ou não têm coluna de galpão na tabela, ou o galpão
 * só aparece por JOIN (custo aceitável = invalidação ruidosa, não vazamento
 * de dados — o React Query refaz a query server-side com o filtro correto).
 *
 * To smoke-test: temporarily add `console.log("[dt-realtime] invalidate", new Date())`
 * inside `invalidate` below, then trigger INSERT/UPDATE em cada uma das 8 tabelas via
 * `mcp__supabase__execute_sql` e confirmar log fires in browser console.
 */
export function useDashboardTarefasRealtime(galpaoId: string | null) {
  const queryClient = useQueryClient();
  const channelsRef = useRef<RealtimeChannel[]>([]);

  useEffect(() => {
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const invalidate = () => {
      if (pendingTimer) return;
      pendingTimer = setTimeout(() => {
        queryClient.invalidateQueries({
          queryKey: ["wms-tarefas-pendentes", galpaoId],
        });
        pendingTimer = null;
      }, 250);
    };

    const suffix = galpaoId ?? "all";

    const ch1 = supabase
      .channel(`dt-pedidos-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_pedidos",
          ...(galpaoId
            ? { filter: `separacao_galpao_id=eq.${galpaoId}` }
            : {}),
        },
        invalidate,
      )
      .subscribe();

    const ch2 = supabase
      .channel(`dt-guarda-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_wms_pendencias_guarda",
          ...(galpaoId ? { filter: `galpao_id=eq.${galpaoId}` } : {}),
        },
        invalidate,
      )
      .subscribe();

    const ch3 = supabase
      .channel(`dt-inv-sess-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_inventario_sessoes",
          ...(galpaoId ? { filter: `galpao_id=eq.${galpaoId}` } : {}),
        },
        invalidate,
      )
      .subscribe();

    const ch4 = supabase
      .channel(`dt-inv-op-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_inventario_operadores",
        },
        invalidate,
      )
      .subscribe();

    const ch5 = supabase
      .channel(`dt-pedido-itens-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_pedido_itens",
        },
        invalidate,
      )
      .subscribe();

    const ch6 = supabase
      .channel(`dt-devolucoes-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_devolucoes_pendentes",
        },
        invalidate,
      )
      .subscribe();

    const ch7 = supabase
      .channel(`dt-transf-galpao-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_transferencias_galpao",
        },
        invalidate,
      )
      .subscribe();

    const ch8 = supabase
      .channel(`dt-movs-r-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "siso_movimentacoes",
          filter: "tipo=eq.R",
        },
        invalidate,
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "siso_movimentacoes",
          filter: "tipo=eq.R",
        },
        invalidate,
      )
      .subscribe();

    channelsRef.current = [ch1, ch2, ch3, ch4, ch5, ch6, ch7, ch8];

    return () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      for (const ch of channelsRef.current) {
        supabase.removeChannel(ch);
      }
      channelsRef.current = [];
    };
  }, [galpaoId, queryClient]);
}
