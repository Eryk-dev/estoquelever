"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { ProdutoHeader } from "@/components/cross/produto-header";
import { EstoqueGalpaoTabela } from "@/components/cross/estoque-galpao-tabela";
import { OemListEditor } from "@/components/cross/oem-list-editor";
import { VeiculoListEditor } from "@/components/cross/veiculo-list-editor";
import { LinkListEditor } from "@/components/cross/link-list-editor";
import { sisoFetch } from "@/lib/auth-context";
import type { DetalheProduto, EstoqueGalpao } from "@/lib/cross/types";

export default function CrossDetalhePage() {
  const params = useParams<{ sku: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const sku = decodeURIComponent(params.sku);
  const [detalhe, setDetalhe] = useState<DetalheProduto | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // Estoque carregado em paralelo (chamada Tiny — pode demorar 1-3s)
  const [estoque, setEstoque] = useState<Record<string, EstoqueGalpao> | null>(null);
  const [estoqueLoading, setEstoqueLoading] = useState(true);
  const [estoqueErro, setEstoqueErro] = useState<string | null>(null);

  const carregarDetalhe = useCallback(async () => {
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

  const carregarEstoque = useCallback(async () => {
    setEstoqueLoading(true);
    setEstoqueErro(null);
    try {
      const res = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/estoque`,
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { estoque_por_galpao: Record<string, EstoqueGalpao> };
      setEstoque(data.estoque_por_galpao ?? {});
    } catch (err) {
      setEstoqueErro(err instanceof Error ? err.message : "Erro ao consultar estoque");
    } finally {
      setEstoqueLoading(false);
    }
  }, [sku]);

  // Recarrega tudo (usado pelo botão "Atualizar agora" e por edits)
  const recarregarTudo = useCallback(() => {
    void carregarDetalhe();
    void carregarEstoque();
  }, [carregarDetalhe, carregarEstoque]);

  useEffect(() => {
    if (searchParams.get("force") === "1") {
      // Chama refetch antes do primeiro carregar
      void (async () => {
        try {
          await sisoFetch(
            `/api/cross/produtos/${encodeURIComponent(sku)}/refetch`,
            { method: "POST" },
          );
        } catch {
          // não bloqueia
        }
        recarregarTudo();
      })();
    } else {
      // Carregamento progressivo: detalhe e estoque em paralelo
      recarregarTudo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sku]);

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
          <ProdutoHeader produto={detalhe} onRefreshed={recarregarTudo} />

          {/* Estoque por galpão — carrega em paralelo (chamada Tiny ao vivo) */}
          {!estoqueLoading && !estoqueErro && estoque !== null ? (
            <EstoqueGalpaoTabela estoques={estoque} />
          ) : (
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold">Estoque por galpão</h3>
                {estoqueLoading && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />
                )}
              </div>
              {estoqueErro ? (
                <p className="text-xs text-red-600">{estoqueErro}</p>
              ) : (
                <p className="text-xs text-zinc-500">Consultando Tiny ao vivo...</p>
              )}
            </div>
          )}

          <OemListEditor sku={detalhe.sku} oems={detalhe.oems} onChange={carregarDetalhe} />
          <LinkListEditor sku={detalhe.sku} onChange={carregarDetalhe} />

          <VeiculoListEditor sku={detalhe.sku} veiculos={detalhe.veiculos} onChange={carregarDetalhe} />
        </div>
      )}
    </AppShell>
  );
}
