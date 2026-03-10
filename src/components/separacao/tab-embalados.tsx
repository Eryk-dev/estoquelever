"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Printer, RotateCcw, ChevronDown, Clock, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/domain-helpers";
import type { Decisao } from "@/types";

// ─── Types ──────────────────────────────────────────────────────────────────

type EtiquetaStatus = "pendente" | "imprimindo" | "impresso" | "falhou";

export interface PedidoEmbalado {
  id: string;
  numero: string;
  cliente_nome: string;
  nome_ecommerce: string;
  decisao?: Decisao | null;
  separado_por?: string | null;
  embalado_em?: string | null;
  etiqueta_status?: string | null;
  itens: Array<{
    produto_id: number;
    descricao: string;
    quantidade_pedida: number;
  }>;
}

interface TabEmbaladosProps {
  pedidos: PedidoEmbalado[];
  onRefetch: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getSessionId(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("siso_session_id") ?? "";
}

async function sisoFetch(url: string, options?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      ...options?.headers,
      "X-Session-Id": getSessionId(),
      "Content-Type": "application/json",
    },
  });
}

const ETIQUETA_BADGE: Record<
  EtiquetaStatus,
  { label: string; className: string }
> = {
  pendente: {
    label: "Pendente",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  },
  imprimindo: {
    label: "Imprimindo",
    className:
      "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  },
  impresso: {
    label: "Impresso",
    className:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
  },
  falhou: {
    label: "Falhou",
    className: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  },
};

function EtiquetaStatusBadge({ status }: { status: string | null | undefined }) {
  const normalized = (status ?? "pendente") as EtiquetaStatus;
  const badge = ETIQUETA_BADGE[normalized] ?? ETIQUETA_BADGE.pendente;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold",
        badge.className,
      )}
    >
      {badge.label}
    </span>
  );
}

// ─── Pedido Row ─────────────────────────────────────────────────────────────

function PedidoEmbaladobRow({
  pedido,
  onRefetch,
}: {
  pedido: PedidoEmbalado;
  onRefetch: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [reprinting, setReprinting] = useState(false);

  const etiquetaStatus = (pedido.etiqueta_status ?? "pendente") as EtiquetaStatus;
  const isFailed = etiquetaStatus === "falhou";
  const canReprint = etiquetaStatus === "impresso" || isFailed;

  async function handleReprint() {
    setReprinting(true);
    try {
      const res = await sisoFetch("/api/separacao/reimprimir", {
        method: "POST",
        body: JSON.stringify({ pedido_id: pedido.id }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.status === "impresso") {
        toast.success("Etiqueta reimpressa");
        onRefetch();
      } else {
        toast.error(data.error ?? "Falha ao reimprimir etiqueta");
        onRefetch();
      }
    } catch {
      toast.error("Falha ao reimprimir etiqueta");
    } finally {
      setReprinting(false);
    }
  }

  const totalItens = pedido.itens.reduce((sum, i) => sum + i.quantidade_pedida, 0);
  const embaladoTime = formatTime(pedido.embalado_em ?? undefined);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-line bg-paper transition-all",
        expanded && "rounded-xl shadow-sm",
      )}
    >
      {/* Summary row */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="shrink-0 font-mono text-sm font-bold text-ink">
            #{pedido.numero}
          </span>
          <span
            className="min-w-0 max-w-[160px] truncate text-sm text-ink-muted"
            title={pedido.cliente_nome}
          >
            {pedido.cliente_nome}
          </span>
          <span className="shrink-0 text-[11px] text-ink-faint">
            {totalItens} {totalItens === 1 ? "item" : "itens"}
          </span>

          <EtiquetaStatusBadge status={pedido.etiqueta_status} />

          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {pedido.separado_por && (
              <span className="flex items-center gap-0.5 text-[11px] text-ink-faint">
                <User className="h-3 w-3" />
                {pedido.separado_por}
              </span>
            )}
            {embaladoTime && (
              <span className="flex items-center gap-0.5 font-mono text-xs text-ink-faint">
                <Clock className="h-3 w-3" />
                {embaladoTime}
              </span>
            )}
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 text-ink-faint transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </span>
        </button>

        {/* Reprint / Retry buttons */}
        {isFailed ? (
          <button
            type="button"
            onClick={handleReprint}
            disabled={reprinting}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
              "bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-950/50 dark:text-red-400 dark:hover:bg-red-900/60",
              reprinting && "cursor-not-allowed opacity-50",
            )}
          >
            <RotateCcw className={cn("h-3.5 w-3.5", reprinting && "animate-spin")} />
            {reprinting ? "Tentando..." : "Tentar Novamente"}
          </button>
        ) : canReprint ? (
          <button
            type="button"
            onClick={handleReprint}
            disabled={reprinting}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
              "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700",
              reprinting && "cursor-not-allowed opacity-50",
            )}
          >
            <Printer className={cn("h-3.5 w-3.5", reprinting && "animate-spin")} />
            {reprinting ? "Imprimindo..." : "Reimprimir Etiqueta"}
          </button>
        ) : null}
      </div>

      {/* Expanded items */}
      {expanded && (
        <>
          <div className="mx-3 h-px bg-line" />
          <div className="divide-y divide-line px-4">
            {pedido.itens.map((item) => (
              <div
                key={item.produto_id}
                className="flex items-center gap-2 py-2 text-sm"
              >
                <span className="text-ink-faint">{item.quantidade_pedida}x</span>
                <span className="min-w-0 truncate text-ink">
                  {item.descricao}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TabEmbalados({ pedidos, onRefetch }: TabEmbaladosProps) {
  if (pedidos.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-ink-faint">
        Nenhum pedido embalado no momento.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="mb-1 text-xs text-ink-faint">
        {pedidos.length} pedido{pedidos.length !== 1 ? "s" : ""} embalado
        {pedidos.length !== 1 ? "s" : ""}
      </p>
      {pedidos.map((pedido) => (
        <PedidoEmbaladobRow
          key={pedido.id}
          pedido={pedido}
          onRefetch={onRefetch}
        />
      ))}
    </div>
  );
}
