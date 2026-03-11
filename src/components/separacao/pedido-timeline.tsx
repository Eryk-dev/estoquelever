"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Inbox,
  CheckCircle2,
  FileCheck,
  PackageSearch,
  PackageCheck,
  Printer,
  AlertCircle,
  UserCheck,
  XCircle,
} from "lucide-react";

interface HistoricoEvento {
  id: string;
  evento: string;
  usuario_id: string | null;
  usuario_nome: string | null;
  detalhes: Record<string, unknown>;
  criado_em: string;
}

interface PedidoTimelineProps {
  pedidoId: string;
  open: boolean;
}

const EVENTO_CONFIG: Record<
  string,
  { label: string; icon: typeof Inbox; color: string }
> = {
  recebido: {
    label: "Pedido recebido",
    icon: Inbox,
    color: "text-blue-500",
  },
  auto_aprovado: {
    label: "Auto-aprovado",
    icon: CheckCircle2,
    color: "text-emerald-500",
  },
  aprovado: {
    label: "Aprovado",
    icon: UserCheck,
    color: "text-emerald-500",
  },
  aguardando_nf: {
    label: "Aguardando NF",
    icon: FileCheck,
    color: "text-amber-500",
  },
  nf_autorizada: {
    label: "NF autorizada",
    icon: FileCheck,
    color: "text-emerald-500",
  },
  aguardando_separacao: {
    label: "Aguardando separação",
    icon: PackageSearch,
    color: "text-amber-500",
  },
  separacao_iniciada: {
    label: "Separação iniciada",
    icon: PackageSearch,
    color: "text-blue-500",
  },
  separacao_concluida: {
    label: "Separação concluída",
    icon: PackageCheck,
    color: "text-emerald-500",
  },
  embalagem_concluida: {
    label: "Embalagem concluída",
    icon: PackageCheck,
    color: "text-emerald-500",
  },
  etiqueta_impressa: {
    label: "Etiqueta impressa",
    icon: Printer,
    color: "text-emerald-500",
  },
  etiqueta_falhou: {
    label: "Etiqueta falhou",
    icon: AlertCircle,
    color: "text-red-500",
  },
  cancelado: {
    label: "Cancelado",
    icon: XCircle,
    color: "text-red-500",
  },
  erro: {
    label: "Erro",
    icon: AlertCircle,
    color: "text-red-500",
  },
};

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

function timeBetween(a: string, b: string): string {
  const diff = new Date(b).getTime() - new Date(a).getTime();
  if (diff < 0) return "";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`;
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}min`;
  const h = Math.floor(diff / 3600_000);
  const m = Math.round((diff % 3600_000) / 60_000);
  return `${h}h${m > 0 ? `${m}min` : ""}`;
}

export function PedidoTimeline({ pedidoId, open }: PedidoTimelineProps) {
  const [eventos, setEventos] = useState<HistoricoEvento[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    setLoading(true);
    setError(null);

    fetch(`/api/pedidos/${pedidoId}/historico`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setEventos(data.historico ?? []);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [pedidoId, open]);

  if (!open) return null;

  if (loading) {
    return (
      <div className="px-4 py-3 text-xs text-ink-faint">
        Carregando histórico...
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-3 text-xs text-red-500">
        Erro: {error}
      </div>
    );
  }

  if (eventos.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-ink-faint">
        Nenhum histórico registrado.
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Histórico
      </h4>
      <ol className="relative border-l border-zinc-200 dark:border-zinc-700">
        {eventos.map((evt, i) => {
          const config = EVENTO_CONFIG[evt.evento] ?? {
            label: evt.evento,
            icon: Inbox,
            color: "text-zinc-500",
          };
          const Icon = config.icon;
          const elapsed =
            i > 0 ? timeBetween(eventos[i - 1].criado_em, evt.criado_em) : null;

          return (
            <li key={evt.id} className="mb-3 ml-4 last:mb-0">
              {/* Dot */}
              <div
                className={cn(
                  "absolute -left-[7px] mt-1 h-3 w-3 rounded-full border-2 border-paper",
                  config.color.replace("text-", "bg-"),
                )}
              />

              <div className="flex items-start gap-2">
                <Icon
                  className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", config.color)}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-medium text-ink">
                      {config.label}
                    </span>
                    {elapsed && (
                      <span className="text-[10px] text-ink-faint">
                        +{elapsed}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
                    <span className="font-mono">
                      {formatTimestamp(evt.criado_em)}
                    </span>
                    {evt.usuario_nome && (
                      <>
                        <span className="h-2.5 w-px bg-line" aria-hidden="true" />
                        <span>{evt.usuario_nome}</span>
                      </>
                    )}
                  </div>

                  {/* Details */}
                  {evt.detalhes && Object.keys(evt.detalhes).length > 0 && (
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {Object.entries(evt.detalhes).map(([k, v]) => (
                        <span
                          key={k}
                          className="rounded bg-zinc-50 px-1 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-500"
                        >
                          {k}: {String(v)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
