"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { useWmsModals } from "@/components/wms/wms-shell";
import {
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
  empresa?: { nome: string };
  galpao?: { nome: string };
  localizacao?: { codigo: string };
}

interface ParTransferencia {
  origem_id: string;
  criado_em: string;
  qty: number;
  produto: { sku: string; descricao: string };
  origem: { empresa: string; galpao: string; loc: string };
  destino: { empresa: string; galpao: string; loc: string };
}

function agruparPares(movs: MovHistorico[]): ParTransferencia[] {
  // Cada transferência gera par S+E com mesmo origem_id. Aqui agrupamos
  // pra mostrar uma linha por transferência (lado S = origem, lado E = destino).
  const groups = new Map<string, { s?: MovHistorico; e?: MovHistorico }>();
  for (const m of movs) {
    if (!m.origem_id) continue;
    const g = groups.get(m.origem_id) ?? {};
    if (m.tipo === "S") g.s = m;
    else if (m.tipo === "E") g.e = m;
    groups.set(m.origem_id, g);
  }
  const pares: ParTransferencia[] = [];
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
      origem: {
        empresa: g.s.empresa?.nome ?? "—",
        galpao: g.s.galpao?.nome ?? "—",
        loc: g.s.localizacao?.codigo ?? "—",
      },
      destino: {
        empresa: g.e.empresa?.nome ?? "—",
        galpao: g.e.galpao?.nome ?? "—",
        loc: g.e.localizacao?.codigo ?? "—",
      },
    });
  }
  return pares.sort(
    (a, b) =>
      new Date(b.criado_em).getTime() - new Date(a.criado_em).getTime(),
  );
}

export default function TransferirPage() {
  const modals = useWmsModals();

  const histQuery = useQuery({
    queryKey: ["wms-ledger", { origem_tipo: "transferencia_galpao", limit: 50 }],
    queryFn: () =>
      wmsApi<{ rows: MovHistorico[] }>(
        `/api/wms/ledger?origem_tipo=transferencia_galpao&limit=50`,
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
        title="Transferências entre galpões"
        subtitle="Movimentação par S+E entre CDs/filiais"
      >
        <button
          className="wms-btn wms-btn-primary"
          onClick={() => modals.open("transferir")}
        >
          <Icon name="plus" size={12} />
          Nova transferência
        </button>
      </PageHeader>

      <div className="wms-empty-block">
        <h3>Nenhuma transferência em trânsito</h3>
        <p>
          Quando você inicia uma transferência inter-galpão, ela aparece aqui
          com status (em trânsito, recebida, divergente). Cada par é gerado
          com mesma <span className="wms-mono">origem_id</span>.
        </p>
        <button
          className="wms-btn wms-btn-primary"
          onClick={() => modals.open("transferir")}
        >
          <Icon name="plus" size={12} />
          Iniciar transferência
        </button>
      </div>

      <h3 className="wms-sec-h">Histórico recente</h3>
      <div className="wms-tbl">
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>Produto</th>
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
                <td colSpan={7} className="wms-td-empty">
                  Carregando histórico…
                </td>
              </tr>
            )}
            {!histQuery.isLoading && pares.length === 0 && (
              <tr>
                <td colSpan={7} className="wms-td-empty">
                  Sem transferências registradas.
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
                <td>
                  <span className="wms-chip-emp">
                    {p.origem.empresa.slice(0, 3).toUpperCase()}
                  </span>{" "}
                  {p.origem.galpao} /{" "}
                  <span className="wms-mono">{p.origem.loc}</span>
                </td>
                <td>
                  <Icon name="arrow-right" size={12} />
                </td>
                <td>
                  <span className="wms-chip-emp">
                    {p.destino.empresa.slice(0, 3).toUpperCase()}
                  </span>{" "}
                  {p.destino.galpao} /{" "}
                  <span className="wms-mono">{p.destino.loc}</span>
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
