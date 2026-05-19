"use client";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Icon,
  Modal,
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

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const pendentesRows = useMemo(
    () => rows.filter((r) => r.status === "pendente"),
    [rows],
  );
  const pendentes = pendentesRows.length;
  const aprovadas = rows.filter((r) => r.status === "aprovada").length;
  const rejeitadas = rows.filter((r) => r.status === "rejeitada").length;
  const valorTotal = rows.reduce(
    (s, r) => s + Math.abs(Number(r.valor_financeiro ?? 0)),
    0,
  );

  const [rawSelectedIds, setRawSelectedIds] = useState<Set<string>>(
    new Set(),
  );
  const [confirmAcao, setConfirmAcao] = useState<
    "aprovar" | "rejeitar" | null
  >(null);
  const lastCheckedIdxRef = useRef<number | null>(null);
  const headerCbRef = useRef<HTMLInputElement | null>(null);

  // Derivação: descarta IDs que já não estão pendentes (outro supervisor
  // resolveu, query invalidou, etc.). rawSelectedIds é só o que o usuário
  // clicou — selectedIds é o que vale.
  const pendenteIdSet = useMemo(
    () => new Set(pendentesRows.map((r) => r.id)),
    [pendentesRows],
  );
  const selectedIds = useMemo(() => {
    const s = new Set<string>();
    for (const id of rawSelectedIds) if (pendenteIdSet.has(id)) s.add(id);
    return s;
  }, [rawSelectedIds, pendenteIdSet]);

  // Indeterminate no header checkbox
  useEffect(() => {
    if (!headerCbRef.current) return;
    headerCbRef.current.indeterminate =
      selectedIds.size > 0 && selectedIds.size < pendentes;
  }, [selectedIds, pendentes]);

  const allPendentesSelecionadas =
    pendentes > 0 && selectedIds.size === pendentes;

  const toggleAll = () => {
    if (allPendentesSelecionadas) {
      setRawSelectedIds(new Set());
    } else {
      setRawSelectedIds(new Set(pendentesRows.map((r) => r.id)));
    }
    lastCheckedIdxRef.current = null;
  };

  const toggleOne = (rowId: string, idx: number, shift: boolean) => {
    setRawSelectedIds((prev) => {
      const next = new Set(prev);
      // Shift+click — range select entre lastCheckedIdx e idx,
      // restrito a linhas pendentes.
      if (shift && lastCheckedIdxRef.current !== null) {
        const [a, b] = [lastCheckedIdxRef.current, idx].sort(
          (x, y) => x - y,
        );
        const targetChecked = !prev.has(rowId);
        for (let i = a; i <= b; i++) {
          const r = rows[i];
          if (!r || r.status !== "pendente") continue;
          if (targetChecked) next.add(r.id);
          else next.delete(r.id);
        }
      } else if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
    lastCheckedIdxRef.current = idx;
  };

  const clearSelection = () => {
    setRawSelectedIds(new Set());
    lastCheckedIdxRef.current = null;
  };

  const valorImpactoSelecionado = useMemo(
    () =>
      rows
        .filter((r) => selectedIds.has(r.id))
        .reduce(
          (s, r) => s + Math.abs(Number(r.valor_financeiro ?? 0)),
          0,
        ),
    [rows, selectedIds],
  );

  const bulkAction = useMutation({
    mutationFn: ({
      ids,
      acao,
    }: {
      ids: string[];
      acao: "aprovar" | "rejeitar";
    }) =>
      wmsApi<{ ok: true; atualizadas: number }>(
        `/api/wms/inventario/${id}/divergencias`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ divergencia_ids: ids, acao }),
        },
      ),
    onSuccess: (res, vars) => {
      const total = vars.ids.length;
      const atualizadas = res.atualizadas;
      if (atualizadas === total) {
        toast.success(`${atualizadas} divergência(s) atualizada(s)`);
      } else {
        toast.success(
          `${atualizadas} de ${total} atualizada(s) — as demais já não estavam pendentes`,
        );
      }
      clearSelection();
      setConfirmAcao(null);
      queryClient.invalidateQueries({ queryKey: ["wms-inv-div", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

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

      {/* Selection bar inline — padrão de /wms/separacao */}
      {selectedIds.size > 0 && (
        <div
          style={{
            marginTop: 10,
            marginBottom: 10,
            padding: "8px 12px",
            background: "var(--wms-c-info-bg)",
            border: "1px solid var(--wms-c-info-bd)",
            borderRadius: "var(--wms-r-2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
            fontSize: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              color: "var(--wms-c-info)",
              fontWeight: 500,
            }}
          >
            <strong>{selectedIds.size}</strong> selecionada(s)
            <span className="wms-td-mute">
              · {fmtBRL(valorImpactoSelecionado)} impacto
            </span>
            <button
              type="button"
              className="wms-btn wms-btn-ghost wms-btn-sm"
              onClick={clearSelection}
            >
              <Icon name="x" size={11} /> Limpar
            </button>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="wms-btn wms-btn-sm wms-btn-primary"
              onClick={() => setConfirmAcao("aprovar")}
              disabled={bulkAction.isPending}
            >
              <Icon name="check" size={11} /> Aprovar {selectedIds.size}
            </button>
            <button
              type="button"
              className="wms-btn wms-btn-sm wms-btn-danger"
              onClick={() => setConfirmAcao("rejeitar")}
              disabled={bulkAction.isPending}
            >
              <Icon name="x" size={11} /> Rejeitar {selectedIds.size}
            </button>
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
                <th style={{ width: 36 }}>
                  <input
                    ref={headerCbRef}
                    type="checkbox"
                    aria-label="Selecionar todas as pendentes"
                    checked={allPendentesSelecionadas}
                    disabled={pendentes === 0}
                    onChange={toggleAll}
                  />
                </th>
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
              {rows.map((d, idx) => {
                const deltaCls =
                  d.delta > 0
                    ? "wms-td-ok"
                    : d.delta < 0
                      ? "wms-td-danger"
                      : "wms-td-mute";
                const pendente = d.status === "pendente";
                const isSel = selectedIds.has(d.id);
                return (
                  <tr key={d.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Selecionar ${d.produto?.sku ?? "linha"}`}
                        checked={isSel}
                        disabled={!pendente}
                        onChange={(e) => {
                          const native = e.nativeEvent as MouseEvent;
                          toggleOne(d.id, idx, !!native.shiftKey);
                        }}
                      />
                    </td>
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
                      {pendente && (
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
                            disabled={bulkAction.isPending}
                            title="Aprovar"
                            onClick={() =>
                              bulkAction.mutate({
                                ids: [d.id],
                                acao: "aprovar",
                              })
                            }
                          >
                            <Icon name="check" size={11} />
                          </button>
                          <button
                            type="button"
                            className="wms-btn wms-btn-sm wms-btn-ghost"
                            disabled={bulkAction.isPending}
                            title="Rejeitar"
                            onClick={() =>
                              bulkAction.mutate({
                                ids: [d.id],
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

      {confirmAcao && (
        <Modal
          title={
            confirmAcao === "aprovar"
              ? `Aprovar ${selectedIds.size} divergência(s)?`
              : `Rejeitar ${selectedIds.size} divergência(s)?`
          }
          subtitle={
            confirmAcao === "aprovar"
              ? `Impacto financeiro: ${fmtBRL(valorImpactoSelecionado)}. As divergências ficam marcadas como aprovadas — os ajustes só vão pro ledger quando você clicar em "Aplicar sessão".`
              : `As divergências ficam marcadas como rejeitadas. O saldo do sistema permanece como está.`
          }
          onClose={() => setConfirmAcao(null)}
          footer={
            <>
              <button
                type="button"
                className="wms-btn wms-btn-ghost"
                onClick={() => setConfirmAcao(null)}
                disabled={bulkAction.isPending}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={
                  confirmAcao === "aprovar"
                    ? "wms-btn wms-btn-primary"
                    : "wms-btn wms-btn-danger"
                }
                disabled={bulkAction.isPending}
                onClick={() =>
                  bulkAction.mutate({
                    ids: Array.from(selectedIds),
                    acao: confirmAcao,
                  })
                }
              >
                Confirmar
              </button>
            </>
          }
        >
          <div />
        </Modal>
      )}
    </>
  );
}
