"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { Search, RefreshCw } from "lucide-react";
import type { Produto } from "@/lib/wms/types";

export default function ProdutosPage() {
  const [q, setQ] = useState("");
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["wms-produtos", q],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/produtos?q=${encodeURIComponent(q)}`);
      return r.json() as Promise<{ rows: Produto[]; total: number }>;
    },
  });

  const sync = useMutation({
    mutationFn: async (id: string) =>
      sisoFetch(`/api/wms/produtos/${id}/sync`, { method: "POST" }),
    onSuccess: () => {
      toast.success("sincronizado");
      queryClient.invalidateQueries({ queryKey: ["wms-produtos"] });
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 items-center">
        <Search className="w-4 h-4 text-zinc-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="SKU, descrição ou GTIN"
          className="flex-1 px-3 py-2 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
        />
      </div>
      {isLoading && <div className="text-zinc-500">carregando...</div>}
      <div className="space-y-1">
        {data?.rows.map((p) => (
          <div
            key={p.id}
            className="flex items-center justify-between p-3 rounded border border-zinc-200 dark:border-zinc-800"
          >
            <div className="flex-1 min-w-0">
              <div className="font-mono text-sm">{p.sku}</div>
              <div className="text-sm text-zinc-600 truncate">{p.descricao}</div>
              <div className="text-xs text-zinc-500">
                {p.gtin && <>GTIN: {p.gtin} · </>}
                {p.ncm && <>NCM: {p.ncm} · </>}
                {p.sincronizado_em
                  ? `sync: ${new Date(p.sincronizado_em).toLocaleString("pt-BR")}`
                  : "nunca sincronizado"}
              </div>
            </div>
            <button
              onClick={() => sync.mutate(p.id)}
              disabled={sync.isPending}
              className="p-2 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
              title="Sincronizar com Tiny"
            >
              <RefreshCw className={`w-4 h-4 ${sync.isPending ? "animate-spin" : ""}`} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
