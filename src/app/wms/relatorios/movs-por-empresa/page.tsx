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
interface MovRow {
  produto_id: string;
  empresa_id: string;
  tipo: "E" | "S";
  qty_total: number;
  valor_total: number;
}

const BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

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

export default function MovsPorEmpresaPage() {
  const [dataInicio, setDataInicio] = useState(() =>
    isoDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
  );
  const [dataFim, setDataFim] = useState(() => isoDate(new Date()));
  const [galpaoId, setGalpaoId] = useState<string>("all");
  const [empresaId, setEmpresaId] = useState<string>("all");
  const [produtoQ, setProdutoQ] = useState("");

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
  const produtosQuery = useQuery({
    queryKey: ["wms-produtos-search", produtoQ],
    queryFn: () =>
      wmsApi<{ rows: Produto[] }>(
        `/api/wms/produtos?limit=10&q=${encodeURIComponent(produtoQ)}`,
      ),
    enabled: produtoQ.length >= 2,
  });

  const empresas = empresasQuery.data ?? [];
  const galpoes = galpoesQuery.data ?? [];

  const [produtoIdFiltro, setProdutoIdFiltro] = useState<string>("");
  const [produtoLabel, setProdutoLabel] = useState<string>("");

  const movsQuery = useQuery({
    queryKey: [
      "wms-relatorio-movs",
      dataInicio,
      dataFim,
      galpaoId,
      empresaId,
      produtoIdFiltro,
    ],
    queryFn: () => {
      const sp = new URLSearchParams({
        data_inicio: dataInicio,
        data_fim: dataFim,
      });
      if (galpaoId !== "all") sp.set("galpao_id", galpaoId);
      if (empresaId !== "all") sp.set("empresa_id", empresaId);
      if (produtoIdFiltro) sp.set("produto_id", produtoIdFiltro);
      return wmsApi<{ items: MovRow[] }>(
        `/api/wms/relatorios/movs-por-empresa?${sp}`,
      );
    },
    enabled: !!dataInicio && !!dataFim,
  });

  const rows = movsQuery.data?.items ?? [];

  // Lookup maps
  const empresaMap = useMemo(
    () => new Map(empresas.map((e) => [e.id, e.nome])),
    [empresas],
  );
  // Pra exibir SKU/descrição mesmo quando filtramos por outros critérios,
  // pré-carregamos produtos dos rows visíveis (lazy fetch).
  const produtoIds = useMemo(
    () => Array.from(new Set(rows.map((r) => r.produto_id))).slice(0, 200),
    [rows],
  );
  const produtosLookupQuery = useQuery({
    queryKey: ["wms-produtos-lookup", produtoIds.join(",")],
    queryFn: async () => {
      if (produtoIds.length === 0) return { rows: [] as Produto[] };
      const sp = new URLSearchParams({ limit: "200" });
      // /api/wms/produtos não tem filtro `id_in`, então buscamos sem filtro
      // e fazemos lookup local; pra volumes >200 isso pode subestimar.
      return wmsApi<{ rows: Produto[] }>(`/api/wms/produtos?${sp}`);
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
      "Produto SKU",
      "Produto",
      "Empresa",
      "Tipo",
      "Qty",
      "Valor (BRL)",
    ];
    const lines = rows.map((r) => {
      const p = produtoMap.get(r.produto_id);
      return [
        p?.sku ?? "",
        p?.descricao ?? "",
        empresaMap.get(r.empresa_id) ?? r.empresa_id,
        r.tipo,
        r.qty_total.toFixed(0),
        r.valor_total.toFixed(2),
      ];
    });
    const stamp = isoDate(new Date()).replace(/-/g, "");
    downloadCsv(`movs-por-empresa-${stamp}.csv`, [header, ...lines]);
  };

  return (
    <>
      <PageHeader
        title="Movimentações por Empresa"
        subtitle={`Agregação por (produto, empresa, tipo) · ${rows.length} grupos`}
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
        <input
          className="wms-input"
          type="date"
          value={dataInicio}
          max={dataFim}
          onChange={(e) => setDataInicio(e.target.value)}
          style={{ width: 150 }}
        />
        <input
          className="wms-input"
          type="date"
          value={dataFim}
          min={dataInicio}
          onChange={(e) => setDataFim(e.target.value)}
          style={{ width: 150 }}
        />
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
        <div className="wms-search-wrap" style={{ minWidth: 240 }}>
          <Icon name="search" size={13} />
          <input
            value={produtoQ}
            onChange={(e) => setProdutoQ(e.target.value)}
            placeholder="Buscar produto…"
          />
          {(produtoQ || produtoIdFiltro) && (
            <button
              className="wms-search-clear"
              onClick={() => {
                setProdutoQ("");
                setProdutoIdFiltro("");
                setProdutoLabel("");
              }}
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
      </div>

      {produtoQ.length >= 2 &&
        !produtoIdFiltro &&
        (produtosQuery.data?.rows ?? []).length > 0 && (
          <div
            className="wms-card"
            style={{
              padding: 6,
              maxHeight: 220,
              overflowY: "auto",
              marginTop: 4,
            }}
          >
            {(produtosQuery.data?.rows ?? []).map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setProdutoIdFiltro(p.id);
                  setProdutoLabel(`${p.sku} — ${p.descricao}`);
                  setProdutoQ(`${p.sku} — ${p.descricao}`);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  padding: "6px 8px",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                <span className="wms-mono">{p.sku}</span> — {p.descricao}
              </button>
            ))}
          </div>
        )}

      {produtoIdFiltro && (
        <div style={{ fontSize: 12, color: "var(--wms-c-mute)", margin: "6px 0" }}>
          Filtrando por produto: <strong>{produtoLabel}</strong>
        </div>
      )}

      {movsQuery.isLoading && (
        <div className="wms-loading-pane">Carregando…</div>
      )}
      {movsQuery.isError && (
        <div className="wms-empty-block">
          <h3>Erro</h3>
          <p>{(movsQuery.error as Error).message}</p>
        </div>
      )}
      {!movsQuery.isLoading && rows.length === 0 && (
        <div className="wms-empty-block">
          <h3>Sem movimentações</h3>
          <p>Ajuste o intervalo ou filtros pra ver resultados.</p>
        </div>
      )}
      {rows.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th>Produto</th>
                <th>Empresa</th>
                <th>Tipo</th>
                <th style={{ textAlign: "right" }}>Qty</th>
                <th style={{ textAlign: "right" }}>Valor</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const p = produtoMap.get(r.produto_id);
                return (
                  <tr key={`${r.produto_id}-${r.empresa_id}-${r.tipo}-${i}`}>
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
                    <td>{empresaMap.get(r.empresa_id) ?? "—"}</td>
                    <td>
                      <span
                        className={
                          r.tipo === "E" ? "wms-td-ok" : "wms-td-danger"
                        }
                      >
                        {r.tipo === "E" ? "Entrada" : "Saída"}
                      </span>
                    </td>
                    <td className="wms-td-strong" style={{ textAlign: "right" }}>
                      {r.qty_total.toLocaleString("pt-BR")}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {BRL.format(r.valor_total)}
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
