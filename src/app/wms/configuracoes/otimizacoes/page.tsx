"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { PageHeader } from "@/components/wms/ui/wms-ui";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";

interface ConfigRow {
  galpao_id: string;
  galpao_nome: string;
  ativo: boolean;
  atualizado_em: string;
  atualizado_por_nome: string | null;
}

export default function MiniSwapOtimizacoesPage() {
  const { user } = useAuth();
  const isAdmin = (user?.cargos ?? [user?.cargo]).includes("admin");
  const qc = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["wms-mini-swap-config"],
    queryFn: () => wmsApi<ConfigRow[]>("/api/wms/mini-swap/config"),
  });

  const toggleMut = useMutation({
    mutationFn: async (vars: { galpaoId: string; ativo: boolean }) => {
      await wmsApi<unknown>(`/api/wms/mini-swap/config/${vars.galpaoId}`, {
        method: "PATCH",
        body: JSON.stringify({ ativo: vars.ativo }),
      });
    },
    onSuccess: (_, vars) => {
      toast.success(`Mini-swap ${vars.ativo ? "ativado" : "desativado"}`);
      qc.invalidateQueries({ queryKey: ["wms-mini-swap-config"] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Falha ao salvar";
      toast.error(msg);
    },
    onSettled: () => setPendingId(null),
  });

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Otimizações" />
        <div className="wms-empty-block">
          <h3>Acesso restrito</h3>
          <p>Apenas administradores podem editar otimizações do WMS.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Otimizações"
        subtitle="Mini-swap intra-galpão consolida produtos com múltiplas locs em 1 loc canônica antes da wave começar. Sem custo contábil. Liga/desliga por galpão."
      />

      {query.isLoading && (
        <div className="wms-empty-block">
          <p>Carregando...</p>
        </div>
      )}

      {query.data && (
        <div className="wms-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="wms-table">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Galpão</th>
                <th style={{ textAlign: "left" }}>Mini-swap</th>
                <th style={{ textAlign: "left" }}>Última alteração</th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((r) => (
                <tr key={r.galpao_id}>
                  <td style={{ fontWeight: 500 }}>{r.galpao_nome}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => {
                        setPendingId(r.galpao_id);
                        toggleMut.mutate({
                          galpaoId: r.galpao_id,
                          ativo: !r.ativo,
                        });
                      }}
                      disabled={pendingId === r.galpao_id}
                      style={{
                        position: "relative",
                        display: "inline-flex",
                        alignItems: "center",
                        height: 24,
                        width: 44,
                        borderRadius: 999,
                        border: "none",
                        cursor:
                          pendingId === r.galpao_id ? "wait" : "pointer",
                        backgroundColor: r.ativo ? "#0f766e" : "#d4d4d8",
                        transition: "background-color 0.15s",
                        opacity: pendingId === r.galpao_id ? 0.6 : 1,
                      }}
                      aria-pressed={r.ativo}
                      title={
                        r.ativo ? "Desativar mini-swap" : "Ativar mini-swap"
                      }
                    >
                      <span
                        style={{
                          display: "inline-block",
                          height: 16,
                          width: 16,
                          borderRadius: "50%",
                          backgroundColor: "white",
                          transition: "transform 0.15s",
                          transform: r.ativo
                            ? "translateX(22px)"
                            : "translateX(4px)",
                        }}
                      />
                    </button>
                    <span
                      style={{ marginLeft: 12, fontSize: 12, color: "#71717a" }}
                    >
                      {r.ativo ? "Ativo" : "Inativo"}
                    </span>
                  </td>
                  <td style={{ color: "#71717a", fontSize: 12 }}>
                    {new Date(r.atualizado_em).toLocaleString("pt-BR")}
                    {r.atualizado_por_nome
                      ? ` por ${r.atualizado_por_nome}`
                      : ""}
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
