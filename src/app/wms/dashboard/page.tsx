"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ErrorBanner } from "@/components/ui/error-banner";
import type { DashboardGeralResult } from "@/lib/wms/dashboard-geral";

interface CardItem {
  label: string;
  valor: number | string;
  hint?: "warn" | "danger";
}

function Card({
  titulo,
  items,
  href,
}: {
  titulo: string;
  items: CardItem[];
  href?: string;
}) {
  const className =
    "block rounded-xl border border-line bg-paper p-4 transition-colors hover:bg-surface";
  const inner = (
    <>
      <div className="mb-2 text-sm font-semibold text-ink">{titulo}</div>
      <div className="space-y-1">
        {items.map((it, i) => (
          <div key={i} className="flex justify-between text-sm">
            <span className="text-ink-muted">{it.label}</span>
            <span
              className={`tabular-nums font-medium ${
                it.hint === "danger"
                  ? "text-danger"
                  : it.hint === "warn"
                    ? "text-warning"
                    : "text-ink"
              }`}
            >
              {it.valor}
            </span>
          </div>
        ))}
      </div>
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {inner}
    </Link>
  ) : (
    <div className={className}>{inner}</div>
  );
}

export default function DashboardPage() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["wms-dashboard"],
    queryFn: () => wmsApi<DashboardGeralResult>("/api/wms/dashboard-geral"),
    refetchInterval: 30000,
  });

  if (isLoading) return <LoadingSpinner />;
  if (isError) {
    return (
      <ErrorBanner
        message={(error as Error).message}
        onRetry={() => refetch()}
      />
    );
  }
  if (!data) return null;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Card
        titulo="Cobertura"
        href="/wms/cobertura"
        items={[
          {
            label: "Crítico (<7d)",
            valor: data.cobertura.critico ?? 0,
            hint: (data.cobertura.critico ?? 0) > 0 ? "danger" : undefined,
          },
          {
            label: "Risco vs lead time",
            valor: data.cobertura.lead_time_risco ?? 0,
            hint: (data.cobertura.lead_time_risco ?? 0) > 0 ? "warn" : undefined,
          },
          {
            label: "Atenção (<14d)",
            valor: data.cobertura.atencao ?? 0,
            hint: (data.cobertura.atencao ?? 0) > 0 ? "warn" : undefined,
          },
          { label: "Sem giro 30d", valor: data.cobertura.sem_giro ?? 0 },
        ]}
      />
      <Card
        titulo="Inventário"
        href="/wms/inventario"
        items={[
          { label: "Sessões ativas", valor: data.inventario.sessoesAtivas },
          {
            label: "Divergências pendentes",
            valor: data.inventario.divergenciasPend,
            hint:
              (data.inventario.divergenciasPend ?? 0) > 0 ? "warn" : undefined,
          },
          {
            label: "Locks > 1h",
            valor: data.inventario.locksAntigos,
            hint:
              (data.inventario.locksAntigos ?? 0) > 0 ? "danger" : undefined,
          },
        ]}
      />
      <Card
        titulo="Reservas"
        items={[
          { label: "Expirando em 6h", valor: data.reservas.expiraEm6h },
          {
            label: "Lançamentos retroativos órfãos",
            valor: data.retroativosOrfaos,
            hint: (data.retroativosOrfaos ?? 0) > 0 ? "danger" : undefined,
          },
        ]}
      />
    </div>
  );
}
