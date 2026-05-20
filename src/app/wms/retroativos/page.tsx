"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Icon,
  PageHeader,
  StatusBadge,
  fmtBRL,
  fmtDateTime,
  fmtNum,
} from "@/components/wms/ui/wms-ui";

interface RetroativoRow {
  id: string;
  criado_em: string;
  quantidade: number;
  observacoes: string | null;
  motivo: string | null;
  custo_unitario: number | null;
  produto: { sku: string; descricao: string } | null;
  galpao: { nome: string } | null;
  localizacao: { codigo: string } | null;
  // Tags 3D opcionais: compradora histórica + fornecedor.
  compradora: { nome: string } | null;
  fornecedor: { nome: string } | null;
  status?: string;
}

export default function RetroativosPage() {
  const queryClient = useQueryClient();
  const [compraIdInputs, setCompraIdInputs] = useState<Record<string, string>>(
    {},
  );

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["wms-retroativos"],
    queryFn: () =>
      wmsApi<{ rows: RetroativoRow[] }>("/api/wms/lancamento-retroativo"),
  });

  const reconciliar = useMutation({
    mutationFn: ({ id, compraId }: { id: string; compraId: string }) =>
      wmsApi<{ ok: true }>(`/api/wms/lancamento-retroativo/${id}/reconciliar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compra_mov_id: compraId }),
      }),
    onSuccess: (_d, vars) => {
      toast.success("Reconciliado");
      setCompraIdInputs((prev) => {
        const next = { ...prev };
        delete next[vars.id];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ["wms-retroativos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = data?.rows ?? [];

  return (
    <>
      <PageHeader
        title="Retroativos"
        subtitle="Entradas registradas em emergência aguardando match com NF real"
      />

      {isLoading && (
        <div className="wms-loading-pane">Carregando pendências…</div>
      )}
      {isError && (
        <div className="wms-empty-block">
          <h3>Erro</h3>
          <p>{(error as Error).message}</p>
        </div>
      )}
      {!isLoading && !isError && rows.length === 0 && (
        <div className="wms-empty-block">
          <h3>Nenhuma pendência de reconciliação</h3>
          <p>
            Sem lançamentos retroativos aguardando. Movimentos boca-a-boca
            chegam aqui assim que registrados em emergência.
          </p>
        </div>
      )}

      {!isLoading && rows.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th>Criado em</th>
                <th>SKU</th>
                <th>Produto</th>
                <th className="wms-tar">Qty</th>
                <th className="wms-tar">Custo un.</th>
                <th>Localização</th>
                <th>Tags 3D</th>
                <th>Status</th>
                <th>Reconciliar com</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="wms-td-mute">{fmtDateTime(r.criado_em)}</td>
                  <td className="wms-mono">{r.produto?.sku ?? "—"}</td>
                  <td className="wms-td-desc">{r.produto?.descricao ?? "—"}</td>
                  <td className="wms-tar wms-mono">
                    {fmtNum(Number(r.quantidade))}
                  </td>
                  <td className="wms-tar wms-mono wms-td-mute">
                    {r.custo_unitario != null ? fmtBRL(Number(r.custo_unitario)) : "—"}
                  </td>
                  <td className="wms-td-mute">
                    {r.galpao?.nome ?? "—"} ·{" "}
                    <span className="wms-mono">
                      {r.localizacao?.codigo ?? "—"}
                    </span>
                  </td>
                  <td
                    className="wms-td-mute"
                    style={{ fontSize: 11, lineHeight: 1.5 }}
                  >
                    {r.compradora?.nome && (
                      <div>
                        <span style={{ opacity: 0.7 }}>compradora:</span>{" "}
                        {r.compradora.nome}
                      </div>
                    )}
                    {r.fornecedor?.nome && (
                      <div>
                        <span style={{ opacity: 0.7 }}>fornecedor:</span>{" "}
                        {r.fornecedor.nome}
                      </div>
                    )}
                    {!r.compradora?.nome && !r.fornecedor?.nome && "—"}
                  </td>
                  <td>
                    <StatusBadge status={r.status ?? "pendente"} />
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        className="wms-input wms-mono"
                        placeholder="UUID da mov. de compra"
                        value={compraIdInputs[r.id] ?? ""}
                        onChange={(e) =>
                          setCompraIdInputs((prev) => ({
                            ...prev,
                            [r.id]: e.target.value,
                          }))
                        }
                        style={{ flex: 1, minWidth: 220, fontSize: 11.5 }}
                        disabled={reconciliar.isPending}
                      />
                      <button
                        type="button"
                        className="wms-btn wms-btn-sm wms-btn-ghost"
                        disabled={
                          reconciliar.isPending ||
                          !(compraIdInputs[r.id] ?? "").trim()
                        }
                        onClick={() =>
                          reconciliar.mutate({
                            id: r.id,
                            compraId: (compraIdInputs[r.id] ?? "").trim(),
                          })
                        }
                      >
                        <Icon name="check" size={11} />
                        Reconciliar
                      </button>
                    </div>
                    {(r.motivo || r.observacoes) && (
                      <div
                        className="wms-td-mute"
                        style={{ fontSize: 11, marginTop: 4 }}
                      >
                        {r.motivo ?? r.observacoes}
                      </div>
                    )}
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
