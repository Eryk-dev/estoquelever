"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";
import type { LinhaCobertura, StatusCobertura } from "@/lib/wms/cobertura";

const STATUS_LABELS: Record<StatusCobertura, { label: string; badge: string }> = {
  critico: { label: "Crítico", badge: "badge badge-danger" },
  lead_time_risco: { label: "Risco vs lead time", badge: "badge badge-warning" },
  atencao: { label: "Atenção", badge: "badge badge-warning" },
  ok: { label: "Ok", badge: "badge badge-success" },
  sem_giro: { label: "Sem giro", badge: "badge badge-oc" },
};

export default function CoberturaPage() {
  const [status, setStatus] = useState("");
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["wms-cobertura", status],
    queryFn: () =>
      wmsApi<{ rows: LinhaCobertura[] }>(
        `/api/wms/cobertura${status ? `?status=${status}` : ""}`,
      ),
  });

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
        >
          <option value="">todos os status</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <LoadingSpinner />
      ) : isError ? (
        <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message="Sem dados de cobertura. Execute o refresh ou aguarde dados de produção." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-paper">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-faint">
                <th className="p-2">SKU</th>
                <th>galpão</th>
                <th>empresa</th>
                <th className="text-right">disponível</th>
                <th className="text-right">giro/dia</th>
                <th className="text-right">dias</th>
                <th className="text-right">lead</th>
                <th className="p-2">status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const cfg = STATUS_LABELS[r.status_cobertura];
                return (
                  <tr key={i} className="border-t border-line">
                    <td className="p-2 font-mono text-xs text-ink">{r.produto?.sku}</td>
                    <td className="text-ink-muted">{r.galpao?.nome}</td>
                    <td className="text-ink-muted">{r.empresa?.nome}</td>
                    <td className="text-right tabular-nums text-ink">
                      {Number(r.disponivel_total).toLocaleString("pt-BR")}
                    </td>
                    <td className="text-right tabular-nums text-ink-muted">
                      {Number(r.giro_diario).toFixed(2)}
                    </td>
                    <td className="text-right tabular-nums text-ink-muted">
                      {r.dias_cobertura
                        ? Number(r.dias_cobertura).toFixed(1)
                        : "—"}
                    </td>
                    <td className="text-right tabular-nums text-ink-muted">
                      {r.lead_time_medio ?? "—"}
                    </td>
                    <td className="p-2">
                      <span className={cfg?.badge ?? "badge badge-oc"}>
                        {cfg?.label ?? r.status_cobertura}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
