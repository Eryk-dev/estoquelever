"use client";
import { use } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";

interface DivergenciaRow {
  id: string;
  produto?: { sku: string; descricao?: string };
  localizacao?: { codigo?: string };
  saldo_sistema: number;
  qty_contada_final: number;
  delta: number;
  delta_pct: number | null;
  valor_financeiro: number | null;
  status: string;
}

export default function DivergenciasPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["wms-inv-div", id],
    queryFn: async () =>
      (await sisoFetch(`/api/wms/inventario/${id}/divergencias`)).json() as Promise<{
        rows: DivergenciaRow[];
      }>,
  });

  const resolver = useMutation({
    mutationFn: async ({
      divergencia_id,
      acao,
    }: {
      divergencia_id: string;
      acao: "aprovar" | "rejeitar" | "recontar";
    }) =>
      sisoFetch(`/api/wms/inventario/${id}/divergencias`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ divergencia_id, acao }),
      }).then((r) => r.json()),
    onSuccess: () => {
      toast.success("ok");
      queryClient.invalidateQueries({ queryKey: ["wms-inv-div", id] });
    },
  });

  return (
    <div className="space-y-3 max-w-5xl">
      <h1 className="text-lg font-medium">Divergências</h1>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-zinc-500 text-xs">
            <th>SKU</th>
            <th>localização</th>
            <th className="text-right">esperado</th>
            <th className="text-right">contado</th>
            <th className="text-right">delta</th>
            <th className="text-right">%</th>
            <th>R$</th>
            <th>status</th>
            <th>ações</th>
          </tr>
        </thead>
        <tbody>
          {data?.rows.map((d) => (
            <tr
              key={d.id}
              className="border-t border-zinc-200 dark:border-zinc-800"
            >
              <td className="font-mono text-xs">{d.produto?.sku}</td>
              <td>{d.localizacao?.codigo}</td>
              <td className="text-right tabular-nums">{d.saldo_sistema}</td>
              <td className="text-right tabular-nums">{d.qty_contada_final}</td>
              <td
                className={`text-right tabular-nums ${
                  d.delta > 0
                    ? "text-green-700"
                    : d.delta < 0
                      ? "text-red-700"
                      : ""
                }`}
              >
                {d.delta}
              </td>
              <td className="text-right tabular-nums">
                {d.delta_pct ?? "—"}%
              </td>
              <td className="text-right tabular-nums">
                {d.valor_financeiro?.toFixed(2) ?? "—"}
              </td>
              <td>
                <span className="text-xs px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">
                  {d.status}
                </span>
              </td>
              <td className="space-x-1">
                {d.status === "pendente" && (
                  <>
                    <button
                      onClick={() =>
                        resolver.mutate({ divergencia_id: d.id, acao: "aprovar" })
                      }
                      className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-900"
                    >
                      aprovar
                    </button>
                    <button
                      onClick={() =>
                        resolver.mutate({ divergencia_id: d.id, acao: "recontar" })
                      }
                      className="text-xs px-2 py-0.5 rounded bg-yellow-100 text-yellow-900"
                    >
                      recontar
                    </button>
                    <button
                      onClick={() =>
                        resolver.mutate({ divergencia_id: d.id, acao: "rejeitar" })
                      }
                      className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-900"
                    >
                      rejeitar
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
