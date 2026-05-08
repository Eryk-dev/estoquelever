"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import type { LinhaCobertura, StatusCobertura } from "@/lib/wms/cobertura";

const STATUS_LABELS: Record<StatusCobertura, { label: string; color: string }> = {
  critico: { label: "🔴 Crítico", color: "bg-red-100 text-red-900" },
  lead_time_risco: {
    label: "🟠 Risco vs lead time",
    color: "bg-orange-100 text-orange-900",
  },
  atencao: { label: "🟡 Atenção", color: "bg-yellow-100 text-yellow-900" },
  ok: { label: "🟢 Ok", color: "bg-green-100 text-green-900" },
  sem_giro: { label: "⚫ Sem giro", color: "bg-zinc-200 text-zinc-700" },
};

export default function CoberturaPage() {
  const [status, setStatus] = useState("");
  const { data } = useQuery({
    queryKey: ["wms-cobertura", status],
    queryFn: async () =>
      (
        await sisoFetch(
          `/api/wms/cobertura${status ? `?status=${status}` : ""}`,
        )
      ).json() as Promise<{ rows: LinhaCobertura[] }>,
  });

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="px-2 py-1 rounded border bg-transparent"
        >
          <option value="">todos</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-zinc-500">
            <th>SKU</th>
            <th>galpão</th>
            <th>empresa</th>
            <th className="text-right">disponível</th>
            <th className="text-right">giro/dia</th>
            <th className="text-right">dias</th>
            <th className="text-right">lead</th>
            <th>status</th>
          </tr>
        </thead>
        <tbody>
          {data?.rows.map((r, i) => (
            <tr key={i} className="border-t border-zinc-200 dark:border-zinc-800">
              <td className="font-mono text-xs">{r.produto?.sku}</td>
              <td>{r.galpao?.nome}</td>
              <td>{r.empresa?.nome}</td>
              <td className="text-right tabular-nums">
                {Number(r.disponivel_total).toLocaleString("pt-BR")}
              </td>
              <td className="text-right tabular-nums">
                {Number(r.giro_diario).toFixed(2)}
              </td>
              <td className="text-right tabular-nums">
                {r.dias_cobertura
                  ? Number(r.dias_cobertura).toFixed(1)
                  : "—"}
              </td>
              <td className="text-right tabular-nums">
                {r.lead_time_medio ?? "—"}
              </td>
              <td>
                <span
                  className={`text-xs px-2 py-0.5 rounded ${STATUS_LABELS[r.status_cobertura]?.color ?? ""}`}
                >
                  {STATUS_LABELS[r.status_cobertura]?.label ?? r.status_cobertura}
                </span>
              </td>
            </tr>
          ))}
          {data && data.rows.length === 0 && (
            <tr>
              <td colSpan={8} className="text-zinc-500 py-2">
                sem dados (rode o refresh ou aguarde produção real)
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
