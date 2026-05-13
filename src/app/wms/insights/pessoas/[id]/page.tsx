"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ErrorBanner } from "@/components/ui/error-banner";
import type { PessoaDetalheDia } from "@/lib/wms/insights/types";

interface Response {
  usuario: { id: string; nome: string; cargo: string; ativo: boolean };
  serie: PessoaDetalheDia[];
}

export default function PessoaDrillPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["insights", "pessoa", id],
    queryFn: () => wmsApi<Response>(`/api/wms/insights/pessoas/${id}?dias=30`),
  });

  if (isLoading) return <LoadingSpinner />;
  if (isError) return <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;

  const totais = data.serie.reduce(
    (acc, d) => ({
      sep: acc.sep + d.pedidos_separados,
      guard: acc.guard + d.pendencias_guardadas,
      cont: acc.cont + d.locs_contadas,
      outras: acc.outras + d.acoes_outras,
      div: acc.div + d.divergencias,
    }),
    { sep: 0, guard: 0, cont: 0, outras: 0, div: 0 },
  );

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/wms/insights/pessoas"
          className="inline-flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Voltar
        </Link>
        <h1 className="mt-2 text-xl font-bold tracking-tight text-ink">{data.usuario.nome}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Cargo: {data.usuario.cargo} · Últimos 30 dias
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Pill label="Separações" value={totais.sep} />
        <Pill label="Guardas" value={totais.guard} />
        <Pill label="Locs contadas" value={totais.cont} />
        <Pill label="Outras ações" value={totais.outras} />
        <Pill label="Divergências" value={totais.div} tone={totais.div > 0 ? "bad" : "good"} />
      </section>

      <section className="rounded-xl border border-line bg-paper p-4">
        <h2 className="text-sm font-semibold text-ink">Atividade diária (30d)</h2>
        <table className="mt-3 w-full text-xs">
          <thead className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            <tr>
              <th className="py-2 text-left">Dia</th>
              <th className="py-2 text-right">Sep</th>
              <th className="py-2 text-right">Guarda</th>
              <th className="py-2 text-right">Conta</th>
              <th className="py-2 text-right">Outras</th>
              <th className="py-2 text-right">Diverg.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.serie.map((d) => (
              <tr key={d.dia} className="hover:bg-surface/60">
                <td className="py-1.5">{d.dia}</td>
                <td className="py-1.5 text-right font-mono tabular-nums">{d.pedidos_separados || ""}</td>
                <td className="py-1.5 text-right font-mono tabular-nums">{d.pendencias_guardadas || ""}</td>
                <td className="py-1.5 text-right font-mono tabular-nums">{d.locs_contadas || ""}</td>
                <td className="py-1.5 text-right font-mono tabular-nums">{d.acoes_outras || ""}</td>
                <td className="py-1.5 text-right font-mono tabular-nums">{d.divergencias || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Pill({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "good" | "bad";
}) {
  const color =
    tone === "bad" ? "text-red-600 dark:text-red-400"
    : tone === "good" ? "text-emerald-600 dark:text-emerald-400"
    : "text-ink";
  return (
    <div className="rounded-xl border border-line bg-paper p-3">
      <p className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">{label}</p>
      <p className={`mt-1 font-mono text-xl font-bold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
