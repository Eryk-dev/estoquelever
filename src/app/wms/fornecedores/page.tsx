"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import { Plus, Sparkles } from "lucide-react";
import type { Fornecedor } from "@/lib/wms/fornecedores";

export default function FornecedoresPage() {
  const queryClient = useQueryClient();
  const [novo, setNovo] = useState({ nome: "", cnpj: "", prefixo_sku: "" });

  const { data } = useQuery({
    queryKey: ["wms-fornecedores"],
    queryFn: async () =>
      (await sisoFetch("/api/wms/fornecedores")).json() as Promise<{
        rows: Fornecedor[];
      }>,
  });

  const criar = useMutation({
    mutationFn: async () =>
      sisoFetch("/api/wms/fornecedores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: novo.nome,
          cnpj: novo.cnpj || undefined,
          prefixo_sku: novo.prefixo_sku || undefined,
        }),
      }).then(async (r) => {
        if (!r.ok) {
          const e = (await r.json()) as { error?: string };
          throw new Error(e.error ?? "erro");
        }
        return r.json();
      }),
    onSuccess: () => {
      toast.success("criado");
      setNovo({ nome: "", cnpj: "", prefixo_sku: "" });
      queryClient.invalidateQueries({ queryKey: ["wms-fornecedores"] });
    },
    onError: (e) => toast.error(String(e)),
  });

  const autoCadastro = useMutation({
    mutationFn: async () =>
      sisoFetch("/api/wms/fornecedores/auto-cadastro", { method: "POST" }).then(
        async (r) => {
          if (!r.ok) {
            const e = (await r.json()) as { error?: string };
            throw new Error(e.error ?? "erro");
          }
          return r.json() as Promise<{ criados: number; existentes: number }>;
        },
      ),
    onSuccess: (d) => {
      toast.success(`${d.criados} criados, ${d.existentes} já existiam`);
      queryClient.invalidateQueries({ queryKey: ["wms-fornecedores"] });
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-3 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Fornecedores</h1>
        <button
          onClick={() => autoCadastro.mutate()}
          disabled={autoCadastro.isPending}
          className="text-xs px-3 py-1 rounded border border-zinc-300 dark:border-zinc-700 inline-flex items-center gap-1"
          title="Auto-cadastrar do mapeamento de prefixos SKU"
        >
          <Sparkles className="w-3 h-3" /> auto-cadastrar do mapeamento
        </button>
      </div>
      <div className="flex gap-2 p-3 rounded border border-zinc-200 dark:border-zinc-800">
        <input
          placeholder="Nome"
          value={novo.nome}
          onChange={(e) => setNovo({ ...novo, nome: e.target.value })}
          className="flex-1 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
        />
        <input
          placeholder="CNPJ"
          value={novo.cnpj}
          onChange={(e) => setNovo({ ...novo, cnpj: e.target.value })}
          className="w-40 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
        />
        <input
          placeholder="Prefixo SKU"
          value={novo.prefixo_sku}
          onChange={(e) => setNovo({ ...novo, prefixo_sku: e.target.value })}
          className="w-28 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono text-sm"
        />
        <button
          onClick={() => criar.mutate()}
          disabled={!novo.nome || criar.isPending}
          className="px-3 py-1 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          <Plus className="inline w-4 h-4" /> criar
        </button>
      </div>
      <div className="space-y-1">
        {data?.rows.map((f) => (
          <div
            key={f.id}
            className="flex gap-3 p-2 rounded border border-zinc-200 dark:border-zinc-800 items-center"
          >
            <span className="font-medium flex-1">{f.nome}</span>
            <span className="text-sm text-zinc-500">{f.cnpj}</span>
            {f.prefixo_sku && (
              <span className="font-mono text-xs px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">
                {f.prefixo_sku}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
