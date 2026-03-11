"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Building2, ChevronDown, Loader2, PlugZap, Unplug } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConnectionCard } from "./connection-card";
import type { EmpresaHierarquia, TinyConnection } from "./types";

export function EmpresaRow({
  empresa,
  connection,
  onRefresh,
}: {
  empresa: EmpresaHierarquia;
  connection: TinyConnection | null;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);

  async function handleCreateConnection() {
    setCreating(true);
    try {
      const res = await fetch("/api/tiny/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ empresa_id: empresa.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success("Conexão Tiny criada — configure as credenciais OAuth2");
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar conexão");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="border-b border-line/50 last:border-b-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-surface/50"
      >
        <Building2 className="h-3.5 w-3.5 text-ink-faint" />
        <span className="text-sm font-medium text-ink">{empresa.nome}</span>
        <span className="font-mono text-[10px] text-ink-faint">{empresa.cnpj}</span>

        {/* Grupo + tier badge */}
        {empresa.grupo && (
          <span className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-semibold text-purple-600 dark:bg-purple-950/40 dark:text-purple-400">
            {empresa.grupo.nome}
            {empresa.tier && <span className="opacity-60">T{empresa.tier}</span>}
          </span>
        )}

        {/* Connection status */}
        {empresa.conexao?.conectado ? (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Conectado
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-ink-faint">
            <Unplug className="h-2.5 w-2.5" />
            {empresa.conexao ? "Não autorizado" : "Sem conexão"}
          </span>
        )}

        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-ink-faint transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {/* Expanded: show connection card or create button */}
      {expanded && connection && (
        <div className="mx-4 mb-3">
          <ConnectionCard connection={connection} onUpdated={onRefresh} />
        </div>
      )}
      {expanded && !connection && (
        <div className="px-4 pb-3">
          <p className="mb-2 text-xs italic text-ink-faint">
            Conexão Tiny não configurada para esta empresa.
          </p>
          <button
            onClick={handleCreateConnection}
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
          >
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlugZap className="h-3 w-3" />}
            Conectar Tiny
          </button>
        </div>
      )}
    </div>
  );
}
