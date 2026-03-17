"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, ChevronRight, Loader2, Plus, Warehouse } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmpresaRow } from "./empresa-row";
import type { GalpaoHierarquia, TinyConnection } from "./types";

export function GalpaoCard({
  galpao,
  connections,
  onRefresh,
}: {
  galpao: GalpaoHierarquia;
  connections: TinyConnection[];
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [addingEmpresa, setAddingEmpresa] = useState(false);
  const [newEmpresaNome, setNewEmpresaNome] = useState("");
  const [newEmpresaCnpj, setNewEmpresaCnpj] = useState("");
  const [savingEmpresa, setSavingEmpresa] = useState(false);

  async function handleAddEmpresa() {
    if (!newEmpresaNome.trim() || !newEmpresaCnpj.trim()) return;
    setSavingEmpresa(true);
    try {
      const res = await fetch("/api/admin/empresas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: newEmpresaNome.trim(),
          cnpj: newEmpresaCnpj.trim(),
          galpao_id: galpao.id,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(`Empresa "${newEmpresaNome}" criada`);
      setNewEmpresaNome("");
      setNewEmpresaCnpj("");
      setAddingEmpresa(false);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar empresa");
    } finally {
      setSavingEmpresa(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-paper">
      {/* Galpao header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface"
      >
        <Warehouse className="h-4 w-4 text-indigo-500" />
        <span className="text-sm font-bold text-ink">{galpao.nome}</span>
        {galpao.descricao && (
          <span className="text-xs text-ink-faint">{galpao.descricao}</span>
        )}
        <span className="ml-auto text-[11px] text-ink-faint">
          {galpao.siso_empresas.length} empresa{galpao.siso_empresas.length !== 1 ? "s" : ""}
        </span>
        <ChevronRight
          className={cn(
            "h-4 w-4 text-ink-faint transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded && (
        <div className="border-t border-line">
          {galpao.siso_empresas.map((empresa) => {
            const conn = connections.find((c) => c.cnpj === empresa.cnpj);
            return (
              <EmpresaRow
                key={empresa.id}
                empresa={empresa}
                connection={conn ?? null}
                onRefresh={onRefresh}
              />
            );
          })}
          {galpao.siso_empresas.length === 0 && (
            <p className="px-4 py-3 text-xs italic text-ink-faint">
              Nenhuma empresa neste galpão
            </p>
          )}

          {/* Add empresa */}
          {addingEmpresa ? (
            <div className="border-t border-line px-4 py-3">
              <div className="flex flex-col gap-2">
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={newEmpresaNome}
                    onChange={(e) => setNewEmpresaNome(e.target.value)}
                    placeholder="Nome da empresa"
                    className="flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink outline-none"
                    autoFocus
                  />
                  <input
                    type="text"
                    value={newEmpresaCnpj}
                    onChange={(e) => setNewEmpresaCnpj(e.target.value)}
                    placeholder="CNPJ"
                    className="w-full sm:w-40 rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-sm text-ink outline-none"
                    onKeyDown={(e) => e.key === "Enter" && handleAddEmpresa()}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleAddEmpresa}
                    disabled={savingEmpresa}
                    className="btn-primary px-3 py-1.5 text-xs"
                  >
                    {savingEmpresa ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    Criar
                  </button>
                  <button
                    onClick={() => { setAddingEmpresa(false); setNewEmpresaNome(""); setNewEmpresaCnpj(""); }}
                    className="text-xs text-ink-faint hover:text-ink-muted"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setAddingEmpresa(true)}
              className="flex w-full items-center justify-center gap-1.5 border-t border-line py-2.5 text-[11px] font-medium text-ink-faint transition-colors hover:bg-surface hover:text-ink-muted"
            >
              <Plus className="h-3 w-3" />
              Adicionar empresa
            </button>
          )}
        </div>
      )}
    </div>
  );
}
