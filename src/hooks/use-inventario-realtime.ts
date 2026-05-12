"use client";
import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { wmsApi } from "@/lib/wms/api-client";

// Cliente anônimo só pra subscribe ao Realtime channel.
// IMPORTANTE: a leitura inicial NÃO usa esse client — vai pelo
// endpoint /api/wms/inventario/[id] que é auth-gated. O channel só
// recebe eventos operacionais (contagens, status de locs, slots de
// operadores) que são informação de baixa sensibilidade.
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export interface Contagem {
  id: string;
  localizacao_id: string;
  produto_id: string;
  empresa_dona_id: string;
  qty_contada: number;
  criado_em: string;
  contada_por: string;
  contada_por_user?: { nome?: string };
  produto?: { sku?: string; descricao?: string };
}

export interface LocSessao {
  id: string;
  localizacao_id: string;
  status: string;
  bloqueada_por: string | null;
  bloqueada_em: string | null;
  contagem_iniciada_em: string | null;
  contagem_finalizada_em: string | null;
  motivo: string | null;
  /** Slot (1..5) pré-atribuído ao operador. NULL = sem bucket (pool comum). */
  slot_atribuido: number | null;
  localizacao?: { codigo?: string; tipo?: string; zona?: string };
  bloqueada_por_user?: { nome?: string } | null;
}

export interface Operador {
  id: string;
  slot: number;
  sessao_id: string;
  usuario_id: string;
  entrou_em: string;
  finalizado_em: string | null;
  locs_contadas: number;
  ultima_acao_em: string;
  usuario?: { nome?: string };
}

interface SessaoSnapshot {
  contagens?: Contagem[];
  localizacoes?: LocSessao[];
  operadores?: Operador[];
}

export function useInventarioRealtime(sessaoId: string | null) {
  const [contagens, setContagens] = useState<Contagem[]>([]);
  const [locs, setLocs] = useState<LocSessao[]>([]);
  const [operadores, setOperadores] = useState<Operador[]>([]);

  useEffect(() => {
    if (!sessaoId) return;
    let cancelled = false;

    // 1. Snapshot inicial via API auth-gated
    (async () => {
      try {
        const snap = await wmsApi<SessaoSnapshot>(
          `/api/wms/inventario/${sessaoId}`,
        );
        if (cancelled) return;
        setContagens((snap.contagens ?? []) as Contagem[]);
        setLocs((snap.localizacoes ?? []) as LocSessao[]);
        setOperadores((snap.operadores ?? []) as Operador[]);
      } catch {
        // Falha de auth/rede: estado vazio, UI mostra empty state
      }
    })();

    // 2. Realtime: aplica eventos incrementalmente
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
        ({ new: r }) => setContagens((prev) => [r as Contagem, ...prev]),
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
              x.id === (r as LocSessao).id ? { ...x, ...(r as LocSessao) } : x,
            ),
          ),
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "siso_inventario_operadores",
          filter: `sessao_id=eq.${sessaoId}`,
        },
        ({ new: r }) => setOperadores((prev) => [...prev, r as Operador]),
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "siso_inventario_operadores",
          filter: `sessao_id=eq.${sessaoId}`,
        },
        ({ new: r }) =>
          setOperadores((prev) =>
            prev.map((x) =>
              x.id === (r as Operador).id ? { ...x, ...(r as Operador) } : x,
            ),
          ),
      )
      .subscribe();

    return () => {
      cancelled = true;
      sb.removeChannel(channel);
    };
  }, [sessaoId]);

  return { contagens, locs, operadores };
}
