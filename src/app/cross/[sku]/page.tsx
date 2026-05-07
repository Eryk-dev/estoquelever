"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { ProdutoHeader } from "@/components/cross/produto-header";
import { EstoqueGalpaoTabela } from "@/components/cross/estoque-galpao-tabela";
import { EquivalentesList } from "@/components/cross/equivalentes-list";
import { sisoFetch } from "@/lib/auth-context";
import type { DetalheProduto } from "@/lib/cross/types";

export default function CrossDetalhePage() {
  const params = useParams<{ sku: string }>();
  const router = useRouter();
  const sku = decodeURIComponent(params.sku);
  const [detalhe, setDetalhe] = useState<DetalheProduto | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const res = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}`,
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as DetalheProduto;
      setDetalhe(data);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar");
    } finally {
      setLoading(false);
    }
  }, [sku]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Esc volta para a lista
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.push("/cross");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [router]);

  return (
    <AppShell
      title={detalhe?.sku ?? sku}
      subtitle={detalhe?.nome}
      headerRight={
        <Link
          href="/cross"
          className="flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700"
        >
          <ArrowLeft className="h-4 w-4" /> Voltar
        </Link>
      }
    >
      {loading && (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      )}

      {erro && (
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {erro}
        </div>
      )}

      {detalhe && (
        <div className="space-y-3">
          <ProdutoHeader produto={detalhe} onRefreshed={carregar} />
          <EstoqueGalpaoTabela estoques={detalhe.estoque_por_galpao} />

          {/* OEMs read-only no MVP1.1 — substituído por OemListEditor em Task 17 */}
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
            <h3 className="text-sm font-semibold mb-2">Códigos OEM</h3>
            {detalhe.oems.length === 0 ? (
              <p className="text-sm text-zinc-500">Nenhum OEM cadastrado.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {detalhe.oems.map((o) => (
                  <span
                    key={o.id}
                    className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 text-xs font-mono"
                  >
                    {o.codigo}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Veículos read-only no MVP1.1 — substituído por VeiculoListEditor em Task 21 */}
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
            <h3 className="text-sm font-semibold mb-2">Compatibilidade veicular</h3>
            {detalhe.veiculos.length === 0 ? (
              <p className="text-sm text-zinc-500">Nenhum veículo cadastrado.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {detalhe.veiculos.map((v) => (
                  <span
                    key={v.id}
                    className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 text-xs"
                  >
                    {v.marca} {v.modelo}
                    {v.ano_inicio || v.ano_fim
                      ? ` ${v.ano_inicio ?? "?"}-${v.ano_fim ?? "?"}`
                      : ""}
                    {v.variante ? ` ${v.variante}` : ""}
                  </span>
                ))}
              </div>
            )}
          </div>

          <EquivalentesList equivalentes={detalhe.equivalentes} />
        </div>
      )}
    </AppShell>
  );
}
