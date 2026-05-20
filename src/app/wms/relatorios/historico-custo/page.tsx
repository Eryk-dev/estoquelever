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
interface FornecedorLite {
  id: string;
  nome: string;
}
interface HistRow {
  criado_em: string;
  custo_medio_anterior: number | null;
  custo_medio_posterior: number | null;
  custo_unitario: number | null;
  quantidade: number;
  origem_tipo: string;
  empresa_compradora_id: string | null;
  fornecedor_id: string | null;
}

const BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR");
}

// ────────────────────────────────────────────────────────────
// SVG line chart — sem libs externas, calculado inline.

interface ChartPoint {
  x: number; // index
  custo_medio: number;
  custo_unit: number;
  date: string;
}

function CustoChart({ points }: { points: ChartPoint[] }) {
  const W = 720;
  const H = 280;
  const PAD = { top: 16, right: 16, bottom: 32, left: 56 };

  if (points.length === 0) {
    return (
      <div
        style={{
          width: "100%",
          maxWidth: W,
          padding: 24,
          textAlign: "center",
          color: "var(--wms-c-mute)",
          fontSize: 13,
          border: "1px dashed var(--wms-c-border)",
          borderRadius: 8,
        }}
      >
        Sem dados pra exibir.
      </div>
    );
  }

  const allValues = points.flatMap((p) => [p.custo_medio, p.custo_unit]);
  const yMin = Math.min(...allValues);
  const yMax = Math.max(...allValues);
  const yRange = Math.max(yMax - yMin, 0.0001);
  const yPad = yRange * 0.08;
  const yLo = Math.max(0, yMin - yPad);
  const yHi = yMax + yPad;

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const xScale = (i: number) =>
    PAD.left +
    (points.length === 1
      ? innerW / 2
      : (i / (points.length - 1)) * innerW);
  const yScale = (v: number) =>
    PAD.top + innerH - ((v - yLo) / (yHi - yLo)) * innerH;

  // Path da linha custo_medio_posterior (linha contínua).
  const mediaPath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(p.custo_medio)}`)
    .join(" ");

  // Ticks Y — 4 referências.
  const yTicks = [yLo, yLo + (yHi - yLo) / 3, yLo + (2 * (yHi - yLo)) / 3, yHi];

  return (
    <div
      style={{
        width: "100%",
        background: "var(--wms-c-panel)",
        border: "1px solid var(--wms-c-border)",
        borderRadius: 8,
        padding: 16,
      }}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", maxWidth: W }}
      >
        {/* Eixos */}
        <line
          x1={PAD.left}
          y1={PAD.top}
          x2={PAD.left}
          y2={H - PAD.bottom}
          stroke="var(--wms-c-border)"
          strokeWidth={1}
        />
        <line
          x1={PAD.left}
          y1={H - PAD.bottom}
          x2={W - PAD.right}
          y2={H - PAD.bottom}
          stroke="var(--wms-c-border)"
          strokeWidth={1}
        />

        {/* Y ticks + grid */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              y1={yScale(v)}
              x2={W - PAD.right}
              y2={yScale(v)}
              stroke="var(--wms-c-border)"
              strokeWidth={0.5}
              strokeDasharray="2,3"
              opacity={0.5}
            />
            <text
              x={PAD.left - 6}
              y={yScale(v) + 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--wms-c-mute)"
            >
              {BRL.format(v)}
            </text>
          </g>
        ))}

        {/* Linha custo médio */}
        <path
          d={mediaPath}
          fill="none"
          stroke="var(--wms-c-fg)"
          strokeWidth={1.6}
        />

        {/* Pontos custo_unitario */}
        {points.map((p, i) => (
          <g key={i}>
            <circle
              cx={xScale(i)}
              cy={yScale(p.custo_unit)}
              r={3.2}
              fill="var(--wms-c-warn, #d97706)"
              opacity={0.85}
            >
              <title>
                {fmtDate(p.date)} · unit: {BRL.format(p.custo_unit)} · médio:{" "}
                {BRL.format(p.custo_medio)}
              </title>
            </circle>
            <circle
              cx={xScale(i)}
              cy={yScale(p.custo_medio)}
              r={2.4}
              fill="var(--wms-c-fg)"
            />
          </g>
        ))}

        {/* X label inicial e final */}
        {points.length > 0 && (
          <>
            <text
              x={xScale(0)}
              y={H - PAD.bottom + 16}
              textAnchor="middle"
              fontSize={10}
              fill="var(--wms-c-mute)"
            >
              {fmtDate(points[0].date)}
            </text>
            {points.length > 1 && (
              <text
                x={xScale(points.length - 1)}
                y={H - PAD.bottom + 16}
                textAnchor="middle"
                fontSize={10}
                fill="var(--wms-c-mute)"
              >
                {fmtDate(points[points.length - 1].date)}
              </text>
            )}
          </>
        )}
      </svg>
      <div
        style={{
          display: "flex",
          gap: 16,
          marginTop: 8,
          fontSize: 11,
          color: "var(--wms-c-mute)",
        }}
      >
        <span>
          <span
            style={{
              display: "inline-block",
              width: 12,
              height: 2,
              background: "var(--wms-c-fg)",
              verticalAlign: "middle",
              marginRight: 4,
            }}
          />
          Custo médio (linha)
        </span>
        <span>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--wms-c-warn, #d97706)",
              verticalAlign: "middle",
              marginRight: 4,
            }}
          />
          Custo unitário da mov (pontos)
        </span>
      </div>
    </div>
  );
}

export default function HistoricoCustoPage() {
  const [produtoQ, setProdutoQ] = useState("");
  const [produtoId, setProdutoId] = useState<string>("");
  const [produtoLabel, setProdutoLabel] = useState<string>("");

  const empresasQuery = useQuery({
    queryKey: ["wms-empresas-lite"],
    queryFn: () => wmsApi<EmpresaLite[]>(`/api/wms/admin/empresas`),
  });
  const fornecedoresQuery = useQuery({
    queryKey: ["wms-fornecedores-lite"],
    queryFn: () =>
      wmsApi<{ rows: FornecedorLite[] }>(`/api/wms/fornecedores`),
  });
  const empresas = empresasQuery.data ?? [];
  const fornecedores = fornecedoresQuery.data?.rows ?? [];

  const empresaMap = useMemo(
    () => new Map(empresas.map((e) => [e.id, e.nome])),
    [empresas],
  );
  const fornecedorMap = useMemo(
    () => new Map(fornecedores.map((f) => [f.id, f.nome])),
    [fornecedores],
  );

  const produtosQuery = useQuery({
    queryKey: ["wms-produtos-search", produtoQ],
    queryFn: () =>
      wmsApi<{ rows: Produto[] }>(
        `/api/wms/produtos?limit=10&q=${encodeURIComponent(produtoQ)}`,
      ),
    enabled: produtoQ.length >= 2 && !produtoId,
  });

  const histQuery = useQuery({
    queryKey: ["wms-relatorio-historico-custo", produtoId],
    queryFn: () =>
      wmsApi<{ custo_medio_atual: number | null; items: HistRow[] }>(
        `/api/wms/relatorios/historico-custo?produto_id=${produtoId}`,
      ),
    enabled: !!produtoId,
  });

  const items = histQuery.data?.items ?? [];
  const custoAtual = histQuery.data?.custo_medio_atual;

  const chartPoints: ChartPoint[] = useMemo(
    () =>
      items
        .filter((r) => r.custo_unitario != null && r.custo_medio_posterior != null)
        .map((r, i) => ({
          x: i,
          custo_unit: Number(r.custo_unitario),
          custo_medio: Number(r.custo_medio_posterior),
          date: r.criado_em,
        })),
    [items],
  );

  return (
    <>
      <PageHeader
        title="Histórico de Custo"
        subtitle={
          produtoId
            ? `${produtoLabel} · ${items.length} eventos${custoAtual != null ? ` · atual ${BRL.format(Number(custoAtual))}` : ""}`
            : "Selecione um produto pra visualizar o histórico"
        }
      />

      <div className="wms-toolbar" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="wms-search-wrap" style={{ minWidth: 320 }}>
          <Icon name="search" size={13} />
          <input
            value={produtoQ}
            onChange={(e) => {
              setProdutoQ(e.target.value);
              if (!e.target.value) {
                setProdutoId("");
                setProdutoLabel("");
              }
            }}
            placeholder="Buscar produto por SKU ou nome…"
          />
          {(produtoQ || produtoId) && (
            <button
              className="wms-search-clear"
              onClick={() => {
                setProdutoQ("");
                setProdutoId("");
                setProdutoLabel("");
              }}
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
      </div>

      {produtoQ.length >= 2 &&
        !produtoId &&
        (produtosQuery.data?.rows ?? []).length > 0 && (
          <div
            className="wms-card"
            style={{
              padding: 6,
              maxHeight: 260,
              overflowY: "auto",
              marginTop: 4,
              maxWidth: 560,
            }}
          >
            {(produtosQuery.data?.rows ?? []).map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setProdutoId(p.id);
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

      {!produtoId && (
        <div className="wms-empty-block" style={{ marginTop: 24 }}>
          <h3>Selecione um produto</h3>
          <p>Use a busca acima pra escolher um produto e ver o histórico.</p>
        </div>
      )}

      {produtoId && histQuery.isLoading && (
        <div className="wms-loading-pane">Carregando histórico…</div>
      )}
      {produtoId && histQuery.isError && (
        <div className="wms-empty-block">
          <h3>Erro</h3>
          <p>{(histQuery.error as Error).message}</p>
        </div>
      )}
      {produtoId && !histQuery.isLoading && items.length === 0 && (
        <div className="wms-empty-block">
          <h3>Sem histórico</h3>
          <p>Esse produto não tem movs com custo unitário registrado.</p>
        </div>
      )}

      {produtoId && items.length > 0 && (
        <>
          <div style={{ marginTop: 16, marginBottom: 16 }}>
            <CustoChart points={chartPoints} />
          </div>

          <div className="wms-tbl">
            <table>
              <thead>
                <tr>
                  <th>Data</th>
                  <th style={{ textAlign: "right" }}>Qty</th>
                  <th style={{ textAlign: "right" }}>Custo unit.</th>
                  <th style={{ textAlign: "right" }}>Médio antes</th>
                  <th style={{ textAlign: "right" }}>Médio depois</th>
                  <th>Origem</th>
                  <th>Empresa compradora</th>
                  <th>Fornecedor</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r, i) => (
                  <tr key={i}>
                    <td className="wms-mono">{fmtDate(r.criado_em)}</td>
                    <td style={{ textAlign: "right" }}>
                      {r.quantidade.toLocaleString("pt-BR")}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {r.custo_unitario != null
                        ? BRL.format(Number(r.custo_unitario))
                        : "—"}
                    </td>
                    <td className="wms-td-mute" style={{ textAlign: "right" }}>
                      {r.custo_medio_anterior != null
                        ? BRL.format(Number(r.custo_medio_anterior))
                        : "—"}
                    </td>
                    <td className="wms-td-strong" style={{ textAlign: "right" }}>
                      {r.custo_medio_posterior != null
                        ? BRL.format(Number(r.custo_medio_posterior))
                        : "—"}
                    </td>
                    <td className="wms-td-mute">{r.origem_tipo}</td>
                    <td>
                      {r.empresa_compradora_id
                        ? (empresaMap.get(r.empresa_compradora_id) ?? "—")
                        : "—"}
                    </td>
                    <td>
                      {r.fornecedor_id
                        ? (fornecedorMap.get(r.fornecedor_id) ?? "—")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
