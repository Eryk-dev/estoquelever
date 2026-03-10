"use client";

import { useState } from "react";
import { Building2, ChevronDown, Unplug } from "lucide-react";
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

      {/* Expanded: show connection card */}
      {expanded && connection && (
        <div className="mx-4 mb-3">
          <ConnectionCard connection={connection} onUpdated={onRefresh} />
        </div>
      )}
      {expanded && !connection && (
        <p className="px-4 pb-3 text-xs italic text-ink-faint">
          Conexão Tiny não configurada para esta empresa.
        </p>
      )}
    </div>
  );
}
