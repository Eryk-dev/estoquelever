"use client";

import { useEffect, useRef, useState } from "react";
import { useAutoFocus } from "@/components/wms/ui/wms-ui";

// ──────────────────────────────────────────────────────────────────
// HandheldScan — input de bipagem grande e visualmente proeminente
// pra uso no topo do checklist de separação. Cabeçalho/feedback
// dinâmicos com tom (ok|warn|error|neutral). Auto-foco + refoco
// quando termina de processar.

export interface HandheldScanProps {
  /** Label acima do input — ex: "Bipe SKU ou GTIN", "Bipe localização" */
  label: string;
  /** Placeholder dentro do input */
  placeholder?: string;
  /** Disparado em Enter. Recebe o valor capturado (já trim()). */
  onSubmit: (codigo: string) => void;
  /** Notifica o pai a cada mudança do valor (pra um botão externo poder submeter o que foi digitado). */
  onValueChange?: (value: string) => void;
  /** Feedback dinâmico abaixo do input — string ou objeto com tone */
  feedback?: { text: string; tone: "ok" | "warn" | "error" | "neutral" } | null;
  /** Desabilita input enquanto processa */
  pending?: boolean;
  /** Auto-foca quando montar (default true) */
  autoFocus?: boolean;
}

const TONE_CLS: Record<NonNullable<HandheldScanProps["feedback"]>["tone"], string> =
  {
    ok: "is-ok",
    warn: "is-warn",
    error: "is-error",
    neutral: "",
  };

export function HandheldScan({
  label,
  placeholder,
  onSubmit,
  onValueChange,
  feedback,
  pending = false,
  autoFocus = true,
}: HandheldScanProps) {
  const [value, setValue] = useState("");
  const autoRef = useAutoFocus<HTMLInputElement>(autoFocus);
  const fallbackRef = useRef<HTMLInputElement | null>(null);
  const inputRef = autoFocus ? autoRef : fallbackRef;
  const prevPending = useRef(pending);

  function updateValue(next: string) {
    setValue(next);
    onValueChange?.(next);
  }

  // Refoca o input quando `pending` muda de true → false (operador
  // continua bipando sem precisar clicar).
  useEffect(() => {
    if (prevPending.current && !pending) {
      const id = setTimeout(() => inputRef.current?.focus(), 30);
      prevPending.current = pending;
      return () => clearTimeout(id);
    }
    prevPending.current = pending;
  }, [pending, inputRef]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      // Suprime form submit nativo caso esteja dentro de <form>.
      e.preventDefault();
      const trimmed = value.trim();
      if (!trimmed || pending) return;
      onSubmit(trimmed);
      updateValue("");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      updateValue("");
    }
  }

  const toneCls = feedback ? TONE_CLS[feedback.tone] ?? "" : "";
  const feedbackText =
    feedback?.text ?? (pending ? "Processando…" : "Pronto");

  return (
    <div className="wms-hand-scan">
      <div className="wms-hand-scan-lbl">{label}</div>
      <input
        ref={inputRef}
        className="wms-hand-scan-input"
        type="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={value}
        onChange={(e) => updateValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={pending}
        placeholder={placeholder ?? "Bipe ou digite e Enter..."}
      />
      <div
        className={
          toneCls
            ? `wms-hand-scan-feedback ${toneCls}`
            : "wms-hand-scan-feedback"
        }
      >
        {feedbackText}
      </div>
    </div>
  );
}
