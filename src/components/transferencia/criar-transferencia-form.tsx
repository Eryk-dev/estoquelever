"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { sisoFetch } from "@/lib/auth-context";
import { useAuth } from "@/lib/auth-context";

interface CriarTransferenciaFormProps {
  onCreated: (transferenciaId: string, empresaOrigemId: string) => void;
}

interface Empresa {
  id: string;
  nome: string;
  cnpj: string;
  galpao_id: string;
  ativo: boolean;
}

export function CriarTransferenciaForm({
  onCreated,
}: CriarTransferenciaFormProps) {
  const { activeGalpaoId } = useAuth();

  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [loading, setLoading] = useState(true);
  const [empresaOrigemId, setEmpresaOrigemId] = useState<string>("");
  const [empresaDestinoId, setEmpresaDestinoId] = useState<string>("");
  const [observacoes, setObservacoes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function fetchEmpresas() {
      try {
        const res = await sisoFetch("/api/admin/empresas");
        if (!res.ok) throw new Error("Falha ao buscar empresas");
        const data: Empresa[] = await res.json();
        const active = data.filter((e) => e.ativo);
        setEmpresas(active);

        // Auto-select origin if user has galpao filter and only 1 empresa matches
        const origemCandidates = active.filter(
          (e) => !activeGalpaoId || e.galpao_id === activeGalpaoId,
        );
        if (origemCandidates.length === 1) {
          setEmpresaOrigemId(origemCandidates[0].id);
        }
      } catch {
        toast.error("Erro ao carregar empresas");
      } finally {
        setLoading(false);
      }
    }
    fetchEmpresas();
  }, [activeGalpaoId]);

  const origemEmpresas = empresas.filter(
    (e) => !activeGalpaoId || e.galpao_id === activeGalpaoId,
  );
  const destinoEmpresas = empresas.filter((e) => e.id !== empresaOrigemId);

  // Auto-select destino when only one option available
  useEffect(() => {
    if (empresaOrigemId && destinoEmpresas.length === 1) {
      setEmpresaDestinoId(destinoEmpresas[0].id);
    } else if (!empresaOrigemId) {
      setEmpresaDestinoId("");
    }
  }, [empresaOrigemId, destinoEmpresas.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit() {
    if (!empresaOrigemId) {
      toast.error("Selecione a empresa de origem");
      return;
    }
    if (!empresaDestinoId) {
      toast.error("Selecione a empresa de destino");
      return;
    }

    setSubmitting(true);
    try {
      const res = await sisoFetch("/api/transferencia", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_origem_id: empresaOrigemId,
          empresa_destino_id: empresaDestinoId,
          observacoes: observacoes.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Erro ${res.status}`);
      }

      const transferencia = await res.json();
      toast.success("Transferência iniciada");
      onCreated(transferencia.id, empresaOrigemId);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Erro ao criar transferência",
      );
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
      {/* Empresa origem */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-ink-muted">
          Empresa Origem
        </label>
        {origemEmpresas.length === 1 ? (
          <div className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink">
            {origemEmpresas[0].nome}
          </div>
        ) : (
          <select
            value={empresaOrigemId}
            onChange={(e) => {
              setEmpresaOrigemId(e.target.value);
              // Clear destino if it matches new origin
              if (e.target.value === empresaDestinoId) {
                setEmpresaDestinoId("");
              }
            }}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none"
          >
            <option value="">Selecione...</option>
            {origemEmpresas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nome}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Empresa destino */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-ink-muted">
          Empresa Destino
        </label>
        {destinoEmpresas.length === 0 ? (
          <p className="text-sm text-red-500">
            Nenhuma empresa de destino disponível.
          </p>
        ) : (
          <select
            value={empresaDestinoId}
            onChange={(e) => setEmpresaDestinoId(e.target.value)}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none"
          >
            <option value="">Selecione...</option>
            {destinoEmpresas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nome}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Observações */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-ink-muted">
          Observações <span className="text-ink-faint">(opcional)</span>
        </label>
        <textarea
          value={observacoes}
          onChange={(e) => setObservacoes(e.target.value)}
          placeholder="Observações sobre esta transferência..."
          rows={2}
          className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none resize-none placeholder:text-zinc-400"
        />
      </div>

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={submitting || !empresaOrigemId || !empresaDestinoId}
        className="flex items-center justify-center gap-2 rounded-xl bg-ink py-3 text-sm font-medium text-paper transition-opacity disabled:opacity-50"
      >
        {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
        Iniciar Transferência
      </button>
    </div>
  );
}
