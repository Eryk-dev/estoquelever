"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { SaldoPerspectivaTabs } from "@/components/wms/saldo-perspectiva-tabs";
import type { PerspectivaEstoque } from "@/lib/wms/types";

interface ItemRow {
  produto: { sku: string; descricao: string };
  empresa: { nome: string };
  galpao: { nome: string };
  localizacao: { codigo: string };
  saldo: number;
  reservado: number;
  disponivel: number;
}

interface AgregadoRow {
  chave: string;
  nome: string;
  saldo: number;
  reservado: number;
  disponivel: number;
  itens: ItemRow[];
}

export default function EstoquePage() {
  const [view, setView] = useState<PerspectivaEstoque>("produto");
  const { data, isLoading } = useQuery({
    queryKey: ["wms-estoque", view],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/estoque?view=${view}`);
      return r.json() as Promise<{ rows: AgregadoRow[] }>;
    },
  });

  return (
    <div className="space-y-3">
      <SaldoPerspectivaTabs value={view} onChange={setView} />
      {isLoading && <div className="text-zinc-500">carregando...</div>}
      <div className="space-y-1">
        {data?.rows.map((r) => (
          <details
            key={r.chave}
            className="rounded border border-zinc-200 dark:border-zinc-800"
          >
            <summary className="flex items-center justify-between p-3 cursor-pointer">
              <span className="font-medium">{r.nome}</span>
              <span className="text-sm tabular-nums">
                {r.disponivel.toLocaleString("pt-BR")} disp ·{" "}
                {r.reservado.toLocaleString("pt-BR")} res ·{" "}
                {r.saldo.toLocaleString("pt-BR")} total
              </span>
            </summary>
            <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 text-xs space-y-1">
              {r.itens.map((i, idx) => (
                <div key={idx} className="flex gap-3 font-mono">
                  <span>{i.produto.sku}</span>
                  <span>{i.empresa.nome}</span>
                  <span>{i.galpao.nome}</span>
                  <span>{i.localizacao.codigo}</span>
                  <span className="ml-auto">{i.saldo}</span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
