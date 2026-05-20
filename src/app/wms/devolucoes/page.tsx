"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Icon,
  PageHeader,
  StatusBadge,
  fmtRelative,
} from "@/components/wms/ui/wms-ui";

interface DevRow {
  id: string;
  nota_fiscal_id: number | null;
  /** Vendedora da NF original (referência, não dona física — 3D). */
  empresa_referencia?: { nome?: string } | null;
  criado_em: string;
  status?: string;
}

export default function DevolucoesPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["wms-devolucoes"],
    queryFn: () => wmsApi<{ rows: DevRow[] }>("/api/wms/devolucoes"),
  });

  const rows = data?.rows ?? [];

  return (
    <>
      <PageHeader
        title="Devoluções"
        subtitle="Classificação A/B/C/D antes de aplicar ao ledger"
      />

      {isLoading && (
        <div className="wms-loading-pane">Carregando devoluções…</div>
      )}
      {isError && (
        <div className="wms-empty-block">
          <h3>Erro</h3>
          <p>{(error as Error).message}</p>
        </div>
      )}
      {!isLoading && !isError && rows.length === 0 && (
        <div className="wms-empty-block">
          <h3>Nenhuma devolução pendente</h3>
          <p>
            Quando uma NF de devolução chegar, ela aparece aqui para
            classificação A (íntegro), B (avariado), C (garantia) ou D (troca
            de SKU).
          </p>
        </div>
      )}
      {!isLoading && rows.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th>Nota fiscal</th>
                <th>Empresa referência</th>
                <th>Recebida</th>
                <th>Status</th>
                <th style={{ width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="wms-tr-clickable">
                  <td>
                    <Link
                      href={`/wms/devolucoes/${d.id}`}
                      className="wms-link-row wms-mono"
                    >
                      NF {d.nota_fiscal_id ?? "—"}
                    </Link>
                  </td>
                  <td className="wms-td-mute">{d.empresa_referencia?.nome ?? "—"}</td>
                  <td className="wms-td-mute">
                    {fmtRelative(d.criado_em)}
                  </td>
                  <td>
                    <StatusBadge
                      status={d.status ?? "aguardando_classificacao"}
                    />
                  </td>
                  <td className="wms-td-actions">
                    <Link href={`/wms/devolucoes/${d.id}`} className="wms-btn-icon">
                      <Icon name="chevron-r" size={11} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
