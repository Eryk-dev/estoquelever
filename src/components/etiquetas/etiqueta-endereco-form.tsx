"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";

export interface PreviewResult {
  enderecos: string[];
  total: number;
  total_labels: number;
}

export interface RangeParams {
  corredor_inicio: string;
  corredor_fim: string;
  horizontal_inicio: number;
  horizontal_fim: number;
  vertical_inicio: number;
  vertical_fim: number;
}

interface EtiquetaEnderecoFormProps {
  onPreview: (data: PreviewResult, range: RangeParams) => void;
}

export function EtiquetaEnderecoForm({ onPreview }: EtiquetaEnderecoFormProps) {
  const [corredorInicio, setCorredorInicio] = useState("");
  const [corredorFim, setCorredorFim] = useState("");
  const [horizontalInicio, setHorizontalInicio] = useState<number>(1);
  const [horizontalFim, setHorizontalFim] = useState<number>(1);
  const [verticalInicio, setVerticalInicio] = useState<number>(1);
  const [verticalFim, setVerticalFim] = useState<number>(1);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!corredorInicio.trim() || !corredorFim.trim()) {
      toast.error("Corredor início e fim são obrigatórios");
      return;
    }

    if (horizontalInicio > horizontalFim) {
      toast.error("Horizontal início deve ser <= fim");
      return;
    }
    if (verticalInicio > verticalFim) {
      toast.error("Vertical início deve ser <= fim");
      return;
    }

    const rangeParams: RangeParams = {
      corredor_inicio: corredorInicio.toUpperCase().trim(),
      corredor_fim: corredorFim.toUpperCase().trim(),
      horizontal_inicio: horizontalInicio,
      horizontal_fim: horizontalFim,
      vertical_inicio: verticalInicio,
      vertical_fim: verticalFim,
    };

    setLoading(true);
    try {
      const res = await sisoFetch("/api/etiquetas-endereco/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rangeParams),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Erro ${res.status}`);
      }

      const data: PreviewResult = await res.json();
      onPreview(data, rangeParams);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao gerar preview");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-ink-muted">Corredor</label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Início"
            value={corredorInicio}
            onChange={(e) => setCorredorInicio(e.target.value.toUpperCase())}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink uppercase outline-none placeholder:text-zinc-400"
          />
          <span className="text-xs text-ink-faint">a</span>
          <input
            type="text"
            placeholder="Fim"
            value={corredorFim}
            onChange={(e) => setCorredorFim(e.target.value.toUpperCase())}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink uppercase outline-none placeholder:text-zinc-400"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-ink-muted">Horizontal</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            value={horizontalInicio}
            onChange={(e) => setHorizontalInicio(Number(e.target.value))}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink outline-none"
          />
          <span className="text-xs text-ink-faint">a</span>
          <input
            type="number"
            min={1}
            value={horizontalFim}
            onChange={(e) => setHorizontalFim(Number(e.target.value))}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink outline-none"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-ink-muted">Vertical</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            value={verticalInicio}
            onChange={(e) => setVerticalInicio(Number(e.target.value))}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink outline-none"
          />
          <span className="text-xs text-ink-faint">a</span>
          <input
            type="number"
            min={1}
            value={verticalFim}
            onChange={(e) => setVerticalFim(Number(e.target.value))}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink outline-none"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={loading || !corredorInicio.trim() || !corredorFim.trim()}
        className="flex items-center justify-center gap-2 rounded-xl bg-ink py-3 text-sm font-medium text-paper transition-opacity disabled:opacity-50"
      >
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        Gerar Preview
      </button>
    </form>
  );
}
