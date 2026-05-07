"use client";

import { Package, RefreshCw } from "lucide-react";
import { useState } from "react";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { DetalheProduto } from "@/lib/cross/types";

interface ProdutoHeaderProps {
  produto: DetalheProduto;
  onRefreshed: () => void;
}

function formatDistanceFromNow(iso: string | null): string {
  if (!iso) return "nunca";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.floor(h / 24);
  return `há ${d}d`;
}

export function ProdutoHeader({ produto, onRefreshed }: ProdutoHeaderProps) {
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(produto.sku)}/refetch`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Erro ao atualizar");
        return;
      }
      toast.success("Atualizado do Tiny");
      onRefreshed();
    } catch {
      toast.error("Erro ao atualizar");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex gap-4">
        <div className="flex-shrink-0 w-24 h-24 rounded bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center overflow-hidden">
          {produto.imagem_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={produto.imagem_url}
              alt={produto.nome}
              className="w-full h-full object-cover"
            />
          ) : (
            <Package className="h-10 w-10 text-zinc-400" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold truncate">{produto.nome}</h2>
          <div className="text-sm font-mono text-zinc-500 mt-1">{produto.sku}</div>
          {produto.gtin && (
            <div className="text-xs text-zinc-400 mt-1">GTIN: {produto.gtin}</div>
          )}
          <div className="flex items-center justify-between mt-3">
            <span className="text-xs text-zinc-500">
              Sincronizado {formatDistanceFromNow(produto.sincronizado_em)}
            </span>
            <button
              onClick={refresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
              Atualizar agora
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
