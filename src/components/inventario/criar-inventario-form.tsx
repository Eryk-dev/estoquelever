"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { sisoFetch } from "@/lib/auth-context";
import { useAuth } from "@/lib/auth-context";
import type { InventarioModo, TipoEstoque } from "@/types";

interface CriarInventarioFormProps {
  onCreated: (inventarioId: string) => void;
}

interface Empresa {
  id: string;
  nome: string;
  cnpj: string;
  galpao_id: string;
  ativo: boolean;
}

export function CriarInventarioForm({ onCreated }: CriarInventarioFormProps) {
  const { activeGalpaoId } = useAuth();

  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [loading, setLoading] = useState(true);
  const [empresaId, setEmpresaId] = useState<string>("");
  const [modo, setModo] = useState<InventarioModo>("loc_estoque");
  const [tipoEstoque, setTipoEstoque] = useState<TipoEstoque>("B");
  const [manterLocalizacaoAntiga, setManterLocalizacaoAntiga] = useState(false);
  const [observacoes, setObservacoes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function fetchEmpresas() {
      try {
        const res = await sisoFetch("/api/admin/empresas");
        if (!res.ok) throw new Error("Falha ao buscar empresas");
        const data: Empresa[] = await res.json();
        const filtered = data.filter(
          (e) => e.ativo && (!activeGalpaoId || e.galpao_id === activeGalpaoId),
        );
        setEmpresas(filtered);
        if (filtered.length === 1) {
          setEmpresaId(filtered[0].id);
        }
      } catch {
        toast.error("Erro ao carregar empresas");
      } finally {
        setLoading(false);
      }
    }
    fetchEmpresas();
  }, [activeGalpaoId]);

  async function handleSubmit() {
    if (!empresaId) {
      toast.error("Selecione uma empresa");
      return;
    }
    setSubmitting(true);
    try {
      const res = await sisoFetch("/api/inventario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_id: empresaId,
          modo,
          tipo_estoque: modo === "loc_estoque" ? tipoEstoque : undefined,
          manter_localizacao_antiga: manterLocalizacaoAntiga,
          observacoes: observacoes.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Erro ${res.status}`);
      }

      const inventario = await res.json();
      toast.success("Inventário iniciado");
      onCreated(inventario.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar inventário");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-ink-faint" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Empresa selector */}
      {empresas.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-muted">Empresa</label>
          <select
            value={empresaId}
            onChange={(e) => setEmpresaId(e.target.value)}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none"
          >
            <option value="">Selecione...</option>
            {empresas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nome}
              </option>
            ))}
          </select>
        </div>
      )}

      {empresas.length === 1 && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-muted">Empresa</label>
          <div className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink">
            {empresas[0].nome}
          </div>
        </div>
      )}

      {empresas.length === 0 && (
        <p className="text-sm text-red-500">
          Nenhuma empresa ativa encontrada para o seu galpão.
        </p>
      )}

      {/* Modo toggle */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-ink-muted">Modo</label>
        <div className="flex gap-1">
          <PillButton
            active={modo === "loc_estoque"}
            onClick={() => setModo("loc_estoque")}
          >
            Localização + Estoque
          </PillButton>
          <PillButton
            active={modo === "loc_only"}
            onClick={() => setModo("loc_only")}
          >
            Apenas Localização
          </PillButton>
        </div>
      </div>

      {/* Tipo estoque toggle — only visible when modo=loc_estoque */}
      {modo === "loc_estoque" && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-muted">
            Tipo de Estoque
          </label>
          <div className="flex gap-1">
            <PillButton
              active={tipoEstoque === "B"}
              onClick={() => setTipoEstoque("B")}
            >
              Balanço
            </PillButton>
            <PillButton
              active={tipoEstoque === "E"}
              onClick={() => setTipoEstoque("E")}
            >
              Entrada
            </PillButton>
            <PillButton
              active={tipoEstoque === "S"}
              onClick={() => setTipoEstoque("S")}
            >
              Saída
            </PillButton>
          </div>
        </div>
      )}

      {/* Merge toggle */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-ink-muted">
          Localização antiga
        </label>
        <div className="flex gap-1">
          <PillButton
            active={!manterLocalizacaoAntiga}
            onClick={() => setManterLocalizacaoAntiga(false)}
          >
            Substituir
          </PillButton>
          <PillButton
            active={manterLocalizacaoAntiga}
            onClick={() => setManterLocalizacaoAntiga(true)}
          >
            Manter antiga
          </PillButton>
        </div>
      </div>

      {/* Observações */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-ink-muted">
          Observações <span className="text-ink-faint">(opcional)</span>
        </label>
        <textarea
          value={observacoes}
          onChange={(e) => setObservacoes(e.target.value)}
          placeholder="Observações sobre este inventário..."
          rows={2}
          className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none resize-none placeholder:text-zinc-400"
        />
      </div>

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={submitting || !empresaId}
        className="flex items-center justify-center gap-2 rounded-xl bg-ink py-3 text-sm font-medium text-paper transition-opacity disabled:opacity-50"
      >
        {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
        Iniciar Inventário
      </button>
    </div>
  );
}

function PillButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150 select-none",
        active
          ? "bg-ink text-paper shadow-sm"
          : "bg-zinc-100 text-ink-muted hover:text-ink hover:bg-surface",
      )}
    >
      {children}
    </button>
  );
}
