"use client";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";

interface OperadorRow {
  operador_id: string;
  nome: string;
  contagens: number;
  erro_medio_pct: number | null;
}

interface LocalizacaoRow {
  localizacao_id: string;
  codigo: string;
  total: number;
  sem_div: number;
  erro_medio_pct: number | null;
}

interface Metricas {
  porOperador: OperadorRow[];
  porLocalizacao: LocalizacaoRow[];
}

export default function MetricasPage() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["wms-inv-metricas"],
    queryFn: () => wmsApi<Metricas>("/api/wms/inventario/metricas"),
  });

  if (isLoading) return <LoadingSpinner />;
  if (isError) {
    return (
      <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />
    );
  }

  const operadores = data?.porOperador ?? [];
  const localizacoes = data?.porLocalizacao ?? [];

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint">
          Acuracidade por operador (30d)
        </h2>
        {operadores.length === 0 ? (
          <EmptyState message="Sem contagens nos últimos 30 dias." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-paper">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-ink-faint">
                  <th className="p-2">operador</th>
                  <th className="text-right">contagens</th>
                  <th className="p-2 text-right">erro médio %</th>
                </tr>
              </thead>
              <tbody>
                {operadores.map((r) => (
                  <tr key={r.operador_id} className="border-t border-line">
                    <td className="p-2 text-ink">{r.nome}</td>
                    <td className="text-right tabular-nums text-ink">
                      {r.contagens}
                    </td>
                    <td className="p-2 text-right tabular-nums text-ink-muted">
                      {r.erro_medio_pct?.toFixed(2) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint">
          Acuracidade por localização
        </h2>
        {localizacoes.length === 0 ? (
          <EmptyState message="Sem dados de localização ainda." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-paper">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-ink-faint">
                  <th className="p-2">código</th>
                  <th className="text-right">total</th>
                  <th className="text-right">s/ divergência</th>
                  <th className="p-2 text-right">erro médio %</th>
                </tr>
              </thead>
              <tbody>
                {localizacoes.map((r) => (
                  <tr key={r.localizacao_id} className="border-t border-line">
                    <td className="p-2 font-mono text-ink">{r.codigo}</td>
                    <td className="text-right tabular-nums text-ink">{r.total}</td>
                    <td className="text-right tabular-nums text-ink-muted">
                      {r.sem_div}
                    </td>
                    <td className="p-2 text-right tabular-nums text-ink-muted">
                      {r.erro_medio_pct?.toFixed(2) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
