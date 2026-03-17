"use client";

import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { MapPin } from "lucide-react";

/**
 * Compact galpão selector for operators to switch between warehouses.
 * - Single galpão: shows as static badge
 * - Multiple galpões: shows clickable pills with "Todos" option
 * - No galpões: hidden
 */
export function GalpaoSelector() {
  const { user, activeGalpaoId, setActiveGalpao } = useAuth();

  const galpoes = user?.galpoes ?? [];
  if (galpoes.length === 0) return null;

  // Single galpão — show static badge
  if (galpoes.length === 1) {
    return (
      <div className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1">
        <MapPin className="h-3 w-3 text-ink-faint" />
        <span className="text-[11px] font-semibold text-ink">{galpoes[0].nome}</span>
      </div>
    );
  }

  // Multiple galpões — show pills
  const isAdmin = user?.cargos?.includes("admin");

  return (
    <div className="flex items-center gap-1">
      <MapPin className="h-3 w-3 text-ink-faint shrink-0" />
      {isAdmin && (
        <button
          type="button"
          onClick={() => setActiveGalpao(null)}
          className={cn(
            "rounded-md px-2 py-0.5 text-[11px] font-semibold transition-all",
            !activeGalpaoId
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "bg-surface text-ink-muted hover:text-ink",
          )}
        >
          Todos
        </button>
      )}
      {galpoes.map((g) => (
        <button
          key={g.id}
          type="button"
          onClick={() => setActiveGalpao(g.id)}
          className={cn(
            "rounded-md px-2 py-0.5 text-[11px] font-semibold transition-all",
            activeGalpaoId === g.id
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "bg-surface text-ink-muted hover:text-ink",
          )}
        >
          {g.nome}
        </button>
      ))}
    </div>
  );
}
