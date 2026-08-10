"use client";

import { useAuth } from "@/lib/auth-context";
import { getGalpaoAccent } from "@/lib/domain-helpers";
import { cn } from "@/lib/utils";

/**
 * Compact galpão selector for operators to switch between warehouses.
 * - Single galpão: shows as static badge with accent color
 * - Multiple galpões: shows clickable pills with "Todos" option
 * - No galpões: hidden
 */
export function GalpaoSelector() {
  const { user, activeGalpaoId, setActiveGalpao } = useAuth();

  const galpoes = user?.galpoes ?? [];
  if (galpoes.length === 0) return null;

  // Single galpão — show static badge with accent color
  if (galpoes.length === 1) {
    const accent = getGalpaoAccent(galpoes[0].nome);
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1">
        <span className={cn("h-2 w-2 rounded-full shrink-0", accent.dot)} />
        <span className="text-xs font-semibold text-ink">{galpoes[0].nome}</span>
        {!galpoes[0].pode_editar && (
          <span className="text-[10px] text-ink-muted">somente leitura</span>
        )}
      </div>
    );
  }

  // Multiple galpões — contained pill-bar
  const isAdmin = user?.cargos?.includes("admin");

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5">
      {isAdmin && (
        <button
          type="button"
          onClick={() => setActiveGalpao(null)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-semibold transition-all",
            !activeGalpaoId
              ? "bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900"
              : "text-ink-muted hover:text-ink hover:bg-paper",
          )}
        >
          Todos
        </button>
      )}
      {galpoes.map((g) => {
        const accent = getGalpaoAccent(g.nome);
        return (
          <button
            key={g.id}
            type="button"
            onClick={() => setActiveGalpao(g.id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-semibold transition-all",
              activeGalpaoId === g.id
                ? cn(accent.pillBg, "shadow-sm")
                : "text-ink-muted hover:text-ink hover:bg-paper",
            )}
          >
            {g.nome}{!g.pode_editar ? " · leitura" : ""}
          </button>
        );
      })}
    </div>
  );
}
