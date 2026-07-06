"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import {
  PageHeader,
  fmtBRL,
  fmtDateTime,
  fmtNum,
} from "@/components/wms/ui/wms-ui";
import { useGalpoes } from "@/components/wms/ui/modals";

/**
 * Histórico de recebimentos avulsos — lotes registrados via
 * /wms/receber/avulso, agrupados por lote (1 card por confirmação).
 */

const ORIGEM_LABEL: Record<string, string> = {
  nf_compra: "NF de compra",
  ajuste_manual: "Compra manual",
  devolucao_cliente_integra: "Devolução",
  lancamento_retroativo: "Retroativo",
};

interface LoteItem {
  mov_id: string;
  sku: string | null;
  descricao: string | null;
  qty: number;
  custo_unitario: number | null;
  localizacao: string | null;
  estornado: boolean;
}

interface Lote {
  lote_id: string;
  criado_em: string;
  origem_tipo: string;
  entrada_direta: boolean;
  nf_referencia: string | null;
  data_recebimento: string | null;
  motivo: string | null;
  galpao: string | null;
  fornecedor: string | null;
  compradora: string | null;
  usuario: string | null;
  itens: LoteItem[];
  total_qty: number;
  total_valor: number;
}

export default function HistoricoRecebimentosPage() {
  const { data: galpoes } = useGalpoes();
  const [galpaoId, setGalpaoId] = useState<string>("");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["wms-receber-historico", galpaoId],
    queryFn: () =>
      wmsApi<{ lotes: Lote[]; limite_atingido: boolean }>(
        `/api/wms/receber/historico${galpaoId ? `?galpao_id=${galpaoId}` : ""}`,
      ),
  });

  const lotes = data?.lotes ?? [];

  return (
    <>
      <PageHeader
        title="Histórico de recebimentos avulsos"
        subtitle="Lotes registrados em /wms/receber/avulso — mais recentes primeiro"
        backHref="/wms/receber/avulso"
        backLabel="Recebimento avulso"
      >
        <select
          className="wms-select"
          value={galpaoId}
          onChange={(e) => setGalpaoId(e.target.value)}
        >
          <option value="">Todos os galpões</option>
          {(galpoes ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.nome}
            </option>
          ))}
        </select>
      </PageHeader>

      {isLoading && (
        <div className="wms-loading-pane">Carregando histórico…</div>
      )}
      {isError && (
        <div className="wms-empty-block">
          <h3>Erro</h3>
          <p>{(error as Error).message}</p>
        </div>
      )}
      {!isLoading && !isError && lotes.length === 0 && (
        <div className="wms-empty-block">
          <h3>Nenhum recebimento avulso</h3>
          <p>
            Lotes confirmados em /wms/receber/avulso aparecem aqui assim que
            registrados.
          </p>
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          maxWidth: 980,
        }}
      >
        {lotes.map((l) => (
          <div key={l.lote_id} className="wms-card">
            <div
              className="wms-card-h"
              style={{ flexWrap: "wrap", gap: 8, rowGap: 4 }}
            >
              <h3>{fmtDateTime(l.criado_em)}</h3>
              <span className="wms-badge wms-badge-info">
                {ORIGEM_LABEL[l.origem_tipo] ?? l.origem_tipo}
              </span>
              {l.entrada_direta && (
                <span className="wms-badge wms-badge-mute">
                  entrada direta
                </span>
              )}
              <span
                className="wms-td-mute"
                style={{ fontSize: 12, marginLeft: "auto" }}
              >
                {l.galpao ?? "—"}
                {l.usuario ? ` · por ${l.usuario}` : ""}
              </span>
            </div>
            <div className="wms-card-body">
              <div
                className="wms-td-mute"
                style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.6 }}
              >
                {l.fornecedor && (
                  <span style={{ marginRight: 12 }}>
                    <span style={{ opacity: 0.7 }}>fornecedor:</span>{" "}
                    {l.fornecedor}
                  </span>
                )}
                {l.compradora && (
                  <span style={{ marginRight: 12 }}>
                    <span style={{ opacity: 0.7 }}>compradora:</span>{" "}
                    {l.compradora}
                  </span>
                )}
                {l.nf_referencia && (
                  <span style={{ marginRight: 12 }}>
                    <span style={{ opacity: 0.7 }}>NF:</span>{" "}
                    <span className="wms-mono">{l.nf_referencia}</span>
                  </span>
                )}
                {l.motivo && (
                  <span>
                    <span style={{ opacity: 0.7 }}>motivo:</span> {l.motivo}
                  </span>
                )}
              </div>
              <div className="wms-tbl">
                <table>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Produto</th>
                      <th className="wms-tar">Qty</th>
                      <th className="wms-tar">Custo un.</th>
                      <th className="wms-tar">Subtotal</th>
                      <th>Loc de entrada</th>
                    </tr>
                  </thead>
                  <tbody>
                    {l.itens.map((it) => (
                      <tr
                        key={it.mov_id}
                        style={it.estornado ? { opacity: 0.5 } : undefined}
                      >
                        <td className="wms-mono">{it.sku ?? "—"}</td>
                        <td className="wms-td-desc">
                          {it.descricao ?? "—"}
                          {it.estornado && (
                            <span
                              className="wms-badge wms-badge-danger"
                              style={{ marginLeft: 8 }}
                            >
                              estornado
                            </span>
                          )}
                        </td>
                        <td className="wms-tar wms-mono">{fmtNum(it.qty)}</td>
                        <td className="wms-tar wms-mono wms-td-mute">
                          {it.custo_unitario != null
                            ? fmtBRL(it.custo_unitario)
                            : "—"}
                        </td>
                        <td className="wms-tar wms-mono">
                          {it.custo_unitario != null
                            ? fmtBRL(it.qty * it.custo_unitario)
                            : "—"}
                        </td>
                        <td className="wms-mono wms-td-mute">
                          {it.localizacao ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2} className="wms-td-mute">
                        Total do lote
                      </td>
                      <td className="wms-tar wms-mono">
                        {fmtNum(l.total_qty)}
                      </td>
                      <td />
                      <td className="wms-tar wms-mono">
                        {fmtBRL(l.total_valor)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>
        ))}
      </div>

      {data?.limite_atingido && (
        <p
          className="wms-td-mute"
          style={{ fontSize: 12, marginTop: 12 }}
        >
          Mostrando os lotes mais recentes — histórico mais antigo existe além
          desta janela.
        </p>
      )}
    </>
  );
}
