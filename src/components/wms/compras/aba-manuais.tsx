"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { fmtDateTime, fmtNum } from "@/components/wms/ui/wms-ui";

interface CompraItem {
  id: string;
  sku: string;
  descricao: string;
  qty_comprada: number;
  qty_recebida: number;
  custo_unitario: number | null;
}
interface Compra {
  id: string;
  status: string;
  observacao: string | null;
  criado_em: string;
  fornecedor: { id: string; nome: string } | null;
  empresa: { id: string; nome: string } | null;
  itens: CompraItem[];
}

type Filtro = "pendentes" | "recebido" | "cancelado";

export function AbaManuais() {
  const qc = useQueryClient();
  const [filtro, setFiltro] = useState<Filtro>("pendentes");
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["compras-manuais", filtro],
    queryFn: () =>
      wmsApi<{ rows: Compra[] }>(`/api/wms/compras-manuais?status=${filtro}`),
  });

  const [recebendo, setRecebendo] = useState<Record<string, string>>({}); // item_id → qty
  const [custos, setCustos] = useState<Record<string, string>>({}); // item_id → custo

  const receberMut = useMutation({
    mutationFn: async (compra: Compra) => {
      const itens = compra.itens
        .map((it) => {
          const qty = Number(recebendo[it.id] ?? 0);
          const custoRaw = custos[it.id];
          return {
            item_id: it.id,
            qty_recebida: qty,
            ...(custoRaw ? { custo_unitario: Number(custoRaw) } : {}),
          };
        })
        .filter((x) => x.qty_recebida > 0);
      if (itens.length === 0)
        throw new Error("informe a qty recebida em ao menos 1 item");
      const r = await sisoFetch(`/api/wms/compras-manuais/${compra.id}/receber`, {
        method: "POST",
        body: JSON.stringify({ itens }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "falha ao receber");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success("Recebimento registrado");
      setRecebendo({});
      setCustos({});
      qc.invalidateQueries({ queryKey: ["compras-manuais"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const cancelarMut = useMutation({
    mutationFn: async (compraId: string) => {
      const r = await sisoFetch(`/api/wms/compras-manuais/${compraId}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "falha ao cancelar");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success("Compra cancelada");
      qc.invalidateQueries({ queryKey: ["compras-manuais"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const compras = data?.rows ?? [];

  return (
    <div>
      <div className="wms-vtab" style={{ marginBottom: 12 }}>
        {(["pendentes", "recebido", "cancelado"] as const).map((f) => (
          <button
            key={f}
            className={`wms-vtab-btn ${filtro === f ? "is-active" : ""}`}
            onClick={() => setFiltro(f)}
          >
            {f}
          </button>
        ))}
      </div>

      {isLoading && <div className="wms-loading-pane">carregando…</div>}
      {!isLoading && isError && (
        <div className="wms-empty-block">
          <h3>Falha ao carregar compras manuais</h3>
          <p>{error instanceof Error ? error.message : String(error)}</p>
        </div>
      )}
      {!isLoading && !isError && compras.length === 0 && (
        <div className="wms-empty-block">
          <h3>Nenhuma compra manual</h3>
          <p>Compras avulsas de fornecedor aparecem aqui.</p>
        </div>
      )}

      {compras.map((c) => (
        <div
          key={c.id}
          className="wms-card"
          style={{ marginBottom: 10, padding: 14 }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div>
              <strong>{c.fornecedor?.nome ?? "—"}</strong>{" "}
              <span className="wms-td-mute">· {c.empresa?.nome ?? "—"}</span>{" "}
              <span className="wms-badge">{c.status}</span>
            </div>
            <span className="wms-td-mute" style={{ fontSize: 12 }}>
              {fmtDateTime(c.criado_em)}
            </span>
          </div>

          <div className="wms-tbl wms-tbl-compact" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th className="wms-tar">Comprado</th>
                  <th className="wms-tar">Recebido</th>
                  <th className="wms-tar">Receber</th>
                  <th className="wms-tar">Custo</th>
                </tr>
              </thead>
              <tbody>
                {c.itens.map((it) => {
                  const faltante = it.qty_comprada - it.qty_recebida;
                  return (
                    <tr key={it.id}>
                      <td className="wms-mono">{it.sku}</td>
                      <td className="wms-tar wms-mono">
                        {fmtNum(it.qty_comprada)}
                      </td>
                      <td className="wms-tar wms-mono">
                        {fmtNum(it.qty_recebida)}
                      </td>
                      <td className="wms-tar">
                        {c.status !== "recebido" &&
                        c.status !== "cancelado" &&
                        faltante > 0 ? (
                          <input
                            className="wms-input wms-mono wms-tar"
                            style={{ width: 64 }}
                            inputMode="numeric"
                            min={0}
                            max={faltante}
                            placeholder={`máx ${faltante}`}
                            value={recebendo[it.id] ?? ""}
                            onChange={(e) =>
                              setRecebendo((prev) => ({
                                ...prev,
                                [it.id]: e.target.value,
                              }))
                            }
                          />
                        ) : (
                          <span className="wms-td-mute">—</span>
                        )}
                      </td>
                      <td className="wms-tar">
                        {c.status !== "recebido" &&
                        c.status !== "cancelado" &&
                        faltante > 0 ? (
                          <input
                            className="wms-input wms-mono wms-tar"
                            style={{ width: 72 }}
                            inputMode="decimal"
                            placeholder={
                              it.custo_unitario != null
                                ? String(it.custo_unitario)
                                : "custo"
                            }
                            value={custos[it.id] ?? ""}
                            onChange={(e) =>
                              setCustos((prev) => ({
                                ...prev,
                                [it.id]: e.target.value,
                              }))
                            }
                          />
                        ) : (
                          <span className="wms-td-mute">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {c.status !== "recebido" && c.status !== "cancelado" && (
            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button
                className="wms-btn wms-btn-primary"
                disabled={receberMut.isPending}
                onClick={() => receberMut.mutate(c)}
              >
                Receber
              </button>
              {c.status === "comprado" && (
                <button
                  className="wms-btn wms-btn-ghost"
                  disabled={cancelarMut.isPending}
                  onClick={() => cancelarMut.mutate(c.id)}
                >
                  Cancelar
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
