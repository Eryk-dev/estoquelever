"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, PageHeader } from "@/components/wms/ui/wms-ui";
import type { Produto } from "@/lib/wms/types";

interface EmpresaLite {
  id: string;
  nome: string;
}
interface GalpaoLite {
  id: string;
  nome: string;
}
interface SaldoRow {
  empresa_id: string;
  produto_id: string;
  galpao_id: string;
  saldo_virtual: number;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function csvEscape(v: string | number): string {
  const s = String(v ?? "");
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function SaldosPorEmpresaPage() {
  const [galpaoId, setGalpaoId] = useState<string>("all");
  const [empresaId, setEmpresaId] = useState<string>("all");

  const empresasQuery = useQuery({
    queryKey: ["wms-empresas-lite"],
    queryFn: () => wmsApi<EmpresaLite[]>(`/api/wms/admin/empresas`),
  });
  const galpoesQuery = useQuery({
    queryKey: ["wms-galpoes-lite"],
    queryFn: () =>
      wmsApi<GalpaoLite[]>(`/api/wms/admin/galpoes`).then((arr) =>
        arr.map((g) => ({ id: g.id, nome: g.nome })),
      ),
  });
  const empresas = empresasQuery.data ?? [];
  const galpoes = galpoesQuery.data ?? [];

  const saldosQuery = useQuery({
    queryKey: ["wms-relatorio-saldos", galpaoId, empresaId],
    queryFn: () => {
      const sp = new URLSearchParams();
      if (galpaoId !== "all") sp.set("galpao_id", galpaoId);
      if (empresaId !== "all") sp.set("empresa_id", empresaId);
      const qs = sp.toString();
      return wmsApi<{ items: SaldoRow[] }>(
        `/api/wms/relatorios/saldos-por-empresa${qs ? `?${qs}` : ""}`,
      );
    },
  });

  const rows = saldosQuery.data?.items ?? [];

  const empresaMap = useMemo(
    () => new Map(empresas.map((e) => [e.id, e.nome])),
    [empresas],
  );
  const galpaoMap = useMemo(
    () => new Map(galpoes.map((g) => [g.id, g.nome])),
    [galpoes],
  );

  // Lookup produtos (limitado a 200 — pra volumes maiores aparecerá o uuid)
  const produtoIds = useMemo(
    () => Array.from(new Set(rows.map((r) => r.produto_id))).slice(0, 200),
    [rows],
  );
  const produtosLookupQuery = useQuery({
    queryKey: ["wms-produtos-lookup", produtoIds.join(",")],
    queryFn: async () => {
      if (produtoIds.length === 0) return { rows: [] as Produto[] };
      return wmsApi<{ rows: Produto[] }>(`/api/wms/produtos?limit=200`);
    },
    enabled: produtoIds.length > 0,
  });
  const produtoMap = useMemo(() => {
    const m = new Map<string, Produto>();
    for (const p of produtosLookupQuery.data?.rows ?? []) m.set(p.id, p);
    return m;
  }, [produtosLookupQuery.data]);

  const handleExport = () => {
    const header = [
      "Empresa",
      "Produto SKU",
      "Produto",
      "Galpão",
      "Saldo virtual",
    ];
    const lines = rows.map((r) => {
      const p = produtoMap.get(r.produto_id);
      return [
        empresaMap.get(r.empresa_id) ?? r.empresa_id,
        p?.sku ?? "",
        p?.descricao ?? "",
        galpaoMap.get(r.galpao_id) ?? r.galpao_id,
        r.saldo_virtual.toFixed(0),
      ];
    });
    const stamp = isoDate(new Date()).replace(/-/g, "");
    downloadCsv(`saldos-por-empresa-${stamp}.csv`, [header, ...lines]);
  };

  return (
    <>
      <PageHeader
        title="Saldos por Empresa"
        subtitle={`Saldo virtual = Σ entradas − Σ saídas (visão fiscal) · ${rows.length} linhas`}
      >
        <button
          className="wms-btn wms-btn-ghost"
          onClick={handleExport}
          disabled={rows.length === 0}
        >
          <Icon name="download" size={12} />
          Exportar CSV
        </button>
      </PageHeader>

      <div className="wms-toolbar" style={{ flexWrap: "wrap", gap: 8 }}>
        <select
          className="wms-select"
          value={galpaoId}
          onChange={(e) => setGalpaoId(e.target.value)}
          style={{ width: 180 }}
        >
          <option value="all">Todos galpões</option>
          {galpoes.map((g) => (
            <option key={g.id} value={g.id}>
              {g.nome}
            </option>
          ))}
        </select>
        <select
          className="wms-select"
          value={empresaId}
          onChange={(e) => setEmpresaId(e.target.value)}
          style={{ width: 200 }}
        >
          <option value="all">Todas empresas</option>
          {empresas.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nome}
            </option>
          ))}
        </select>
      </div>

      {saldosQuery.isLoading && (
        <div className="wms-loading-pane">Carregando…</div>
      )}
      {saldosQuery.isError && (
        <div className="wms-empty-block">
          <h3>Erro</h3>
          <p>{(saldosQuery.error as Error).message}</p>
        </div>
      )}
      {!saldosQuery.isLoading && rows.length === 0 && (
        <div className="wms-empty-block">
          <h3>Sem saldos</h3>
          <p>Nenhum (empresa, produto, galpão) com saldo virtual ≠ 0.</p>
        </div>
      )}
      {rows.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th>Empresa</th>
                <th>Produto</th>
                <th>Galpão</th>
                <th style={{ textAlign: "right" }}>Saldo virtual</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const p = produtoMap.get(r.produto_id);
                return (
                  <tr
                    key={`${r.empresa_id}-${r.produto_id}-${r.galpao_id}-${i}`}
                  >
                    <td>{empresaMap.get(r.empresa_id) ?? "—"}</td>
                    <td>
                      {p ? (
                        <>
                          <span className="wms-mono">{p.sku}</span>{" "}
                          <span className="wms-td-mute">— {p.descricao}</span>
                        </>
                      ) : (
                        <span className="wms-td-mute wms-mono">
                          {r.produto_id.slice(0, 8)}…
                        </span>
                      )}
                    </td>
                    <td>{galpaoMap.get(r.galpao_id) ?? "—"}</td>
                    <td
                      className={
                        r.saldo_virtual < 0 ? "wms-td-danger" : "wms-td-strong"
                      }
                      style={{ textAlign: "right" }}
                    >
                      {r.saldo_virtual.toLocaleString("pt-BR")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
