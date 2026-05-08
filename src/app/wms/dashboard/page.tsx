"use client";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import Link from "next/link";
import type { DashboardGeralResult } from "@/lib/wms/dashboard-geral";

interface CardItem {
  label: string;
  valor: number | string;
  emoji?: string;
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
    "block p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900";
  const inner = (
    <>
      <div className="text-sm font-medium mb-2">{titulo}</div>
      <div className="space-y-1">
        {items.map((it, i) => (
          <div key={i} className="flex justify-between text-sm">
            <span className="text-zinc-500">
              {it.emoji} {it.label}
            </span>
            <span className="tabular-nums font-medium">{it.valor}</span>
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
  const { data, isLoading } = useQuery({
    queryKey: ["wms-dashboard"],
    queryFn: async () =>
      (await sisoFetch("/api/wms/dashboard-geral")).json() as Promise<DashboardGeralResult>,
    refetchInterval: 30000,
  });

  if (isLoading) return <div className="text-zinc-500">carregando...</div>;
  if (!data) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      <Card
        titulo="Cobertura"
        href="/wms/cobertura"
        items={[
          {
            label: "Crítico (<7d)",
            valor: data.cobertura.critico ?? 0,
            emoji: "🔴",
          },
          {
            label: "Risco vs lead time",
            valor: data.cobertura.lead_time_risco ?? 0,
            emoji: "🟠",
          },
          {
            label: "Atenção (<14d)",
            valor: data.cobertura.atencao ?? 0,
            emoji: "🟡",
          },
          {
            label: "Sem giro 30d",
            valor: data.cobertura.sem_giro ?? 0,
            emoji: "⚫",
          },
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
          },
          {
            label: "Locks > 1h",
            valor: data.inventario.locksAntigos,
            emoji: data.inventario.locksAntigos > 0 ? "⚠️" : "",
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
            emoji: data.retroativosOrfaos > 0 ? "⚠️" : "",
          },
        ]}
      />
      <Card
        titulo="Empréstimos"
        href="/wms/emprestimos"
        items={[
          {
            label: "Pares com saldo devedor",
            valor: data.emprestimos.paresComSaldo,
          },
        ]}
      />
    </div>
  );
}
