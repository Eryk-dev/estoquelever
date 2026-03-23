"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  X,
  Clock,
  Loader2,
  RotateCcw,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { sisoFetch } from "@/lib/auth-context";
import { playComplete } from "@/components/separacao/audio-feedback";
import type { InventarioItemStatus } from "@/types";

interface ProgressoItem {
  sku: string;
  nome_produto: string | null;
  quantidade_total: number;
  localizacoes: string;
  status: InventarioItemStatus;
  erro_msg: string | null;
}

interface ProgressoResponse {
  status: string;
  total: number;
  processados: number;
  sucesso: number;
  erro: number;
  itens: ProgressoItem[];
}

interface ProgressoProcessamentoProps {
  sessionId: string;
  tipo: "inventario" | "transferencia";
}

export function ProgressoProcessamento({
  sessionId,
  tipo,
}: ProgressoProcessamentoProps) {
  const [confirmReverter, setConfirmReverter] = useState(false);
  const [revertendo, setRevertendo] = useState(false);
  const [reprocessando, setReprocessando] = useState(false);
  const [playedComplete, setPlayedComplete] = useState(false);

  const { data, isLoading } = useQuery<ProgressoResponse>({
    queryKey: [`${tipo}-progresso`, sessionId],
    queryFn: async () => {
      const res = await sisoFetch(`/api/${tipo}/${sessionId}/progresso`);
      if (!res.ok) throw new Error("Falha ao buscar progresso");
      return res.json();
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "processando" || status === "revertendo") return 2000;
      return false;
    },
  });

  // Play completion sound once
  if (
    data &&
    (data.status === "concluido" || data.status === "revertido") &&
    !playedComplete
  ) {
    playComplete();
    setPlayedComplete(true);
  }

  async function handleReprocessar() {
    setReprocessando(true);
    try {
      const res = await sisoFetch(`/api/${tipo}/${sessionId}/processar`, {
        method: "POST",
      });
      if (res.ok) {
        toast.success("Reprocessamento iniciado");
        setPlayedComplete(false);
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao reprocessar");
      }
    } catch {
      toast.error("Erro de conexão");
    } finally {
      setReprocessando(false);
    }
  }

  async function handleReverter() {
    setRevertendo(true);
    try {
      const res = await sisoFetch(`/api/${tipo}/${sessionId}/reverter`, {
        method: "POST",
      });
      if (res.ok) {
        toast.success("Reversão iniciada");
        setConfirmReverter(false);
        setPlayedComplete(false);
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao reverter");
      }
    } catch {
      toast.error("Erro de conexão");
    } finally {
      setRevertendo(false);
    }
  }

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-ink-faint" />
        <span className="ml-2 text-sm text-ink-faint">Carregando...</span>
      </div>
    );
  }

  const isProcessing =
    data.status === "processando" || data.status === "revertendo";
  const isDone = data.status === "concluido";
  const isErro = data.status === "erro";
  const isRevertido = data.status === "revertido";
  const progressPct =
    data.total > 0 ? (data.processados / data.total) * 100 : 0;

  const tipoLabel = tipo === "inventario" ? "Inventário" : "Transferência";

  return (
    <div className="flex flex-col gap-4">
      {/* Banner for completed states */}
      {isDone && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-800 dark:bg-emerald-950/30">
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
            Concluído — {data.sucesso} ok · {data.erro} erro
            {data.erro !== 1 ? "s" : ""}
          </p>
        </div>
      )}

      {isErro && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-800 dark:bg-red-950/30">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-red-700 dark:text-red-300">
              Erro — todos os itens falharam
            </p>
            <button
              type="button"
              disabled={reprocessando}
              onClick={handleReprocessar}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:bg-red-700 disabled:opacity-50"
            >
              {reprocessando ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Reprocessar
            </button>
          </div>
        </div>
      )}

      {isRevertido && (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-900">
          <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
            {tipoLabel} revertido
          </p>
        </div>
      )}

      {/* Progress bar */}
      {(isProcessing || isDone || isErro) && (
        <div>
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-zinc-600 dark:text-zinc-300">
              {data.processados} de {data.total}
            </span>
            <div className="flex items-center gap-3">
              {data.sucesso > 0 && (
                <span className="text-emerald-600 dark:text-emerald-400">
                  {data.sucesso} sucesso
                </span>
              )}
              {data.erro > 0 && (
                <span className="text-red-500 dark:text-red-400">
                  {data.erro} erro{data.erro !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-300",
                isDone || isRevertido
                  ? "bg-emerald-500"
                  : isErro
                    ? "bg-red-500"
                    : "bg-blue-500",
              )}
              style={{ width: `${Math.min(progressPct, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Processing spinner */}
      {isProcessing && (
        <div className="flex items-center justify-center gap-2 py-2">
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
          <span className="text-sm text-ink-muted">
            {data.status === "revertendo"
              ? "Revertendo..."
              : "Processando..."}
          </span>
        </div>
      )}

      {/* Consolidated item list */}
      {data.itens.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {data.itens.map((item) => (
            <div
              key={item.sku}
              className="flex items-start gap-2 rounded-lg border border-line bg-paper px-3 py-2"
            >
              {/* Status icon */}
              <div className="mt-0.5 shrink-0">
                {item.status === "sucesso" && (
                  <Check className="h-4 w-4 text-emerald-500" />
                )}
                {item.status === "erro" && (
                  <div title={item.erro_msg ?? "Erro"}>
                    <X className="h-4 w-4 text-red-500" />
                  </div>
                )}
                {item.status === "processando" && (
                  <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                )}
                {item.status === "pendente" && (
                  <Clock className="h-4 w-4 text-zinc-400" />
                )}
              </div>

              {/* Item info */}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-sm font-bold text-ink">
                    {item.sku}
                  </span>
                  <span className="truncate text-xs text-ink-muted">
                    {item.nome_produto}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-mono tabular-nums text-ink-muted dark:bg-zinc-800">
                    ×{item.quantidade_total}
                  </span>
                  {item.localizacoes && (
                    <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                      {item.localizacoes}
                    </span>
                  )}
                </div>
                {/* Error message */}
                {item.status === "erro" && item.erro_msg && (
                  <p className="mt-1 flex items-start gap-1 text-[11px] text-red-500 dark:text-red-400">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{item.erro_msg}</span>
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reverter button (only when concluido) */}
      {isDone && (
        <div className="pt-2">
          {confirmReverter ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-ink-muted">Reverter tudo?</span>
              <button
                type="button"
                disabled={revertendo}
                onClick={handleReverter}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:bg-red-700 disabled:opacity-50"
              >
                {revertendo ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
                Confirmar
              </button>
              <button
                type="button"
                onClick={() => setConfirmReverter(false)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmReverter(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reverter {tipoLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
