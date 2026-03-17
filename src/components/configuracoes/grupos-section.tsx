"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Plus, PlugZap, Shield, Trash2, X } from "lucide-react";
import type { GalpaoHierarquia, GrupoInfo } from "./types";

export function GruposSection({
  grupos,
  galpoes,
  loading,
  onRefresh,
}: {
  grupos: GrupoInfo[];
  galpoes: GalpaoHierarquia[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const [addingGrupo, setAddingGrupo] = useState(false);
  const [newGrupoNome, setNewGrupoNome] = useState("");
  const [savingGrupo, setSavingGrupo] = useState(false);

  // Flat list of all empresas for the "add empresa" dropdown
  const allEmpresas = galpoes.flatMap((g) =>
    g.siso_empresas.map((e) => ({ id: e.id, nome: e.nome, cnpj: e.cnpj, galpao: g.nome })),
  );

  // Empresas already in any grupo
  const empresasInGrupo = new Set(
    grupos.flatMap((g) => g.siso_grupo_empresas.map((ge) => ge.siso_empresas.id)),
  );

  // Available empresas (not in any grupo yet)
  const availableEmpresas = allEmpresas.filter((e) => !empresasInGrupo.has(e.id));

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
            <GrupoCard
              key={grupo.id}
              grupo={grupo}
              availableEmpresas={availableEmpresas}
              onRefresh={onRefresh}
            />
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

// ─── Grupo card with add/remove empresas ─────────────────────────────────────

function GrupoCard({
  grupo,
  availableEmpresas,
  onRefresh,
}: {
  grupo: GrupoInfo;
  availableEmpresas: { id: string; nome: string; cnpj: string; galpao: string }[];
  onRefresh: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [selectedEmpresaId, setSelectedEmpresaId] = useState("");
  const [selectedTier, setSelectedTier] = useState(1);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  async function handleAddEmpresa() {
    if (!selectedEmpresaId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/grupos/${grupo.id}/empresas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ empresa_id: selectedEmpresaId, tier: selectedTier }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success("Empresa adicionada ao grupo");
      setAdding(false);
      setSelectedEmpresaId("");
      setSelectedTier(1);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao adicionar empresa");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemoveEmpresa(empresaId: string) {
    setRemoving(empresaId);
    try {
      const res = await fetch(`/api/admin/grupos/${grupo.id}/empresas/${empresaId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success("Empresa removida do grupo");
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao remover empresa");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-paper">
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
              className="flex items-center gap-2 px-3 sm:px-4 py-2 text-sm"
            >
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-zinc-100 font-mono text-[10px] font-bold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400 shrink-0">
                {ge.tier}
              </span>
              <span className="text-ink truncate">{ge.siso_empresas.nome}</span>
              <span className="font-mono text-[10px] text-ink-faint hidden sm:inline shrink-0">
                {ge.siso_empresas.cnpj}
              </span>
              <button
                type="button"
                onClick={() => handleRemoveEmpresa(ge.siso_empresas.id)}
                disabled={removing === ge.siso_empresas.id}
                className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded text-ink-faint transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-30 dark:hover:bg-red-950/30"
                title="Remover do grupo"
              >
                {removing === ge.siso_empresas.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
              </button>
            </div>
          ))}

        {/* Add empresa row */}
        {adding ? (
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 border-t border-line px-4 py-2.5">
            <select
              value={selectedEmpresaId}
              onChange={(e) => setSelectedEmpresaId(e.target.value)}
              className="flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-ink outline-none"
              autoFocus
            >
              <option value="">Selecionar empresa...</option>
              {availableEmpresas.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.nome} ({e.galpao}) — {e.cnpj}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-ink-faint">Tier</span>
                <input
                  type="number"
                  min="1"
                  value={selectedTier}
                  onChange={(e) => setSelectedTier(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-12 rounded-lg border border-line bg-surface px-1.5 py-1.5 text-center font-mono text-xs text-ink outline-none"
                />
              </div>
              <button
                onClick={handleAddEmpresa}
                disabled={!selectedEmpresaId || saving}
                className="btn-primary px-2.5 py-1.5 text-xs disabled:opacity-40"
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              </button>
              <button
                onClick={() => { setAdding(false); setSelectedEmpresaId(""); }}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            disabled={availableEmpresas.length === 0}
            className="flex w-full items-center justify-center gap-1.5 border-t border-line py-2.5 text-[11px] font-medium text-ink-faint transition-colors hover:bg-surface hover:text-ink-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
            Adicionar empresa
          </button>
        )}
      </div>
    </div>
  );
}
