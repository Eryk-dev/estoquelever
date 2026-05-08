"use client";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import Link from "next/link";

interface DevRow {
  id: string;
  nota_fiscal_id: number | null;
  empresa?: { nome?: string } | null;
  criado_em: string;
}

export default function DevolucoesPage() {
  const { data } = useQuery({
    queryKey: ["wms-devolucoes"],
    queryFn: async () =>
      (await sisoFetch("/api/wms/devolucoes")).json() as Promise<{
        rows: DevRow[];
      }>,
  });

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-medium">Devoluções pendentes</h1>
      <p className="text-sm text-zinc-500">
        Aguardando chegada física e classificação pelo operador.
      </p>
      <div className="space-y-2">
        {data?.rows.map((d) => (
          <Link
            key={d.id}
            href={`/wms/devolucoes/${d.id}`}
            className="block p-3 rounded border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono text-xs">
                  NF {d.nota_fiscal_id ?? "—"}
                </span>
                <span className="ml-2 text-sm">{d.empresa?.nome}</span>
              </div>
              <div className="text-xs text-zinc-500">
                {new Date(d.criado_em).toLocaleString("pt-BR")}
              </div>
            </div>
          </Link>
        ))}
        {data && data.rows.length === 0 && (
          <div className="text-zinc-500 text-sm">nenhuma devolução pendente</div>
        )}
      </div>
    </div>
  );
}
