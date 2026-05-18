"use client";
import { useEffect, useState } from "react";
import { wmsApi } from "@/lib/wms/api-client";

interface Evento {
  id: string;
  cor: "verde" | "amarelo" | "vermelho";
  tipo: string;
  origem_tipo: string;
  origem_id: string | null;
  loc_codigo: string;
  sku: string;
  descricao: string;
  quantidade: number;
  saldo_anterior: number;
  saldo_posterior: number;
  criado_em: string;
}

interface Props {
  sessaoId: string;
}

const cores: Record<Evento["cor"], string> = {
  verde: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  amarelo: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  vermelho: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

const icones: Record<Evento["cor"], string> = {
  verde: "✓",
  amarelo: "↗",
  vermelho: "⚠",
};

function relativo(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function descricaoEvento(e: Evento): string {
  if (e.origem_tipo === "inventario") return `bipe ${e.quantidade}× ${e.sku} em ${e.loc_codigo}`;
  if (e.origem_tipo === "nf_venda") return `saída ${e.quantidade}× ${e.sku} de ${e.loc_codigo} · pedido ${e.origem_id ?? ""}`;
  if (e.origem_tipo === "recebimento") return `entrada ${e.quantidade}× ${e.sku} em ${e.loc_codigo}`;
  return `${e.tipo} ${e.quantidade}× ${e.sku} em ${e.loc_codigo} · ${e.origem_tipo}`;
}

export function FeedEventos({ sessaoId }: Props) {
  const [eventos, setEventos] = useState<Evento[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function carregar() {
      try {
        const r = await wmsApi<{ eventos: Evento[] }>(
          `/api/wms/inventario/${sessaoId}/eventos?limit=50`,
        );
        if (!cancelled) setEventos(r.eventos);
      } catch {
        // silencioso
      }
    }
    carregar();
    const t = setInterval(carregar, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sessaoId]);

  if (eventos.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-8 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
        Sem eventos ainda. A sessão tá quieta.
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-zinc-950 p-4 font-mono text-sm text-zinc-200">
      <div className="mb-3 flex items-center justify-between text-xs uppercase tracking-wider text-zinc-500">
        <span><span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />ao vivo</span>
        <span>{eventos.length} eventos</span>
      </div>
      <div className="space-y-1">
        {eventos.map((e) => (
          <div key={e.id} className="flex gap-3 py-1">
            <span className="text-zinc-500">{relativo(e.criado_em)}</span>
            <span className={`rounded px-2 ${cores[e.cor]}`}>
              {icones[e.cor]} {descricaoEvento(e)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
