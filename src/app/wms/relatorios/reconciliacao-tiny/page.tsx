"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";

interface Divergencia {
  empresa_id: string;
  empresa_nome: string;
  produto_id: string;
  sku: string;
  tiny_produto_id: number;
  saldo_wms: number;
  saldo_tiny: number;
  delta: number;
}

interface Resultado {
  divergencias: Divergencia[];
  total_produtos_comparados: number;
  total_falhas_tiny: number;
  computado_em: string;
}

export default function ReconciliacaoTinyPage() {
  const { can } = usePermissoes();
  const [limit, setLimit] = useState(50);
  const [threshold, setThreshold] = useState(1);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Resultado | null>(null);

  const podeVer = can("insights.ver");

  async function rodar() {
    setRunning(true);
    try {
      const r = await sisoFetch(
        `/api/wms/reconciliacao-tiny?limit=${limit}&threshold=${threshold}`,
      );
      if (!r.ok) throw new Error(`erro ${r.status}`);
      setResult((await r.json()) as Resultado);
    } finally {
      setRunning(false);
    }
  }

  if (!podeVer) {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ color: "var(--wms-c-mute)" }}>Sem permissão pra ver relatórios.</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 16 }}>
        Reconciliação Tiny ↔ ledger WMS
      </h1>

      <p style={{ color: "var(--wms-c-mute)", fontSize: 13, marginBottom: 16 }}>
        Compara saldo agregado WMS por (produto × empresa, somando galpões) com
        Tiny. Roda 1 call Tiny por produto mapeado — comece com limit baixo.
        Cron diário 6am UTC roda automaticamente.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "end", marginBottom: 16 }}>
        <label style={{ fontSize: 13 }}>
          Limit (produtos/empresa)
          <input
            type="number"
            min={10}
            max={500}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="wms-input"
            style={{ display: "block", width: 100, marginTop: 4 }}
          />
        </label>
        <label style={{ fontSize: 13 }}>
          Threshold (delta mínimo)
          <input
            type="number"
            min={0}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="wms-input"
            style={{ display: "block", width: 100, marginTop: 4 }}
          />
        </label>
        <button
          type="button"
          onClick={rodar}
          disabled={running}
          className="wms-btn wms-btn-primary"
        >
          {running ? "Rodando…" : "Forçar reconciliação"}
        </button>
      </div>

      {result ? (
        <div>
          <div
            style={{
              padding: 12,
              background: "var(--wms-c-soft)",
              borderRadius: 6,
              marginBottom: 16,
              fontSize: 13,
            }}
          >
            <strong>{result.divergencias.length}</strong> divergências em{" "}
            <strong>{result.total_produtos_comparados}</strong> produtos comparados
            {result.total_falhas_tiny > 0 ? (
              <span style={{ color: "var(--wms-c-warn, #b45309)", marginLeft: 8 }}>
                ({result.total_falhas_tiny} falhas Tiny)
              </span>
            ) : null}
            <span style={{ color: "var(--wms-c-mute)", marginLeft: 12 }}>
              · {new Date(result.computado_em).toLocaleString("pt-BR")}
            </span>
          </div>

          {result.divergencias.length === 0 ? (
            <p style={{ color: "var(--wms-c-mute)" }}>
              Nenhuma divergência — Tiny e ledger WMS alinhados ✓
            </p>
          ) : (
            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--wms-c-border)" }}>
                  <th style={{ textAlign: "left", padding: 8 }}>Empresa</th>
                  <th style={{ textAlign: "left", padding: 8 }}>SKU</th>
                  <th style={{ textAlign: "right", padding: 8 }}>WMS</th>
                  <th style={{ textAlign: "right", padding: 8 }}>Tiny</th>
                  <th style={{ textAlign: "right", padding: 8 }}>Delta</th>
                </tr>
              </thead>
              <tbody>
                {result.divergencias.map((d) => (
                  <tr
                    key={`${d.empresa_id}::${d.produto_id}`}
                    style={{ borderBottom: "1px solid var(--wms-c-border-light)" }}
                  >
                    <td style={{ padding: 8 }}>{d.empresa_nome}</td>
                    <td style={{ padding: 8, fontFamily: "var(--font-mono)" }}>
                      {d.sku}
                    </td>
                    <td style={{ padding: 8, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                      {d.saldo_wms}
                    </td>
                    <td style={{ padding: 8, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                      {d.saldo_tiny}
                    </td>
                    <td
                      style={{
                        padding: 8,
                        textAlign: "right",
                        fontFamily: "var(--font-mono)",
                        color: d.delta > 0 ? "var(--wms-c-success, #15803d)" : "var(--wms-c-danger, #b91c1c)",
                        fontWeight: 600,
                      }}
                    >
                      {d.delta > 0 ? "+" : ""}
                      {d.delta}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </div>
  );
}
