"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ErrorBanner } from "@/components/ui/error-banner";
import { fmtBRL, fmtNum } from "@/components/wms/ui/wms-ui";
import { InsightsStrip } from "@/components/wms/insights/insights-strip";
import { KpiCard } from "@/components/wms/insights/kpi-card";
import type { HubKpis, InsightAtivo, ThroughputDia } from "@/lib/wms/insights/types";

interface HubResponse {
  kpis: HubKpis;
  insights: InsightAtivo[];
  throughput_30d: ThroughputDia[];
}

const LINKS = [
  { href: "/wms/insights/pessoas", label: "Pessoas", desc: "Performance + retrabalho" },
  { href: "/wms/insights/fluxo", label: "Fluxo", desc: "Gargalo + throughput por etapa" },
  { href: "/wms/insights/estoque", label: "Estoque", desc: "ABC + cobertura + slow-mover" },
  { href: "/wms/insights/financeiro", label: "Financeiro", desc: "Valor, empréstimos, custo médio" },
  { href: "/wms/insights/devolucoes", label: "Devoluções", desc: "A/B/C/D, motivos, fornecedores" },
  { href: "/wms/insights/regras", label: "Configurar regras", desc: "Admin do motor de insights" },
];

export default function InsightsHubPage() {
  const { activeGalpaoId } = useAuth();
  const params = new URLSearchParams();
  if (activeGalpaoId) params.set("galpao_id", activeGalpaoId);
  const url = `/api/wms/insights/hub${params.toString() ? "?" + params : ""}`;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["insights", "hub", activeGalpaoId],
    queryFn: () => wmsApi<HubResponse>(url),
    refetchInterval: 60_000,
  });

  if (isLoading) return <LoadingSpinner />;
  if (isError) return <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Insights da operação</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Detecção de anomalia + KPIs executivos. Filtro por galpão no header global.
        </p>
      </div>

      <InsightsStrip
        insights={data.insights}
        emptyMessage="Sem alertas críticos no momento. Operação dentro do padrão."
      />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="Embalados hoje"
          value={fmtNum(data.kpis.throughput_hoje)}
          sub={`média 7d: ${fmtNum(data.kpis.throughput_7d_avg)}`}
          delta={data.kpis.delta_throughput_pct}
        />
        <KpiCard
          label="Lead time P50 24h"
          value={`${fmtNum(data.kpis.lead_time_p50_24h_min)}min`}
          sub={`7d: ${fmtNum(data.kpis.lead_time_p50_7d_min)}min`}
          delta={data.kpis.delta_lead_time_pct}
          inverseDelta
        />
        <KpiCard
          label="Acurácia inventário"
          value={data.kpis.acuracidade_pct !== null ? `${data.kpis.acuracidade_pct}%` : "—"}
          sub="últimos 30d"
          tone={data.kpis.acuracidade_pct !== null && data.kpis.acuracidade_pct < 95 ? "warn" : "good"}
        />
        <KpiCard
          label="SKUs em ruptura"
          value={fmtNum(data.kpis.cobertura_critico)}
          sub="crítico + lead-time risco"
          tone={data.kpis.cobertura_critico > 0 ? "bad" : "good"}
        />
        <KpiCard label="Capital em estoque" value={fmtBRL(data.kpis.capital_total)} sub="valor atual" />
        <KpiCard
          label="Taxa devolução 30d"
          value={data.kpis.devolucoes_taxa_30d !== null ? `${data.kpis.devolucoes_taxa_30d}%` : "—"}
          sub="vs vendas 30d"
        />
      </section>

      <section className="rounded-xl border border-line bg-paper p-4">
        <h2 className="text-sm font-semibold text-ink">Throughput diário (últimos 30d)</h2>
        <p className="mt-1 text-xs text-ink-faint">Embalados/dia, escala normalizada.</p>
        <Sparkline data={data.throughput_30d} />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-ink">Navegar pelas análises</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="block rounded-xl border border-line bg-paper p-4 transition-colors hover:bg-surface"
            >
              <p className="text-sm font-semibold text-ink">{l.label}</p>
              <p className="mt-1 text-xs text-ink-muted">{l.desc}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function Sparkline({ data }: { data: ThroughputDia[] }) {
  const max = Math.max(...data.map((d) => d.pedidos), 1);
  return (
    <div className="mt-3 flex h-24 items-end gap-[3px]">
      {data.map((d) => {
        const h = Math.max((d.pedidos / max) * 100, d.pedidos > 0 ? 6 : 2);
        return (
          <div
            key={d.dia}
            className="flex-1 rounded-t bg-sky-400/80 dark:bg-sky-500/70"
            style={{ height: `${h}%` }}
            title={`${d.dia}: ${d.pedidos}`}
          />
        );
      })}
    </div>
  );
}
