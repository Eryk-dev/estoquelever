"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Plus, Warehouse } from "lucide-react";
import { GalpaoCard } from "./galpao-card";
import type { GalpaoHierarquia, TinyConnection } from "./types";

export function GalpoesEmpresasSection({
  galpoes,
  connections,
  loading,
  onRefresh,
}: {
  galpoes: GalpaoHierarquia[];
  connections: TinyConnection[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const [addingGalpao, setAddingGalpao] = useState(false);
  const [newGalpaoNome, setNewGalpaoNome] = useState("");
  const [savingGalpao, setSavingGalpao] = useState(false);

  async function handleAddGalpao() {
    if (!newGalpaoNome.trim()) return;
    setSavingGalpao(true);
    try {
      const res = await fetch("/api/admin/galpoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: newGalpaoNome.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(`Galpão "${newGalpaoNome}" criado`);
      setNewGalpaoNome("");
      setAddingGalpao(false);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar galpão");
    } finally {
      setSavingGalpao(false);
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Warehouse className="h-4 w-4 text-ink-faint" />
        <h2 className="text-sm font-semibold text-ink">Galpões e Empresas</h2>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-ink-faint" />
        </div>
      ) : (
        <div className="space-y-3">
          {galpoes.map((galpao) => (
            <GalpaoCard
              key={galpao.id}
              galpao={galpao}
              connections={connections}
              onRefresh={onRefresh}
            />
          ))}

          {/* Add galpao */}
          {addingGalpao ? (
            <div className="flex items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-paper px-4 py-3 dark:border-zinc-700">
              <input
                type="text"
                value={newGalpaoNome}
                onChange={(e) => setNewGalpaoNome(e.target.value)}
                placeholder="Nome do galpão (ex: BH)"
                className="flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink outline-none"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleAddGalpao()}
              />
              <button
                onClick={handleAddGalpao}
                disabled={savingGalpao}
                className="btn-primary px-3 py-1.5 text-xs"
              >
                {savingGalpao ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Criar
              </button>
              <button
                onClick={() => { setAddingGalpao(false); setNewGalpaoNome(""); }}
                className="text-xs text-ink-faint hover:text-ink-muted"
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAddingGalpao(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 py-3 text-xs font-medium text-ink-faint transition-colors hover:border-zinc-400 hover:text-ink-muted dark:border-zinc-700 dark:hover:border-zinc-600"
            >
              <Plus className="h-3.5 w-3.5" />
              Adicionar galpão
            </button>
          )}
        </div>
      )}
    </section>
  );
}
