// src/hooks/use-pedidos-estoque-realtime.ts
"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

/**
 * Subscreve às tabelas de saldo (siso_estoque) e ledger (siso_movimentacoes)
 * pra invalidar a query ["wms-pedidos"] sempre que estoque mudar.
 *
 * Throttle de 2,5s pra coalescer rajadas (ex.: recebimento de NF com
 * 50 SKUs gera 50 UPDATEs em siso_estoque + 50 INSERTs em siso_movimentacoes
 * em sequência — não queremos 100 refetches). O timer NÃO é re-armado por
 * evento (o debounce trailing antigo nunca disparava sob fluxo contínuo de
 * movimentações e caía no poll de 30s): o primeiro evento agenda, os demais
 * coalescem — no máximo 1 refetch a cada 2,5s e freshness garantida ≤2,5s.
 *
 * Polling de 30s no React Query permanece como rede de segurança caso o
 * websocket caia.
 */
export function usePedidosEstoqueRealtime() {
  const queryClient = useQueryClient();
  const channelsRef = useRef<RealtimeChannel[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const scheduleInvalidate = () => {
      if (timerRef.current) return;
      timerRef.current = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["wms-pedidos"] });
        timerRef.current = null;
      }, 2_500);
    };

    const chEstoque = supabase
      .channel("wms-pedidos-estoque")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "siso_estoque" },
        scheduleInvalidate,
      )
      .subscribe();

    const chMovs = supabase
      .channel("wms-pedidos-movs")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "siso_movimentacoes" },
        scheduleInvalidate,
      )
      .subscribe();

    channelsRef.current = [chEstoque, chMovs];

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      for (const ch of channelsRef.current) {
        supabase.removeChannel(ch);
      }
      channelsRef.current = [];
    };
  }, [queryClient]);
}
