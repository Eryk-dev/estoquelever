"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, PlugZap, Plus, Shield } from "lucide-react";
import type { GrupoInfo } from "./types";

export function GruposSection({
  grupos,
  loading,
  onRefresh,
}: {
  grupos: GrupoInfo[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const [addingGrupo, setAddingGrupo] = useState(false);
  const [newGrupoNome, setNewGrupoNome] = useState("");
  const [savingGrupo, setSavingGrupo] = useState(false);

  async function handleAddGrupo() {
    if (!newGrupoNome.trim()) return;
    setSavingGrupo(true);
    try {
      const res = await fetch("/api/admin/grupos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: newGrupoNome.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(`Grupo "${newGrupoNome}" criado`);
      setNewGrupoNome("");
      setAddingGrupo(false);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar grupo");
    } finally {
      setSavingGrupo(false);
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <PlugZap className="h-4 w-4 text-ink-faint" />
        <h2 className="text-sm font-semibold text-ink">Grupos de Empresas</h2>
      </div>

      <div className="mb-3 flex items-start gap-2 rounded-lg bg-blue-50 px-3 py-2 dark:bg-blue-950/30">
        <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
        <p className="text-xs text-blue-700 dark:text-blue-300">
          Empresas no mesmo grupo consultam estoque entre si. Empresas sem grupo
          não participam de consultas de suporte.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-ink-faint" />
        </div>
      ) : (
        <div className="space-y-3">
          {grupos.map((grupo) => (
            <div
              key={grupo.id}
              className="overflow-hidden rounded-xl border border-line bg-paper"
            >
              <div className="flex items-center gap-2 px-4 py-3">
                <span className="text-sm font-bold text-ink">{grupo.nome}</span>
                {grupo.descricao && (
                  <span className="text-xs text-ink-faint">{grupo.descricao}</span>
                )}
                <span className="ml-auto text-[11px] text-ink-faint">
                  {grupo.siso_grupo_empresas.length} empresa{grupo.siso_grupo_empresas.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="border-t border-line">
                {grupo.siso_grupo_empresas
                  .sort((a, b) => a.tier - b.tier)
                  .map((ge) => (
                    <div
                      key={ge.id}
                      className="flex items-center gap-2 px-4 py-2 text-sm"
                    >
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-zinc-100 font-mono text-[10px] font-bold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        {ge.tier}
                      </span>
                      <span className="text-ink">{ge.siso_empresas.nome}</span>
                      <span className="font-mono text-[10px] text-ink-faint">
                        {ge.siso_empresas.cnpj}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          ))}

          {addingGrupo ? (
            <div className="flex items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-paper px-4 py-3 dark:border-zinc-700">
              <input
                type="text"
                value={newGrupoNome}
                onChange={(e) => setNewGrupoNome(e.target.value)}
                placeholder="Nome do grupo"
                className="flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink outline-none"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleAddGrupo()}
              />
              <button
                onClick={handleAddGrupo}
                disabled={savingGrupo}
                className="btn-primary px-3 py-1.5 text-xs"
              >
                {savingGrupo ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Criar
              </button>
              <button
                onClick={() => { setAddingGrupo(false); setNewGrupoNome(""); }}
                className="text-xs text-ink-faint hover:text-ink-muted"
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAddingGrupo(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 py-3 text-xs font-medium text-ink-faint transition-colors hover:border-zinc-400 hover:text-ink-muted dark:border-zinc-700 dark:hover:border-zinc-600"
            >
              <Plus className="h-3.5 w-3.5" />
              Adicionar grupo
            </button>
          )}
        </div>
      )}
    </section>
  );
}
