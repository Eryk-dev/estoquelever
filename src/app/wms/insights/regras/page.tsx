"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ErrorBanner } from "@/components/ui/error-banner";
import type { InsightRegra } from "@/lib/wms/insights/types";

interface RegrasResponse {
  regras: InsightRegra[];
}

const CATEGORIA_LABEL: Record<string, string> = {
  pessoas: "Pessoas",
  fluxo: "Fluxo",
  estoque: "Estoque",
  financeiro: "Financeiro",
  devolucoes: "Devoluções",
};

const SEVERIDADE_COLOR: Record<string, string> = {
  critico: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
  alerta: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  info: "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
};

export default function RegrasAdminPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [testando, setTestando] = useState<string | null>(null);
  const [resultadoTeste, setResultadoTeste] = useState<unknown>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["insights", "regras"],
    queryFn: () => wmsApi<RegrasResponse>("/api/wms/insights/regras"),
    enabled: user?.cargo === "admin",
  });

  const toggleAtiva = useMutation({
    mutationFn: async ({ id, ativa }: { id: string; ativa: boolean }) => {
      await wmsApi(`/api/wms/insights/regras/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ ativa }),
        headers: { "Content-Type": "application/json" },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["insights", "regras"] }),
  });

  const testarRegra = useMutation({
    mutationFn: async (id: string) => {
      setTestando(id);
      setResultadoTeste(null);
      const r = await wmsApi<{ resultados: unknown[] }>(
        `/api/wms/insights/regras/${id}/test`,
        { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } },
      );
      setResultadoTeste(r.resultados);
    },
    onSettled: () => setTestando(null),
  });

  if (user?.cargo !== "admin") {
    return (
      <div className="rounded-xl border border-line bg-paper p-6 text-center">
        <p className="text-sm text-ink-muted">Acesso restrito a administradores.</p>
      </div>
    );
  }
  if (isLoading) return <LoadingSpinner />;
  if (isError) return <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Regras do motor de insights</h1>
        <p className="mt-1 text-sm text-ink-muted">
          15 regras de detecção de anomalia. Ative/desative, ajuste threshold via API.
        </p>
      </div>

      <section className="rounded-xl border border-line bg-paper">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-[11px] uppercase tracking-[0.16em] text-ink-faint">
            <tr>
              <th className="px-3 py-3 text-left">Categoria</th>
              <th className="px-3 py-3 text-left">Código</th>
              <th className="px-3 py-3 text-left">Nome</th>
              <th className="px-3 py-3 text-left">Severidade</th>
              <th className="px-3 py-3 text-left">Threshold</th>
              <th className="px-3 py-3 text-right">Cooldown</th>
              <th className="px-3 py-3 text-left">Última exec.</th>
              <th className="px-3 py-3 text-center">Ativa</th>
              <th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.regras.map((r) => (
              <tr key={r.id} className="hover:bg-surface/60">
                <td className="px-3 py-2 text-ink-muted">{CATEGORIA_LABEL[r.categoria]}</td>
                <td className="px-3 py-2 font-mono text-[11px]">{r.codigo}</td>
                <td className="px-3 py-2">
                  <p className="font-semibold">{r.nome}</p>
                  <p className="text-[11px] text-ink-faint">{r.descricao}</p>
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold ${SEVERIDADE_COLOR[r.severidade]}`}>
                    {r.severidade}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-[10px] text-ink-muted">
                  {JSON.stringify(r.threshold)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-xs">
                  {r.cooldown_min}min
                </td>
                <td className="px-3 py-2 text-xs text-ink-muted">
                  {r.ultima_execucao_em
                    ? `${new Date(r.ultima_execucao_em).toLocaleString("pt-BR")} (${r.ultima_execucao_status})`
                    : "—"}
                </td>
                <td className="px-3 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={r.ativa}
                    onChange={(e) => toggleAtiva.mutate({ id: r.id, ativa: e.target.checked })}
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => testarRegra.mutate(r.id)}
                    disabled={testando === r.id}
                    className="rounded border border-line px-2 py-1 text-xs font-semibold hover:bg-surface disabled:opacity-50"
                  >
                    {testando === r.id ? "..." : "Testar"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {resultadoTeste !== null && (
        <section className="rounded-xl border border-line bg-paper p-4">
          <h2 className="text-sm font-semibold text-ink">Resultado do teste</h2>
          <pre className="mt-2 max-h-96 overflow-auto rounded bg-surface p-3 text-xs">
            {JSON.stringify(resultadoTeste, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}
