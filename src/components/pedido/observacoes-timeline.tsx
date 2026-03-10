"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Send, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import type { Observacao } from "@/types";

// ─────────────────────────────────────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchObservacoes(pedidoId: string): Promise<Observacao[]> {
  const res = await fetch(`/api/pedidos/${pedidoId}/observacoes`);
  if (!res.ok) throw new Error("Erro ao carregar observações");
  return res.json();
}

async function postObservacao(
  pedidoId: string,
  payload: { usuarioId: string; usuarioNome: string; texto: string },
): Promise<Observacao> {
  const res = await fetch(`/api/pedidos/${pedidoId}/observacoes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Erro ao salvar observação");
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Time formatter
// ─────────────────────────────────────────────────────────────────────────────

function formatObsTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60_000);

    if (diffMin < 1) return "agora";
    if (diffMin < 60) return `${diffMin}min`;

    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();

    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

    if (isToday) return time;

    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${time}`;
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Initials helper
// ─────────────────────────────────────────────────────────────────────────────

function getInitials(nome: string): string {
  const parts = nome.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return nome.slice(0, 2).toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Single observation entry
// ─────────────────────────────────────────────────────────────────────────────

function ObservacaoEntry({ obs, isLast }: { obs: Observacao; isLast: boolean }) {
  return (
    <div className="relative flex gap-3 pb-4 last:pb-0">
      {/* Thread line */}
      {!isLast && (
        <div
          className="absolute left-[13px] top-7 bottom-0 w-px bg-line"
          aria-hidden="true"
        />
      )}

      {/* Avatar circle */}
      <div
        className={cn(
          "relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          "bg-zinc-100 dark:bg-zinc-800",
          "ring-2 ring-paper",
        )}
      >
        <span className="font-mono text-[10px] font-bold text-ink-muted">
          {getInitials(obs.usuarioNome)}
        </span>
      </div>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
        {/* Author + time */}
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold text-ink">
            {obs.usuarioNome}
          </span>
          <span className="font-mono text-[10px] text-ink-faint">
            {formatObsTime(obs.criadoEm)}
          </span>
        </div>

        {/* Text */}
        <p className="text-sm leading-snug text-ink-muted whitespace-pre-wrap break-words">
          {obs.texto}
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

interface ObservacoesTimelineProps {
  pedidoId: string;
}

export function ObservacoesTimeline({ pedidoId }: ObservacoesTimelineProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [texto, setTexto] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: observacoes = [] } = useQuery({
    queryKey: ["observacoes", pedidoId],
    queryFn: () => fetchObservacoes(pedidoId),
    enabled: expanded,
    refetchInterval: expanded ? 15_000 : false,
  });

  const mutation = useMutation({
    mutationFn: (text: string) =>
      postObservacao(pedidoId, {
        usuarioId: user!.id,
        usuarioNome: user!.nome,
        texto: text,
      }),
    onSuccess: () => {
      setTexto("");
      queryClient.invalidateQueries({ queryKey: ["observacoes", pedidoId] });
      // Also bump the count in the parent query
      queryClient.invalidateQueries({ queryKey: ["observacoes-count", pedidoId] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  // Count query (always active for badge)
  const { data: count = 0 } = useQuery({
    queryKey: ["observacoes-count", pedidoId],
    queryFn: async () => {
      const obs = await fetchObservacoes(pedidoId);
      return obs.length;
    },
  });

  // Auto-scroll to bottom on new entries
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    if (expanded) {
      scrollToBottom();
      // Focus input when expanded
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [expanded, observacoes.length, scrollToBottom]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!texto.trim() || mutation.isPending || !user) return;
    mutation.mutate(texto.trim());
  }

  return (
    <div>
      {/* Toggle bar */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-4 py-2 text-left transition-colors",
          "hover:bg-surface/50",
          expanded && "bg-surface/30",
        )}
      >
        <MessageSquare className="h-3.5 w-3.5 text-ink-faint" aria-hidden="true" />
        <span className="text-xs font-medium text-ink-muted">
          Observações
        </span>
        {count > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-zinc-900 px-1 font-mono text-[10px] font-bold text-white dark:bg-zinc-200 dark:text-zinc-900">
            {count}
          </span>
        )}
        <span className="ml-auto text-[10px] text-ink-faint">
          {expanded ? "fechar" : "abrir"}
        </span>
      </button>

      {/* Expanded panel */}
      {expanded && (
        <div className="animate-fade-in border-t border-line bg-surface/20">
          {/* Timeline entries */}
          {observacoes.length > 0 && (
            <div
              ref={scrollRef}
              className="max-h-48 overflow-y-auto px-4 pt-3 pb-1"
            >
              {observacoes.map((obs, i) => (
                <ObservacaoEntry
                  key={obs.id}
                  obs={obs}
                  isLast={i === observacoes.length - 1}
                />
              ))}
            </div>
          )}

          {observacoes.length === 0 && (
            <div className="px-4 py-3">
              <span className="text-xs text-ink-faint">
                Nenhuma observação ainda.
              </span>
            </div>
          )}

          {/* Input prompt */}
          {user && (
            <form
              onSubmit={handleSubmit}
              className="flex items-center gap-2 border-t border-line px-4 py-2"
            >
              {/* Author initials */}
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-900 dark:bg-zinc-200">
                <span className="font-mono text-[9px] font-bold text-white dark:text-zinc-900">
                  {getInitials(user.nome)}
                </span>
              </div>

              <input
                ref={inputRef}
                type="text"
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                placeholder="Escrever observação..."
                disabled={mutation.isPending}
                className={cn(
                  "min-w-0 flex-1 bg-transparent text-sm text-ink",
                  "placeholder:text-ink-faint/60",
                  "outline-none",
                  "disabled:opacity-50",
                )}
              />

              <button
                type="submit"
                disabled={!texto.trim() || mutation.isPending}
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-all",
                  "text-ink-faint hover:text-ink hover:bg-zinc-100 dark:hover:bg-zinc-800",
                  "disabled:opacity-30 disabled:cursor-not-allowed",
                  texto.trim() && !mutation.isPending && "text-ink bg-zinc-100 dark:bg-zinc-800",
                )}
                aria-label="Enviar observação"
              >
                {mutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
