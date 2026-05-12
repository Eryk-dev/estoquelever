"use client";
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, PageHeader, StatusBadge, fmtNum } from "@/components/wms/ui/wms-ui";
import { ProdutoDrawer } from "@/components/wms/produto-drawer";
import type { LinhaCobertura, StatusCobertura } from "@/lib/wms/cobertura";

const STATUS_OPTS: Array<{
  filter: StatusCobertura | "all";
  label: string;
  desc: string;
  tone: "danger" | "warn" | "ok" | "mute" | "info";
}> = [
  { filter: "critico", label: "Crítico", desc: "cobertura < lead time", tone: "danger" },
  { filter: "atencao", label: "Atenção", desc: "próximo do lead time", tone: "warn" },
  { filter: "ok", label: "OK", desc: "cobertura > lead time", tone: "ok" },
  { filter: "sem_giro", label: "Sem giro", desc: "zero vendas 30d", tone: "mute" },
  {
    filter: "lead_time_risco",
    label: "Sem fornec.",
    desc: "sem fornecedor preferencial",
    tone: "warn",
  },
  { filter: "all", label: "Todos", desc: "lista completa", tone: "info" },
];

export default function CoberturaPage() {
  const [filter, setFilter] = useState<StatusCobertura | "all">("all");
  const router = useRouter();
  const searchParams = useSearchParams();
  const drawer = searchParams?.get("produto") ?? null;

  const openDrawer = useCallback(
    (id: string) => {
      const params = new URLSearchParams(
        Array.from(searchParams?.entries() ?? []),
      );
      params.set("produto", id);
      router.push(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const closeDrawer = useCallback(() => {
    const params = new URLSearchParams(
      Array.from(searchParams?.entries() ?? []),
    );
    params.delete("produto");
    const qs = params.toString();
    router.push(qs ? `?${qs}` : "?", { scroll: false });
  }, [router, searchParams]);

  const query = useQuery({
    queryKey: ["wms-cobertura"],
    queryFn: () => wmsApi<{ rows: LinhaCobertura[] }>(`/api/wms/cobertura`),
  });
  const all = query.data?.rows ?? [];

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of all) c[r.status_cobertura] = (c[r.status_cobertura] ?? 0) + 1;
    return c;
  }, [all]);

  const rows = useMemo(() => {
    let r = all;
    if (filter !== "all") r = r.filter((x) => x.status_cobertura === filter);
    return [...r].sort(
      (a, b) =>
        Number(a.dias_cobertura ?? Infinity) - Number(b.dias_cobertura ?? Infinity),
    );
  }, [all, filter]);

  return (
    <>
      <PageHeader
        title="Cobertura por giro"
        subtitle="Cruzamento de disponível × giro 30d × lead time do fornecedor preferencial"
      >
        <button className="wms-btn wms-btn-ghost" disabled>
          <Icon name="download" size={12} />
          Exportar
        </button>
      </PageHeader>

      <div className="wms-cov-stats-row">
        {STATUS_OPTS.map((s) => {
          const count = s.filter === "all" ? all.length : counts[s.filter] ?? 0;
          return (
            <button
              key={s.filter}
              className={`wms-cov-stat-card wms-cov-${s.tone} ${
                filter === s.filter ? "is-active" : ""
              }`}
              onClick={() => setFilter(s.filter)}
            >
              <div className="wms-cov-stat-card-h">{s.label}</div>
              <div className="wms-cov-stat-card-n">{count}</div>
              <div className="wms-cov-stat-card-d">{s.desc}</div>
            </button>
          );
        })}
      </div>

      <div className="wms-tbl">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>SKU</th>
              <th>Produto</th>
              <th>Galpão</th>
              <th>Empresa</th>
              <th className="wms-tar">Disponível</th>
              <th className="wms-tar">Giro/dia</th>
              <th className="wms-tar">Lead time</th>
              <th className="wms-tar">Cobertura</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading && (
              <tr>
                <td colSpan={10} className="wms-td-empty">
                  Carregando…
                </td>
              </tr>
            )}
            {query.isError && (
              <tr>
                <td colSpan={10} className="wms-td-empty wms-td-danger">
                  Erro: {(query.error as Error).message}
                </td>
              </tr>
            )}
            {!query.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={10} className="wms-td-empty">
                  Sem produtos para esse filtro.
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr
                key={`${r.produto_id}-${r.galpao_id}-${i}`}
                className="wms-tr-clickable"
                onClick={() => openDrawer(r.produto_id)}
              >
                <td>
                  <StatusBadge status={r.status_cobertura} />
                </td>
                <td className="wms-mono">
                  <a className="wms-link-row">{r.produto?.sku}</a>
                </td>
                <td className="wms-td-desc">{r.produto?.descricao}</td>
                <td className="wms-td-mute">{r.galpao?.nome}</td>
                <td className="wms-td-mute">{r.empresa?.nome}</td>
                <td className="wms-tar wms-mono">
                  {fmtNum(Number(r.disponivel_total))}
                </td>
                <td className="wms-tar wms-mono">
                  {Number(r.giro_diario).toFixed(2)}
                </td>
                <td className="wms-tar wms-mono wms-td-mute">
                  {r.lead_time_medio ?? "—"}
                  {r.lead_time_medio != null ? "d" : ""}
                </td>
                <td className="wms-tar wms-mono">
                  <CovBar
                    dias={Number(r.dias_cobertura ?? 0)}
                    lead={Number(r.lead_time_medio ?? 0)}
                    status={r.status_cobertura}
                  />
                </td>
                <td className="wms-td-actions">
                  <Icon name="chevron-r" size={11} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {drawer && (
        <ProdutoDrawer produtoId={drawer} onClose={closeDrawer} />
      )}
    </>
  );
}

function CovBar({
  dias,
  lead,
  status,
}: {
  dias: number;
  lead: number;
  status: StatusCobertura;
}) {
  const max = 90;
  const pct = Math.min((dias / max) * 100, 100);
  const leadPct = Math.min((lead / max) * 100, 100);
  return (
    <div className="wms-cov-bar-mini">
      <div
        className={`wms-cov-bar-mini-fill cov-${status}`}
        style={{ width: `${pct}%` }}
      />
      {lead > 0 && (
        <div
          className="wms-cov-bar-mini-lead"
          style={{ left: `${leadPct}%` }}
        />
      )}
      <span className="wms-cov-bar-mini-lbl wms-mono">
        {dias.toFixed(0)}d
      </span>
    </div>
  );
}
