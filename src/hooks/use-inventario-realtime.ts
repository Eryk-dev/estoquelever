"use client";
import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { wmsApi } from "@/lib/wms/api-client";

// Cliente anônimo só pra subscribe ao Realtime channel.
// IMPORTANTE: a leitura inicial NÃO usa esse client — vai pelo
// endpoint /api/wms/inventario/[id] que é auth-gated. O channel só
// recebe eventos operacionais (contagens novas + atualizações de
// status de localização) que são informação de baixa sensibilidade.
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export interface Contagem {
  id: string;
  localizacao_id: string;
  produto_id: string;
  qty_contada: number;
  rodada: number;
  criado_em: string;
  contada_por: string;
}

export interface LocSessao {
  id: string;
  localizacao_id: string;
  status: string;
  bloqueada_por: string | null;
}

interface SessaoSnapshot {
  contagens?: Contagem[];
  localizacoes?: LocSessao[];
}

export function useInventarioRealtime(sessaoId: string | null) {
  const [contagens, setContagens] = useState<Contagem[]>([]);
  const [locs, setLocs] = useState<LocSessao[]>([]);

  useEffect(() => {
    if (!sessaoId) return;
    let cancelled = false;

    // 1. Snapshot inicial via API auth-gated (passa pelo session header).
    (async () => {
      try {
        const snap = await wmsApi<SessaoSnapshot>(
          `/api/wms/inventario/${sessaoId}`,
        );
        if (cancelled) return;
        setContagens((snap.contagens ?? []) as Contagem[]);
        setLocs((snap.localizacoes ?? []) as LocSessao[]);
      } catch {
        // Falha de auth/rede: estado fica vazio, UI mostra empty state.
      }
    })();

    // 2. Realtime: aplica eventos incrementalmente sobre o snapshot.
    const channel = sb
      .channel(`inventario:${sessaoId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "siso_inventario_contagens",
          filter: `sessao_id=eq.${sessaoId}`,
        },
        ({ new: r }) => setContagens((prev) => [...prev, r as Contagem]),
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "siso_inventario_localizacoes",
          filter: `sessao_id=eq.${sessaoId}`,
        },
        ({ new: r }) =>
          setLocs((prev) =>
            prev.map((x) =>
              x.id === (r as LocSessao).id ? (r as LocSessao) : x,
            ),
          ),
      )
      .subscribe();

    return () => {
      cancelled = true;
      sb.removeChannel(channel);
    };
  }, [sessaoId]);

  return { contagens, locs };
}
