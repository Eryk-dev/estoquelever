"use client";

import { useState } from "react";
import { Plus, X, Loader2 } from "lucide-react";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { OemEntry } from "@/lib/cross/types";

interface OemListEditorProps {
  sku: string;
  oems: OemEntry[];
  onChange: () => void;
}

const OEM_REGEX = /^[A-Z0-9.\-]{4,30}$/i;

export function OemListEditor({ sku, oems, onChange }: OemListEditorProps) {
  const [adicionando, setAdicionando] = useState(false);
  const [novoCodigo, setNovoCodigo] = useState("");
  const [salvando, setSalvando] = useState(false);

  async function adicionar() {
    const codigo = novoCodigo.trim().toUpperCase();
    if (!OEM_REGEX.test(codigo)) {
      toast.error("OEM inválido (4-30 chars: letras, dígitos, ponto, traço)");
      return;
    }
    setSalvando(true);
    try {
      const res = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/oems`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codigo }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Erro ao adicionar OEM");
        return;
      }
      if (data.cruzamentos?.length > 0) {
        const skus = data.cruzamentos.map((c: { sku: string }) => c.sku).join(", ");
        toast.success(`OEM adicionado. Equivalência criada com: ${skus}`, {
          duration: 6000,
        });
      } else {
        toast.success("OEM adicionado");
      }
      setNovoCodigo("");
      setAdicionando(false);
      onChange();
    } catch {
      toast.error("Erro ao adicionar");
    } finally {
      setSalvando(false);
    }
  }

  async function remover(codigo: string) {
    if (!confirm(`Remover o OEM "${codigo}"?`)) return;
    try {
      const res = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/oems/${encodeURIComponent(codigo)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Erro ao remover");
        return;
      }
      toast.success("OEM removido");
      onChange();
    } catch {
      toast.error("Erro ao remover");
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Códigos OEM</h3>
        {!adicionando && (
          <button
            onClick={() => setAdicionando(true)}
            className="flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-700"
          >
            <Plus className="h-3.5 w-3.5" /> Adicionar
          </button>
        )}
      </div>

      {adicionando && (
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={novoCodigo}
            onChange={(e) => setNovoCodigo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") adicionar();
              if (e.key === "Escape") {
                setAdicionando(false);
                setNovoCodigo("");
              }
            }}
            autoFocus
            placeholder="Código OEM"
            className="flex-1 rounded border border-zinc-200 dark:border-zinc-800 px-2 py-1 text-sm font-mono"
          />
          <button
            onClick={adicionar}
            disabled={salvando}
            className="px-3 py-1 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1"
          >
            {salvando && <Loader2 className="h-3 w-3 animate-spin" />}
            Salvar
          </button>
          <button
            onClick={() => {
              setAdicionando(false);
              setNovoCodigo("");
            }}
            className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-700"
          >
            Cancelar
          </button>
        </div>
      )}

      {oems.length === 0 ? (
        <p className="text-sm text-zinc-500">Nenhum OEM cadastrado.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {oems.map((o) => (
            <span
              key={o.id}
              className={cn(
                "group inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono",
                o.origem === "manual"
                  ? "bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400"
                  : "bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300",
              )}
              title={
                o.origem === "manual"
                  ? `Manual por ${o.adicionado_por_nome ?? "?"}`
                  : "Extraído do Tiny"
              }
            >
              {o.codigo}
              {o.pode_remover && (
                <button
                  onClick={() => remover(o.codigo)}
                  className="opacity-0 group-hover:opacity-100 hover:text-red-600"
                  title="Remover"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
