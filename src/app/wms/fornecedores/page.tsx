"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Sparkles } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";
import type { Fornecedor } from "@/lib/wms/fornecedores";

export default function FornecedoresPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = (user?.cargos ?? [user?.cargo]).includes("admin");
  const [novo, setNovo] = useState({ nome: "", cnpj: "", prefixo_sku: "" });

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["wms-fornecedores"],
    queryFn: () => wmsApi<{ rows: Fornecedor[] }>("/api/wms/fornecedores"),
  });

  const criar = useMutation({
    mutationFn: () =>
      wmsApi<Fornecedor>("/api/wms/fornecedores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: novo.nome,
          cnpj: novo.cnpj || undefined,
          prefixo_sku: novo.prefixo_sku || undefined,
        }),
      }),
    onSuccess: () => {
      toast.success("Fornecedor criado");
      setNovo({ nome: "", cnpj: "", prefixo_sku: "" });
      queryClient.invalidateQueries({ queryKey: ["wms-fornecedores"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const autoCadastro = useMutation({
    mutationFn: () =>
      wmsApi<{ criados: number; existentes: number }>(
        "/api/wms/fornecedores/auto-cadastro",
        { method: "POST" },
      ),
    onSuccess: (d) => {
      toast.success(`${d.criados} criados, ${d.existentes} já existiam`);
      queryClient.invalidateQueries({ queryKey: ["wms-fornecedores"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-3">
      {isAdmin && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => autoCadastro.mutate()}
            disabled={autoCadastro.isPending}
            className="btn-ghost text-xs"
            title="Auto-cadastrar do mapeamento de prefixos SKU"
          >
            <Sparkles className="h-3 w-3" /> auto-cadastrar do mapeamento
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper p-3">
        <input
          placeholder="Nome"
          value={novo.nome}
          onChange={(e) => setNovo({ ...novo, nome: e.target.value })}
          className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
        />
        <input
          placeholder="CNPJ"
          value={novo.cnpj}
          onChange={(e) => setNovo({ ...novo, cnpj: e.target.value })}
          className="w-40 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
        />
        <input
          placeholder="Prefixo SKU"
          value={novo.prefixo_sku}
          onChange={(e) => setNovo({ ...novo, prefixo_sku: e.target.value })}
          className="w-32 rounded-lg border border-line bg-paper px-3 py-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
        />
        <button
          type="button"
          onClick={() => criar.mutate()}
          disabled={!novo.nome || criar.isPending}
          className="btn-primary"
        >
          <Plus className="h-4 w-4" /> criar
        </button>
      </div>

      {isLoading ? (
        <LoadingSpinner />
      ) : isError ? (
        <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message="Nenhum fornecedor cadastrado." />
      ) : (
        <div className="space-y-1">
          {rows.map((f) => (
            <div
              key={f.id}
              className="flex items-center gap-3 rounded-xl border border-line bg-paper p-2.5"
            >
              <span className="flex-1 font-medium text-ink">{f.nome}</span>
              <span className="text-sm text-ink-muted">{f.cnpj}</span>
              {f.prefixo_sku && (
                <span className="badge badge-oc font-mono">{f.prefixo_sku}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
