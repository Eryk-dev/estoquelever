"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, ScanBarcode } from "lucide-react";
import { sisoFetch } from "@/lib/auth-context";
import {
  playSuccess,
  playError,
  playComplete,
  playAlreadyDone,
} from "./audio-feedback";

interface BipResponse {
  status: "parcial" | "item_completo" | "pedido_completo";
  pedido_id: string;
  pedido_numero: number;
  produto_id?: number;
  sku?: string;
  bipados?: number;
  total?: number;
  itens_faltam?: number;
  etiqueta_status?: "impresso" | "falhou" | "pendente";
  etiqueta_erro?: string | null;
}

interface ScanInputProps {
  onBipProcessed?: () => void;
}

export function ScanInput({ onBipProcessed }: ScanInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = inputRef.current;
    if (!input) return;

    const codigo = input.value.trim();
    if (!codigo) return;

    setProcessing(true);

    try {
      const res = await sisoFetch("/api/separacao/bipar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigo }),
      });

      if (res.status === 404) {
        playError();
        toast.error("Item não encontrado", {
          description: `Código: ${codigo}`,
        });
        return;
      }

      if (res.status === 409) {
        playAlreadyDone();
        const data = await res.json();
        toast.info("Item já bipado", {
          description: data.sku ? `SKU: ${data.sku}` : undefined,
        });
        return;
      }

      if (!res.ok) {
        playError();
        toast.error("Erro ao processar bip");
        return;
      }

      const data: BipResponse = await res.json();

      switch (data.status) {
        case "parcial":
        case "item_completo": {
          playSuccess();
          const progress =
            data.bipados != null && data.total != null
              ? `${data.bipados}/${data.total}`
              : "completo";
          toast.success(`Bip registrado — ${data.sku} (${progress})`, {
            duration: 10000,
            action:
              data.pedido_id && data.produto_id
                ? {
                    label: "Desfazer",
                    onClick: () =>
                      handleUndo(data.pedido_id, data.produto_id!),
                  }
                : undefined,
          });
          break;
        }
        case "pedido_completo": {
          if (data.etiqueta_status === "falhou") {
            playError();
            toast.error(
              `Pedido #${data.pedido_numero} completo — FALHA na etiqueta${data.etiqueta_erro ? `: ${data.etiqueta_erro}` : ""}`,
              { duration: 8000 },
            );
          } else {
            playComplete();
            toast.success(
              `Pedido #${data.pedido_numero} completo — etiqueta impressa!`,
              { duration: 5000 },
            );
          }
          break;
        }
      }

      onBipProcessed?.();
    } catch {
      playError();
      toast.error("Erro de conexão");
    } finally {
      setProcessing(false);
      if (inputRef.current) {
        inputRef.current.value = "";
        inputRef.current.focus();
      }
    }
  }

  async function handleUndo(pedidoId: string, produtoId: number) {
    try {
      const res = await sisoFetch("/api/separacao/desfazer-bip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_id: pedidoId, produto_id: produtoId }),
      });

      if (res.ok) {
        toast.success("Bip desfeito");
        onBipProcessed?.();
      } else {
        toast.error("Erro ao desfazer bip");
      }
    } catch {
      toast.error("Erro de conexão ao desfazer");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="relative">
      <ScanBarcode
        className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-400 dark:text-zinc-500"
        aria-hidden="true"
      />
      <input
        ref={inputRef}
        type="text"
        inputMode="none"
        autoFocus
        disabled={processing}
        placeholder="Escanear código de barras..."
        className="w-full rounded-xl border border-line bg-paper py-3 pl-11 pr-11 font-mono text-sm text-ink placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 dark:placeholder:text-zinc-500"
        aria-label="Campo de leitura de código de barras"
      />
      {processing && (
        <Loader2
          className="absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 animate-spin text-blue-500"
          aria-label="Processando..."
        />
      )}
    </form>
  );
}
