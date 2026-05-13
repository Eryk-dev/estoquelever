"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ErrorBanner } from "@/components/ui/error-banner";
import { fmtNum } from "@/components/wms/ui/wms-ui";
import { InsightsStrip } from "@/components/wms/insights/insights-strip";
import { PeriodFilter } from "@/components/wms/insights/period-filter";
import type {
  InsightAtivo,
  RankingOperador,
} from "@/lib/wms/insights/types";

interface PessoasResponse {
  ranking: RankingOperador[];
  insights: InsightAtivo[];
}

const FUNCAO_LABEL: Record<string, string> = {
  separacao: "Separação",
  embalagem: "Embalagem",
  guarda: "Guarda",
  contagem: "Contagem",
  sem_atividade: "—",
};

export default function PessoasPage() {
  const { activeGalpaoId } = useAuth();
  const params = useSearchParams();
  const dias = Number(params.get("dias") ?? 7);

  const sp = new URLSearchParams();
  if (activeGalpaoId) sp.set("galpao_id", activeGalpaoId);
  sp.set("dias", String(dias));

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["insights", "pessoas", activeGalpaoId, dias],
    queryFn: () => wmsApi<PessoasResponse>(`/api/wms/insights/pessoas?${sp}`),
    refetchInterval: 60_000,
  });

  if (isLoading) return <LoadingSpinner />;
  if (isError)
    return <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">
            Pessoas — performance e retrabalho
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Ranking por função efetiva (detectada por uso). Sample mínimo: 1 ação.
          </p>
        </div>
        <PeriodFilter />
      </div>

      <InsightsStrip
        insights={data.insights}
        emptyMessage="Sem anomalias de performance no período."
      />

      <section className="rounded-xl border border-line bg-paper">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-[11px] uppercase tracking-[0.16em] text-ink-faint">
            <tr>
              <th className="px-3 py-3 text-left">Operador</th>
              <th className="px-3 py-3 text-left">Função</th>
              <th className="px-3 py-3 text-right">Pedidos sep</th>
              <th className="px-3 py-3 text-right">Embalou</th>
              <th className="px-3 py-3 text-right">Guardou</th>
              <th className="px-3 py-3 text-right">Contou</th>
              <th className="px-3 py-3 text-right">Pedidos/h</th>
              <th className="px-3 py-3 text-right">Tempo sep</th>
              <th className="px-3 py-3 text-right">Tempo guarda</th>
              <th className="px-3 py-3 text-right">Tempo cont.</th>
              <th className="px-3 py-3 text-right">Acuracid.</th>
              <th className="px-3 py-3 text-right">Diverg.</th>
              <th className="px-3 py-3 text-right">Ajustes</th>
              <th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.ranking.map((r) => (
              <tr key={r.usuario_id} className="hover:bg-surface/60">
                <td className="px-3 py-3 font-semibold text-ink">{r.usuario_nome}</td>
                <td className="px-3 py-3 text-ink-muted">{FUNCAO_LABEL[r.funcao_efetiva]}</td>
                <td className="px-3 py-3 text-right font-mono tabular-nums">{r.pedidos_separados}</td>
                <td className="px-3 py-3 text-right font-mono tabular-nums">{r.pedidos_embalados}</td>
                <td className="px-3 py-3 text-right font-mono tabular-nums">{r.pendencias_guardadas}</td>
                <td className="px-3 py-3 text-right font-mono tabular-nums">{r.locs_contadas}</td>
                <td className="px-3 py-3 text-right font-mono tabular-nums">
                  {r.pedidos_por_hora ?? "—"}
                </td>
                <td className="px-3 py-3 text-right font-mono tabular-nums">
                  {r.tempo_medio_separacao_min !== null ? `${r.tempo_medio_separacao_min}min` : "—"}
                </td>
                <td className="px-3 py-3 text-right font-mono tabular-nums">
                  {r.tempo_medio_guarda_min !== null ? `${r.tempo_medio_guarda_min}min` : "—"}
                </td>
                <td className="px-3 py-3 text-right font-mono tabular-nums">
                  {r.tempo_medio_contagem_min !== null ? `${r.tempo_medio_contagem_min}min` : "—"}
                </td>
                <td className="px-3 py-3 text-right font-mono tabular-nums">
                  {r.acuracidade_pct !== null ? `${r.acuracidade_pct}%` : "—"}
                </td>
                <td className="px-3 py-3 text-right font-mono tabular-nums">{r.divergencias}</td>
                <td className="px-3 py-3 text-right font-mono tabular-nums">{r.ajustes_manuais}</td>
                <td className="px-3 py-3 text-right">
                  <Link
                    href={`/wms/insights/pessoas/${r.usuario_id}`}
                    className="text-xs font-semibold text-ink hover:underline"
                  >
                    Drill →
                  </Link>
                </td>
              </tr>
            ))}
            {data.ranking.length === 0 && (
              <tr>
                <td colSpan={14} className="px-3 py-8 text-center text-sm text-ink-faint">
                  Sem atividade registrada no período.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <p className="text-xs text-ink-faint">
        <strong>Como ler:</strong> função efetiva é a que o operador mais usa no período (pelo número
        de ações). Pedidos/h divide separações por horas ativas (hora com ≥1 ação). Acurácia ={" "}
        {fmtNum(100)} − (divergências / locs contadas) × 100.
      </p>
    </div>
  );
}
