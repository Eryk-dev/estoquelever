"use client";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";

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

export default function MetricasPage() {
  const { data } = useQuery({
    queryKey: ["wms-inv-metricas"],
    queryFn: async () =>
      (await sisoFetch("/api/wms/inventario/metricas")).json() as Promise<{
        porOperador: OperadorRow[];
        porLocalizacao: LocalizacaoRow[];
      }>,
  });

  return (
    <div className="space-y-4 max-w-4xl">
      <h2 className="text-lg font-medium">Acuracidade por operador (30d)</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-zinc-500">
            <th>operador</th>
            <th className="text-right">contagens</th>
            <th className="text-right">erro médio %</th>
          </tr>
        </thead>
        <tbody>
          {data?.porOperador?.map((r) => (
            <tr
              key={r.operador_id}
              className="border-t border-zinc-200 dark:border-zinc-800"
            >
              <td>{r.nome}</td>
              <td className="text-right tabular-nums">{r.contagens}</td>
              <td className="text-right tabular-nums">
                {r.erro_medio_pct?.toFixed(2) ?? "—"}
              </td>
            </tr>
          ))}
          {data && data.porOperador.length === 0 && (
            <tr>
              <td colSpan={3} className="text-zinc-500 py-2">
                sem contagens nos últimos 30 dias
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2 className="text-lg font-medium">Acuracidade por localização</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-zinc-500">
            <th>código</th>
            <th className="text-right">total</th>
            <th className="text-right">s/ divergência</th>
            <th className="text-right">erro médio %</th>
          </tr>
        </thead>
        <tbody>
          {data?.porLocalizacao?.map((r) => (
            <tr
              key={r.localizacao_id}
              className="border-t border-zinc-200 dark:border-zinc-800"
            >
              <td className="font-mono">{r.codigo}</td>
              <td className="text-right tabular-nums">{r.total}</td>
              <td className="text-right tabular-nums">{r.sem_div}</td>
              <td className="text-right tabular-nums">
                {r.erro_medio_pct?.toFixed(2) ?? "—"}
              </td>
            </tr>
          ))}
          {data && data.porLocalizacao.length === 0 && (
            <tr>
              <td colSpan={4} className="text-zinc-500 py-2">
                sem dados ainda
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
