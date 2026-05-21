"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { usePermissoes } from "@/lib/auth-context";
import { useWmsModals } from "@/components/wms/wms-shell";
import {
  Card,
  Icon,
  PageHeader,
  StatusBadge,
  fmtDateTime,
  fmtNum,
} from "@/components/wms/ui/wms-ui";

interface MovHistorico {
  id: string;
  tipo: "S" | "E" | "R" | "L";
  quantidade: number;
  origem_id: string | null;
  criado_em: string;
  produto?: { sku: string; descricao: string };
  galpao?: { nome: string };
  localizacao?: { codigo: string };
}

interface ParRealocacao {
  origem_id: string;
  criado_em: string;
  qty: number;
  produto: { sku: string; descricao: string };
  galpao: string;
  locOrigem: string;
  locDestino: string;
}

function agruparPares(movs: MovHistorico[]): ParRealocacao[] {
  const groups = new Map<string, { s?: MovHistorico; e?: MovHistorico }>();
  for (const m of movs) {
    if (!m.origem_id) continue;
    const g = groups.get(m.origem_id) ?? {};
    if (m.tipo === "S") g.s = m;
    else if (m.tipo === "E") g.e = m;
    groups.set(m.origem_id, g);
  }
  const pares: ParRealocacao[] = [];
  for (const [origem_id, g] of groups) {
    if (!g.s || !g.e) continue;
    pares.push({
      origem_id,
      criado_em: g.s.criado_em,
      qty: Number(g.s.quantidade),
      produto: {
        sku: g.s.produto?.sku ?? "—",
        descricao: g.s.produto?.descricao ?? "",
      },
      galpao: g.s.galpao?.nome ?? "—",
      locOrigem: g.s.localizacao?.codigo ?? "—",
      locDestino: g.e.localizacao?.codigo ?? "—",
    });
  }
  return pares.sort(
    (a, b) =>
      new Date(b.criado_em).getTime() - new Date(a.criado_em).getTime(),
  );
}

export default function RealocarPage() {
  const modals = useWmsModals();
  const { can } = usePermissoes();

  const histQuery = useQuery({
    queryKey: [
      "wms-ledger",
      { origem_tipo: "transferencia_localizacao", limit: 50 },
    ],
    queryFn: () =>
      wmsApi<{ rows: MovHistorico[] }>(
        `/api/wms/ledger?origem_tipo=transferencia_localizacao&limit=50`,
      ),
    staleTime: 30 * 1000,
  });

  const pares = useMemo(
    () => agruparPares(histQuery.data?.rows ?? []),
    [histQuery.data],
  );

  return (
    <>
      <PageHeader
        title="Realocar intra-galpão"
        subtitle="Mover entre localizações no mesmo galpão (overstock → picking)"
      >
        {can("operacoes.replenishment") && (
          <button
            className="wms-btn wms-btn-primary"
            onClick={() => modals.open("realocar")}
          >
            <Icon name="plus" size={12} />
            Nova realocação
          </button>
        )}
      </PageHeader>

      <Card title="Sugestões automáticas">
        <div className="wms-exp-empty" style={{ padding: 24, textAlign: "center" }}>
          Nenhuma sugestão automática no momento. Quando a heurística de
          picking/overstock estiver populada, sugestões aparecem aqui prontas
          pra executar.
        </div>
      </Card>

      <h3 className="wms-sec-h" style={{ marginTop: 20 }}>
        Histórico recente
      </h3>
      <div className="wms-tbl">
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>Produto</th>
              <th>Galpão</th>
              <th>Origem</th>
              <th></th>
              <th>Destino</th>
              <th className="wms-tar">Qty</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {histQuery.isLoading && (
              <tr>
                <td colSpan={8} className="wms-td-empty">
                  Carregando histórico…
                </td>
              </tr>
            )}
            {!histQuery.isLoading && pares.length === 0 && (
              <tr>
                <td colSpan={8} className="wms-td-empty">
                  Sem realocações registradas.
                </td>
              </tr>
            )}
            {pares.map((p) => (
              <tr key={p.origem_id}>
                <td className="wms-td-mute">{fmtDateTime(p.criado_em)}</td>
                <td>
                  <span className="wms-mono">{p.produto.sku}</span>{" "}
                  <span className="wms-td-mute">{p.produto.descricao}</span>
                </td>
                <td>{p.galpao}</td>
                <td>
                  <span className="wms-mono">{p.locOrigem}</span>
                </td>
                <td>
                  <Icon name="arrow-right" size={12} />
                </td>
                <td>
                  <span className="wms-mono">{p.locDestino}</span>
                </td>
                <td className="wms-tar wms-mono">{fmtNum(p.qty)}</td>
                <td>
                  <StatusBadge status="aplicada" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
