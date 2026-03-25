"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, X } from "lucide-react";
import { sisoFetch } from "@/lib/auth-context";

interface ProgressoPedido {
  pedido_id: string;
  numero: string;
  status: "processando" | "pronto" | "erro";
  etapa: string;
}

interface ProgressoResponse {
  concluido: boolean;
  pedidos: ProgressoPedido[];
  prontos: string[];
  erros: string[];
}

export function ProgressModal({
  pedidoIds,
  onClose,
}: {
  pedidoIds: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<ProgressoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await sisoFetch(
        `/api/compras/progresso?pedidos=${pedidoIds.join(",")}`,
      );
      if (!res.ok) throw new Error("Erro ao buscar progresso");
      const json: ProgressoResponse = await res.json();
      setData(json);
      if (json.concluido && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao buscar progresso");
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
  }, [pedidoIds]);

  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, 3000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [poll]);

  const total = pedidoIds.length;
  const prontos = data?.prontos.length ?? 0;
  const erros = data?.erros.length ?? 0;
  const progressPct = total > 0 ? Math.round(((prontos + erros) / total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-line bg-paper shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold text-ink">Processando pedidos</h2>
          {data?.concluido && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-ink-muted hover:bg-surface"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="p-5">
          {error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : (
            <>
              <div className="mb-4">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs text-ink-muted">
                    {prontos} de {total} prontos
                  </span>
                  <span className="text-xs font-medium text-ink">{progressPct}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>

              <div className="max-h-48 divide-y divide-line/60 overflow-y-auto rounded-lg border border-line">
                {data?.pedidos.map((p) => (
                  <div key={p.pedido_id} className="flex items-center gap-3 px-3 py-2">
                    <span className="shrink-0">
                      {p.status === "processando" && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-muted" />
                      )}
                      {p.status === "pronto" && (
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                      )}
                      {p.status === "erro" && (
                        <X className="h-3.5 w-3.5 text-red-500" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 text-xs text-ink">
                      #{p.numero}
                    </span>
                    <span className="truncate text-[11px] text-ink-faint">
                      {p.etapa}
                    </span>
                  </div>
                )) ?? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-ink-faint" />
                  </div>
                )}
              </div>

              {data?.concluido && (
                <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <p className="mb-3 text-sm font-medium text-emerald-800">
                    {prontos} pedido{prontos !== 1 ? "s" : ""} pronto{prontos !== 1 ? "s" : ""} para embalagem
                    {erros > 0 && (
                      <span className="ml-1 text-red-600">
                        ({erros} com erro)
                      </span>
                    )}
                  </p>
                  <div className="flex gap-2">
                    {prontos > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          router.push(
                            `/separacao/embalagem?pedidos=${data.prontos.join(",")}`,
                          );
                        }}
                        className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
                      >
                        Embalar agora
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={onClose}
                      className="flex-1 rounded-lg border border-line bg-paper px-3 py-2 text-xs font-medium text-ink hover:bg-surface"
                    >
                      Fechar
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
