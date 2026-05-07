"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { SearchInput } from "@/components/cross/search-input";
import { ResultadoCard } from "@/components/cross/resultado-card";
import { sisoFetch } from "@/lib/auth-context";
import { Loader2 } from "lucide-react";
import type { RespostaBusca, TipoBusca } from "@/lib/cross/types";

export default function CrossPage() {
  const [query, setQuery] = useState("");
  const [tipo, setTipo] = useState<TipoBusca>("auto");
  const [resposta, setResposta] = useState<RespostaBusca | null>(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // Debounce 300ms
  useEffect(() => {
    if (query.trim().length < 2) {
      setResposta(null);
      return;
    }
    const handle = setTimeout(() => {
      executarBusca();
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tipo]);

  async function executarBusca() {
    setLoading(true);
    setErro(null);
    try {
      const url = `/api/cross/search?q=${encodeURIComponent(query)}&tipo=${tipo}`;
      const res = await sisoFetch(url);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as RespostaBusca;
      setResposta(data);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao buscar");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="Cross" subtitle="Busca de produtos e equivalências">
      <div className="space-y-4">
        <SearchInput
          value={query}
          tipo={tipo}
          onChange={setQuery}
          onTipoChange={setTipo}
          onSubmit={executarBusca}
        />

        {loading && (
          <div className="flex items-center gap-2 text-zinc-500 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Buscando...
          </div>
        )}

        {erro && (
          <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-400">
            {erro}
          </div>
        )}

        {!loading && !erro && resposta && resposta.total === 0 && (
          <div className="text-center py-12 text-zinc-500">
            Nenhum resultado para &quot;{resposta.query}&quot;
          </div>
        )}

        {!loading && !erro && resposta && resposta.resultados.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs text-zinc-500">
              {resposta.total} resultado{resposta.total !== 1 ? "s" : ""} ·
              detectado como {resposta.tipo_detectado}
            </div>
            {resposta.resultados.map((r) => (
              <ResultadoCard key={r.sku} resultado={r} />
            ))}
          </div>
        )}

        {!query && !loading && (
          <div className="text-center py-12 text-zinc-400 text-sm">
            <p>Digite um SKU, código OEM ou nome de produto.</p>
            <p className="mt-2 text-xs">Atalho: <kbd className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 font-mono text-xs">/</kbd> foca a busca.</p>
          </div>
        )}
      </div>
    </AppShell>
  );
}
