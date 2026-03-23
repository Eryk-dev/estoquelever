"use client";

import { useState, useEffect } from "react";
import { Loader2, Printer, AlertTriangle } from "lucide-react";
import { sisoFetch } from "@/lib/auth-context";
import type { PreviewResult } from "./etiqueta-endereco-form";

interface EnderecoPreviewProps {
  preview: PreviewResult;
  tipo: "pequena" | "grande";
  onPrint: (printerId: number) => void;
  printing: boolean;
}

interface PrinterOption {
  id: number;
  name: string;
  computer: string;
  state: string;
}

export function EnderecoPreview({
  preview,
  tipo,
  onPrint,
  printing,
}: EnderecoPreviewProps) {
  const [printers, setPrinters] = useState<PrinterOption[]>([]);
  const [loadingPrinters, setLoadingPrinters] = useState(true);
  const [selectedPrinter, setSelectedPrinter] = useState<number | "">("");

  const totalLabels =
    tipo === "pequena"
      ? Math.ceil(preview.total / 2)
      : preview.total;

  useEffect(() => {
    async function fetchPrinters() {
      try {
        const res = await sisoFetch("/api/admin/printnode/printers");
        if (!res.ok) throw new Error("Falha ao buscar impressoras");
        const data: PrinterOption[] = await res.json();
        setPrinters(data);
        if (data.length === 1) {
          setSelectedPrinter(data[0].id);
        }
      } catch {
        // Non-admin users may not have access — degrade gracefully
      } finally {
        setLoadingPrinters(false);
      }
    }
    fetchPrinters();
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* Counts */}
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-ink px-3 py-1 font-mono text-xs font-bold text-paper">
          {preview.total}
        </span>
        <span className="text-sm text-ink-muted">
          endereços &middot; {totalLabels} etiqueta{totalLabels !== 1 ? "s" : ""}
        </span>
      </div>

      {preview.total > 100 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Muitos endereços ({preview.total}). A impressão pode demorar.
          </span>
        </div>
      )}

      {/* Address grid */}
      <div className="flex flex-wrap gap-1.5">
        {preview.enderecos.map((e) => (
          <span
            key={e}
            className="rounded-full bg-zinc-100 px-2 py-1 font-mono text-xs text-ink"
          >
            {e}
          </span>
        ))}
      </div>

      {/* Printer selector */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-ink-muted">Impressora</label>
        {loadingPrinters ? (
          <div className="flex items-center gap-2 py-2 text-xs text-ink-faint">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Carregando impressoras...
          </div>
        ) : printers.length === 0 ? (
          <p className="text-xs text-ink-faint">
            Nenhuma impressora disponível. Configure no PrintNode.
          </p>
        ) : (
          <select
            value={selectedPrinter}
            onChange={(e) =>
              setSelectedPrinter(e.target.value ? Number(e.target.value) : "")
            }
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none"
          >
            <option value="">Selecione...</option>
            {printers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.computer})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Print button */}
      <button
        type="button"
        disabled={printing || !selectedPrinter}
        onClick={() => {
          if (selectedPrinter) onPrint(selectedPrinter);
        }}
        className="flex items-center justify-center gap-2 rounded-xl bg-ink py-3 text-sm font-medium text-paper transition-opacity disabled:opacity-50"
      >
        {printing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Printer className="h-4 w-4" />
        )}
        Imprimir {totalLabels} etiqueta{totalLabels !== 1 ? "s" : ""}
      </button>
    </div>
  );
}
