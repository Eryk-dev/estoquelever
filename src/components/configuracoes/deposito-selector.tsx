"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Loader2,
  Package,
  RefreshCw,
} from "lucide-react";
import type { TinyConnection, DepositoOption } from "./types";

export function DepositoSelector({
  connection,
  onSaved,
}: {
  connection: TinyConnection;
  onSaved: () => void;
}) {
  const [depositos, setDepositos] = useState<DepositoOption[]>([]);
  const [loadingDepositos, setLoadingDepositos] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(
    connection.deposito_id,
  );
  const [saving, setSaving] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  async function handleLoadDepositos() {
    setLoadingDepositos(true);
    setFetchError(null);
    try {
      const res = await fetch(
        `/api/tiny/deposits?connectionId=${connection.id}`,
      );
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const data: DepositoOption[] = await res.json();
      setDepositos(data);
      setHasFetched(true);
      if (data.length === 0) {
        toast.error("Nenhum depósito encontrado nesta conta Tiny");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao carregar depósitos";
      setFetchError(msg);
      toast.error(msg);
    } finally {
      setLoadingDepositos(false);
    }
  }

  async function handleSaveDeposito() {
    if (selectedId === null) {
      toast.error("Selecione um depósito");
      return;
    }
    const chosen = depositos.find((d) => d.id === selectedId);
    if (!chosen) return;

    setSaving(true);
    try {
      const res = await fetch("/api/tiny/connections", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: connection.id,
          deposito_id: chosen.id,
          deposito_nome: chosen.nome,
        }),
      });
      if (!res.ok) throw new Error("Falha ao salvar");
      toast.success(`Depósito "${chosen.nome}" salvo`);
      onSaved();
    } catch {
      toast.error("Erro ao salvar depósito");
    } finally {
      setSaving(false);
    }
  }

  const currentNome =
    connection.deposito_nome ??
    (selectedId !== null
      ? depositos.find((d) => d.id === selectedId)?.nome
      : null);

  return (
    <div className="border-t border-line px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <Package className="h-3.5 w-3.5 text-ink-faint" />
        <span className="text-xs font-medium text-ink-muted">
          Depósito de estoque
        </span>
        {!connection.deposito_id && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
            <AlertTriangle className="h-2.5 w-2.5" />
            Não configurado
          </span>
        )}
        {connection.deposito_id && currentNome && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
            <Check className="h-2.5 w-2.5" />
            {currentNome}
          </span>
        )}
      </div>

      {!hasFetched ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleLoadDepositos}
            disabled={loadingDepositos}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loadingDepositos ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Carregar depósitos
          </button>
          {fetchError && (
            <span className="text-[11px] text-red-500">{fetchError}</span>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {depositos.length > 0 ? (
            <>
              <div className="relative flex-1">
                <select
                  value={selectedId ?? ""}
                  onChange={(e) =>
                    setSelectedId(e.target.value ? Number(e.target.value) : null)
                  }
                  className="w-full appearance-none rounded-lg border border-line bg-surface py-1.5 pl-3 pr-8 text-xs text-ink outline-none transition-colors focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400"
                >
                  <option value="">Selecionar depósito...</option>
                  {depositos.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.nome}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
              </div>
              <button
                type="button"
                onClick={handleSaveDeposito}
                disabled={saving || selectedId === null}
                className="btn-primary px-3 py-1.5 text-xs"
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                Salvar
              </button>
              <button
                type="button"
                onClick={handleLoadDepositos}
                disabled={loadingDepositos}
                className="inline-flex items-center justify-center rounded-lg border border-line p-1.5 text-ink-faint transition-colors hover:bg-surface hover:text-ink-muted disabled:opacity-40"
                title="Recarregar lista"
              >
                {loadingDepositos ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
              </button>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs italic text-ink-faint">
                Nenhum depósito disponível
              </span>
              <button
                type="button"
                onClick={handleLoadDepositos}
                disabled={loadingDepositos}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:bg-surface disabled:opacity-40"
              >
                {loadingDepositos ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Tentar novamente
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
