"use client";

import { useEffect, useRef } from "react";
import {
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

interface RealtimeSeparacaoConfig {
  /**
   * Pedido IDs to scope realocação invalidations. When a realocação event
   * fires, we only invalidate the supplied queryKey if the event's
   * parent pedido is in this list.
   */
  pedidoIds: string[];
  /**
   * Optional override. Defaults to the queryClient from useQueryClient().
   */
  queryClient?: QueryClient;
  /**
   * Query key to invalidate on realocação events (and on pedido events
   * affecting the scoped pedidoIds).
   */
  queryKey: QueryKey;
}

/**
 * Subscribes to siso_pedidos changes via Supabase Realtime.
 *
 * - When called with no args (legacy mode): invalidates the global
 *   ["separacao"] queryKey on any siso_pedidos change. Used by the
 *   /wms/separacao list page.
 * - When called with a config: additionally subscribes to
 *   siso_pedido_item_realocacoes and invalidates the supplied queryKey
 *   when an event affects one of the scoped pedidoIds. Used by the
 *   wave-picking checklist page.
 */
export function useRealtimeSeparacao(config?: RealtimeSeparacaoConfig) {
  const fallbackQueryClient = useQueryClient();
  const channelRef = useRef<RealtimeChannel | null>(null);
  const realocChannelRef = useRef<RealtimeChannel | null>(null);

  const queryClient = config?.queryClient ?? fallbackQueryClient;
  const scopedPedidoIds = config?.pedidoIds;
  const scopedQueryKey = config?.queryKey;
  // Stable key for effect deps (avoids retriggering on array identity churn).
  const pedidoIdsKey = scopedPedidoIds ? scopedPedidoIds.join(",") : "";
  // Stable key for the queryKey (objects/arrays would re-trigger otherwise).
  const queryKeyHash = scopedQueryKey ? JSON.stringify(scopedQueryKey) : "";

  // ─── siso_pedidos: legacy global invalidation OR scoped invalidation ───
  useEffect(() => {
    const channel = supabase
      .channel("siso_pedidos_changes")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_pedidos",
        },
        (payload) => {
          if (scopedQueryKey && scopedPedidoIds) {
            const pedidoId =
              ((payload.new as Record<string, unknown> | null)?.id as
                | string
                | undefined) ??
              ((payload.old as Record<string, unknown> | null)?.id as
                | string
                | undefined);
            if (pedidoId && scopedPedidoIds.includes(pedidoId)) {
              queryClient.invalidateQueries({ queryKey: scopedQueryKey });
            }
          } else {
            queryClient.invalidateQueries({ queryKey: ["separacao"] });
          }
        },
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
    // queryKeyHash + pedidoIdsKey capture the scoped config changes; we
    // intentionally exclude scopedQueryKey/scopedPedidoIds object identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, pedidoIdsKey, queryKeyHash]);

  // ─── siso_pedido_item_realocacoes: only when scoped config provided ───
  useEffect(() => {
    if (!scopedQueryKey || !scopedPedidoIds || scopedPedidoIds.length === 0) {
      return;
    }

    const channelName = `realocs-${pedidoIdsKey}`;
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "siso_pedido_item_realocacoes",
        },
        async (payload) => {
          const realocItemId =
            ((payload.new as Record<string, unknown> | null)
              ?.pedido_item_id as string | undefined) ??
            ((payload.old as Record<string, unknown> | null)
              ?.pedido_item_id as string | undefined);
          if (!realocItemId) return;

          const { data: item } = await supabase
            .from("siso_pedido_itens")
            .select("pedido_id")
            .eq("id", realocItemId)
            .maybeSingle();

          if (
            item &&
            scopedPedidoIds.includes(item.pedido_id as string)
          ) {
            queryClient.invalidateQueries({ queryKey: scopedQueryKey });
          }
        },
      )
      .subscribe();

    realocChannelRef.current = channel;

    return () => {
      if (realocChannelRef.current) {
        supabase.removeChannel(realocChannelRef.current);
        realocChannelRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, pedidoIdsKey, queryKeyHash]);
}
