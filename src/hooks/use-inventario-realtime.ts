"use client";
import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

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

export function useInventarioRealtime(sessaoId: string | null) {
  const [contagens, setContagens] = useState<Contagem[]>([]);
  const [locs, setLocs] = useState<LocSessao[]>([]);

  useEffect(() => {
    if (!sessaoId) return;
    let cancelled = false;

    (async () => {
      const [c, l] = await Promise.all([
        sb
          .from("siso_inventario_contagens")
          .select("*")
          .eq("sessao_id", sessaoId),
        sb
          .from("siso_inventario_localizacoes")
          .select("*")
          .eq("sessao_id", sessaoId),
      ]);
      if (cancelled) return;
      setContagens((c.data ?? []) as Contagem[]);
      setLocs((l.data ?? []) as LocSessao[]);
    })();

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
