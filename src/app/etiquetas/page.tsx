"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import {
  EtiquetaEnderecoForm,
  type PreviewResult,
  type RangeParams,
} from "@/components/etiquetas/etiqueta-endereco-form";
import { EnderecoPreview } from "@/components/etiquetas/endereco-preview";
import { sisoFetch } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

type EtiquetaTipo = "pequena" | "grande";

export default function EtiquetasPage() {
  const [activeTab, setActiveTab] = useState<EtiquetaTipo>("pequena");
  const [previewPequena, setPreviewPequena] = useState<PreviewResult | null>(null);
  const [previewGrande, setPreviewGrande] = useState<PreviewResult | null>(null);
  const [printing, setPrinting] = useState(false);

  const rangePequenaRef = useRef<RangeParams | null>(null);
  const rangeGrandeRef = useRef<RangeParams | null>(null);

  const preview = activeTab === "pequena" ? previewPequena : previewGrande;

  function handlePreview(data: PreviewResult, range: RangeParams) {
    if (activeTab === "pequena") {
      setPreviewPequena(data);
      rangePequenaRef.current = range;
    } else {
      setPreviewGrande(data);
      rangeGrandeRef.current = range;
    }
  }

  async function handlePrint(printerId: number) {
    const rangeParams =
      activeTab === "pequena" ? rangePequenaRef.current : rangeGrandeRef.current;

    if (!rangeParams) {
      toast.error("Gere o preview primeiro");
      return;
    }

    setPrinting(true);
    try {
      const res = await sisoFetch("/api/etiquetas-endereco/imprimir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...rangeParams,
          tipo: activeTab,
          printer_id: printerId,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Erro ${res.status}`);
      }

      const result = await res.json();
      toast.success(
        `Enviado para impressão: ${result.total_labels} etiqueta${result.total_labels !== 1 ? "s" : ""}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao imprimir");
    } finally {
      setPrinting(false);
    }
  }

  const tabs: { id: EtiquetaTipo; label: string }[] = [
    { id: "pequena", label: "Pequena (2/label)" },
    { id: "grande", label: "Grande (1/label)" },
  ];

  return (
    <AppShell title="Etiquetas de Endereço">
      {/* Tabs */}
      <div className="mb-5 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
        <div className="flex items-center gap-1 rounded-lg bg-zinc-100 p-1 w-fit min-w-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "rounded-md px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-medium transition-all duration-150 select-none whitespace-nowrap",
                activeTab === tab.id
                  ? "bg-ink text-paper shadow-sm"
                  : "text-ink-muted hover:text-ink hover:bg-surface",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Form */}
      <EtiquetaEnderecoForm onPreview={handlePreview} />

      {/* Preview */}
      {preview && (
        <div className="mt-5">
          <EnderecoPreview
            preview={preview}
            tipo={activeTab}
            onPrint={handlePrint}
            printing={printing}
          />
        </div>
      )}
    </AppShell>
  );
}
