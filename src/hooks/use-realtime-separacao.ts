"use client";

import { useEffect, useRef, useCallback } from "react";
import {
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

/**
 * Janela de debounce (ms) pra coalescer múltiplos eventos realtime numa
 * só invalidação. Eventos em rajada (ex.: cancelar pedido emite N updates
 * nos itens + 1 no pedido) viram uma única refetch.
 */
const REFETCH_DEBOUNCE_MS = 500;

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
 *   ["wms-separacao"] queryKey on any siso_pedidos change. Used by the
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

  // ─── Debounce invalidations ───
  // Rajadas de eventos (cancelar emite N updates) coalescem em 1 refetch.
  // Mapa por queryKeyHash pra escopar timers — invalidação do "separacao"
  // global não deve esperar/cancelar a do scopedQueryKey.
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const debouncedInvalidate = useCallback(
    (queryKey: QueryKey) => {
      const hash = JSON.stringify(queryKey);
      const existing = debounceTimers.current.get(hash);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        debounceTimers.current.delete(hash);
        queryClient.invalidateQueries({ queryKey });
      }, REFETCH_DEBOUNCE_MS);
      debounceTimers.current.set(hash, timer);
    },
    [queryClient],
  );

  // Cleanup global: limpa timers pendentes ao desmontar o hook.
  useEffect(() => {
    const timers = debounceTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

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
              debouncedInvalidate(scopedQueryKey);
            }
          } else {
            // The separação list query is keyed ["wms-separacao", ...]; React
            // Query invalidation is prefix-matched, so invalidating the legacy
            // ["separacao"] key matched nothing and the realtime push was dead
            // (list only refreshed via the 10s poll). Use the real key prefix.
            debouncedInvalidate(["wms-separacao"]);
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
  }, [queryClient, pedidoIdsKey, queryKeyHash, debouncedInvalidate]);

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
            debouncedInvalidate(scopedQueryKey);
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
  }, [queryClient, pedidoIdsKey, queryKeyHash, debouncedInvalidate]);
}
