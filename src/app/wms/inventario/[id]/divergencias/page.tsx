"use client";
import { use } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Icon,
  PageHeader,
  StatusBadge,
  fmtBRL,
  fmtNum,
} from "@/components/wms/ui/wms-ui";

interface DivergenciaRow {
  id: string;
  produto?: { sku: string; descricao?: string };
  localizacao?: { codigo?: string };
  saldo_sistema: number;
  qty_contada_final: number;
  delta: number;
  delta_pct: number | null;
  valor_financeiro: number | null;
  status: string;
}

export default function DivergenciasPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["wms-inv-div", id],
    queryFn: () =>
      wmsApi<{ rows: DivergenciaRow[] }>(
        `/api/wms/inventario/${id}/divergencias`,
      ),
  });

  const resolver = useMutation({
    mutationFn: ({
      divergencia_id,
      acao,
    }: {
      divergencia_id: string;
      acao: "aprovar" | "rejeitar";
    }) =>
      wmsApi<{ ok: true }>(`/api/wms/inventario/${id}/divergencias`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ divergencia_id, acao }),
      }),
    onSuccess: () => {
      toast.success("Divergência atualizada");
      queryClient.invalidateQueries({ queryKey: ["wms-inv-div", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = data?.rows ?? [];
  const pendentes = rows.filter((r) => r.status === "pendente").length;
  const aprovadas = rows.filter((r) => r.status === "aprovada").length;
  const rejeitadas = rows.filter((r) => r.status === "rejeitada").length;
  const valorTotal = rows.reduce(
    (s, r) => s + Math.abs(Number(r.valor_financeiro ?? 0)),
    0,
  );

  return (
    <>
      <PageHeader
        title="Divergências"
        subtitle={`Sessão ${id.slice(0, 8)} · ${rows.length} divergência(s)`}
        backHref={`/wms/inventario/${id}`}
        backLabel="Voltar à sessão"
      />

      {rows.length > 0 && (
        <div className="wms-kpis" style={{ marginBottom: 16 }}>
          <div className="wms-kpi">
            <div className="wms-kpi-lbl">Pendentes</div>
            <div className="wms-kpi-val">{pendentes}</div>
          </div>
          <div className="wms-kpi">
            <div className="wms-kpi-lbl">Aprovadas</div>
            <div className="wms-kpi-val">{aprovadas}</div>
          </div>
          <div className="wms-kpi">
            <div className="wms-kpi-lbl">Rejeitadas</div>
            <div className="wms-kpi-val">{rejeitadas}</div>
          </div>
          <div className="wms-kpi">
            <div className="wms-kpi-lbl">Valor financeiro</div>
            <div className="wms-kpi-val">{fmtBRL(valorTotal)}</div>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="wms-loading-pane">Carregando divergências…</div>
      )}
      {isError && (
        <div className="wms-empty-block">
          <h3>Erro</h3>
          <p>{(error as Error).message}</p>
        </div>
      )}
      {!isLoading && !isError && rows.length === 0 && (
        <div className="wms-empty-block">
          <h3>Sem divergências</h3>
          <p>Todas as contagens bateram com o saldo do sistema.</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Produto</th>
                <th>Localização</th>
                <th className="wms-tar">Esperado</th>
                <th className="wms-tar">Contado</th>
                <th className="wms-tar">Delta</th>
                <th className="wms-tar">%</th>
                <th className="wms-tar">R$</th>
                <th>Status</th>
                <th className="wms-tar">Ações</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const deltaCls =
                  d.delta > 0
                    ? "wms-td-ok"
                    : d.delta < 0
                      ? "wms-td-danger"
                      : "wms-td-mute";
                return (
                  <tr key={d.id}>
                    <td className="wms-mono">{d.produto?.sku ?? "—"}</td>
                    <td className="wms-td-desc wms-td-mute">
                      {d.produto?.descricao ?? "—"}
                    </td>
                    <td className="wms-mono wms-td-mute">
                      {d.localizacao?.codigo ?? "—"}
                    </td>
                    <td className="wms-tar wms-mono">
                      {fmtNum(d.saldo_sistema)}
                    </td>
                    <td className="wms-tar wms-mono">
                      {fmtNum(d.qty_contada_final)}
                    </td>
                    <td className={`wms-tar wms-mono ${deltaCls}`}>
                      {d.delta > 0 ? `+${d.delta}` : d.delta}
                    </td>
                    <td className="wms-tar wms-mono wms-td-mute">
                      {d.delta_pct != null ? `${d.delta_pct}%` : "—"}
                    </td>
                    <td className="wms-tar wms-mono wms-td-mute">
                      {d.valor_financeiro != null
                        ? fmtBRL(Number(d.valor_financeiro))
                        : "—"}
                    </td>
                    <td>
                      <StatusBadge status={d.status} />
                    </td>
                    <td className="wms-td-actions">
                      {d.status === "pendente" && (
                        <div
                          style={{
                            display: "flex",
                            gap: 4,
                            justifyContent: "flex-end",
                          }}
                        >
                          <button
                            type="button"
                            className="wms-btn wms-btn-sm wms-btn-ghost"
                            disabled={resolver.isPending}
                            title="Aprovar"
                            onClick={() =>
                              resolver.mutate({
                                divergencia_id: d.id,
                                acao: "aprovar",
                              })
                            }
                          >
                            <Icon name="check" size={11} />
                          </button>
                          <button
                            type="button"
                            className="wms-btn wms-btn-sm wms-btn-ghost"
                            disabled={resolver.isPending}
                            title="Rejeitar"
                            onClick={() =>
                              resolver.mutate({
                                divergencia_id: d.id,
                                acao: "rejeitar",
                              })
                            }
                          >
                            <Icon name="x" size={11} />
                          </button>
                        </div>
                      )}
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
