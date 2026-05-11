"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, PageHeader } from "@/components/wms/ui/wms-ui";
import { LedgerRow } from "@/components/wms/produto-drawer";
import type { Movimentacao } from "@/lib/wms/types";

interface LedgerRowData extends Movimentacao {
  produto?: { sku: string; descricao: string };
  empresa?: { nome: string };
  galpao?: { nome: string };
  localizacao?: { codigo: string; tipo: string };
}

const TIPO_OPTS: Array<[string, string]> = [
  ["all", "Todos"],
  ["E", "Entradas"],
  ["S", "Saídas"],
  ["R", "Reservas"],
  ["L", "Liberações"],
];

export default function LedgerPage() {
  const [tipo, setTipo] = useState<string>("all");
  const [origem, setOrigem] = useState<string>("all");
  const [q, setQ] = useState("");

  const ledgerQuery = useQuery({
    queryKey: ["wms-ledger", "global", origem],
    queryFn: () => {
      const sp = new URLSearchParams({ limit: "300" });
      if (origem !== "all") sp.set("origem_tipo", origem);
      return wmsApi<{ rows: LedgerRowData[] }>(`/api/wms/ledger?${sp}`);
    },
  });
  const all = ledgerQuery.data?.rows ?? [];

  const filtered = useMemo(() => {
    let r = all;
    if (tipo !== "all") r = r.filter((m) => m.tipo === tipo);
    if (q) {
      const ql = q.toLowerCase();
      r = r.filter((m) => {
        const sku = m.produto?.sku?.toLowerCase() ?? "";
        const desc = m.produto?.descricao?.toLowerCase() ?? "";
        const obs = (m.observacoes ?? "").toLowerCase();
        return sku.includes(ql) || desc.includes(ql) || obs.includes(ql);
      });
    }
    return r;
  }, [all, tipo, q]);

  const origens = useMemo(
    () => Array.from(new Set(all.map((m) => m.origem_tipo))).sort(),
    [all],
  );

  return (
    <>
      <PageHeader
        title="Movimentações"
        subtitle={`Ledger imutável · ${filtered.length} de ${all.length} registros`}
      >
        <button className="wms-btn wms-btn-ghost" disabled>
          <Icon name="download" size={12} />
          Exportar
        </button>
      </PageHeader>

      <div className="wms-toolbar">
        <div className="wms-search-wrap">
          <Icon name="search" size={13} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar SKU, produto ou observação…"
          />
          {q && (
            <button className="wms-search-clear" onClick={() => setQ("")}>
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
        <div className="wms-seg">
          {TIPO_OPTS.map(([id, l]) => (
            <button
              key={id}
              className={`wms-seg-btn ${tipo === id ? "is-active" : ""}`}
              onClick={() => setTipo(id)}
            >
              {l}
            </button>
          ))}
        </div>
        <select
          className="wms-select"
          value={origem}
          onChange={(e) => setOrigem(e.target.value)}
          style={{ width: 220 }}
        >
          <option value="all">Todas origens</option>
          {origens.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>

      <div className="wms-ledger-list">
        {ledgerQuery.isLoading && (
          <div className="wms-loading-pane">Carregando…</div>
        )}
        {ledgerQuery.isError && (
          <div className="wms-td-empty wms-td-danger" style={{ padding: 32 }}>
            Erro: {(ledgerQuery.error as Error).message}
          </div>
        )}
        {!ledgerQuery.isLoading && filtered.length === 0 && (
          <div className="wms-td-empty" style={{ padding: 32 }}>
            Nenhuma movimentação.
          </div>
        )}
        {filtered.map((m) => (
          <LedgerRow key={m.id} m={m} />
        ))}
      </div>
    </>
  );
}
