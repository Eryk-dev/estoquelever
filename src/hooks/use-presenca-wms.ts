// src/hooks/use-presenca-wms.ts
"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";

export type FuncaoPresenca =
  | "separacao"
  | "embalagem"
  | "guarda"
  | "inventario";

const CHANNEL_NAME = "wms-presenca";

type PresenceMeta = {
  funcao: FuncaoPresenca;
  joined_at: number;
};

/**
 * Publica presença do usuário logado numa função operacional enquanto a aba
 * estiver aberta. Sair = desmonte do componente OU fechar aba (Supabase
 * Realtime detecta disconnect em ~30s e remove a presença automaticamente,
 * sem precisar de beforeunload nem heartbeat manual).
 *
 * Quando o usuário tem múltiplas abas com funções diferentes (ex.: separação
 * em uma, embalagem em outra), cada aba publica um ref próprio sob a mesma
 * `key`, e o agregador `useEstadoPresencaWms` lista o usuário em todas as
 * funções em que ele estiver presente.
 */
export function useTrackPresencaWms(funcao: FuncaoPresenca) {
  const { user } = useAuth();
  const usuarioId = user?.id ?? null;

  useEffect(() => {
    if (!usuarioId) return;

    const channel = supabase.channel(CHANNEL_NAME, {
      config: { presence: { key: usuarioId } },
    });

    let cancelled = false;
    channel.subscribe((status) => {
      if (cancelled) return;
      if (status === "SUBSCRIBED") {
        const meta: PresenceMeta = { funcao, joined_at: Date.now() };
        void channel.track(meta);
      }
    });

    return () => {
      cancelled = true;
      void channel.untrack();
      void supabase.removeChannel(channel);
    };
  }, [usuarioId, funcao]);
}

export type EstadoPresencaWms = {
  separacao: Set<string>;
  embalagem: Set<string>;
  guarda: Set<string>;
  inventario: Set<string>;
};

function emptyEstado(): EstadoPresencaWms {
  return {
    separacao: new Set(),
    embalagem: new Set(),
    guarda: new Set(),
    inventario: new Set(),
  };
}

/**
 * Subscreve ao canal global de presença sem publicar nada próprio e retorna
 * sets reativos (`usuario_id`) de quem está em cada função operacional.
 *
 * Consumido pelo `QuadroTarefas` da home /wms pra filtrar os avatares do
 * card de cada função: só aparece quem realmente tem a aba aberta. O dono
 * registrado em `siso_pedidos.separacao_operador_id` (e equivalentes) NÃO
 * muda — continua valendo pra retomada e auditoria.
 */
export function useEstadoPresencaWms(): EstadoPresencaWms {
  const [estado, setEstado] = useState<EstadoPresencaWms>(emptyEstado);

  useEffect(() => {
    const channel = supabase.channel(CHANNEL_NAME);

    const recompute = () => {
      const raw = channel.presenceState<PresenceMeta>();
      const next = emptyEstado();
      for (const [usuarioId, refs] of Object.entries(raw)) {
        for (const ref of refs) {
          const f = ref.funcao;
          if (f && f in next) {
            next[f].add(usuarioId);
          }
        }
      }
      setEstado(next);
    };

    channel
      .on("presence", { event: "sync" }, recompute)
      .on("presence", { event: "join" }, recompute)
      .on("presence", { event: "leave" }, recompute)
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  return estado;
}
