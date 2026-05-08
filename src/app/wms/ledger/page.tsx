"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";

interface LedgerRow {
  id: string;
  criado_em: string;
  tipo: string;
  origem_tipo: string;
  quantidade: number;
  saldo_anterior: number;
  saldo_posterior: number;
  produto?: { sku: string };
  empresa?: { nome: string };
  galpao?: { nome: string };
  localizacao?: { codigo: string };
}

export default function LedgerPage() {
  const [filtros, setFiltros] = useState({ origem_tipo: "", limit: 100 });
  const { data } = useQuery({
    queryKey: ["wms-ledger", filtros],
    queryFn: async () => {
      const sp = new URLSearchParams();
      if (filtros.origem_tipo) sp.set("origem_tipo", filtros.origem_tipo);
      sp.set("limit", String(filtros.limit));
      const r = await sisoFetch(`/api/wms/ledger?${sp}`);
      return r.json() as Promise<{ rows: LedgerRow[] }>;
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center text-sm">
        <select
          value={filtros.origem_tipo}
          onChange={(e) => setFiltros({ ...filtros, origem_tipo: e.target.value })}
          className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
        >
          <option value="">todas origens</option>
          {[
            "compra_manual",
            "nf_venda",
            "emprestimo",
            "reserva_pedido",
            "liberacao_reserva",
            "ajuste_manual",
            "inventario",
            "inventario_inicial",
          ].map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>

      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-left text-zinc-500">
            <th className="p-1">data</th>
            <th>tipo</th>
            <th>origem</th>
            <th>SKU</th>
            <th>dona</th>
            <th>galpão</th>
            <th>loc</th>
            <th className="text-right">qty</th>
            <th className="text-right">saldo→</th>
          </tr>
        </thead>
        <tbody>
          {data?.rows.map((r) => (
            <tr key={r.id} className="border-t border-zinc-200 dark:border-zinc-800">
              <td className="p-1 whitespace-nowrap">
                {new Date(r.criado_em).toLocaleString("pt-BR")}
              </td>
              <td className="font-bold">{r.tipo}</td>
              <td>{r.origem_tipo}</td>
              <td>{r.produto?.sku}</td>
              <td>{r.empresa?.nome}</td>
              <td>{r.galpao?.nome}</td>
              <td>{r.localizacao?.codigo}</td>
              <td className="text-right">{r.quantidade}</td>
              <td className="text-right">
                {r.saldo_anterior} → {r.saldo_posterior}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
