"use client";

import "@/app/wms/wms.css";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import { CriarTransferenciaForm } from "@/components/transferencia/criar-transferencia-form";
import { ScanTransferencia } from "@/components/transferencia/scan-transferencia";
import { ProgressoProcessamento } from "@/components/inventario/progresso-processamento";
import { Icon, fmtDateTime, fmtNum } from "@/components/wms/ui/wms-ui";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import type { Transferencia, TransferenciaStatus } from "@/types";

type View = "list" | "create" | "scan" | "progress";

interface SelectedTransferencia {
  id: string;
  empresa_origem_id: string;
}

const STATUS_BADGE: Record<TransferenciaStatus, { label: string; cls: string }> = {
  em_andamento: { label: "Em andamento", cls: "wms-badge-info" },
  processando: { label: "Processando", cls: "wms-badge-info" },
  concluido: { label: "Concluído", cls: "wms-badge-ok" },
  cancelado: { label: "Cancelado", cls: "wms-badge-mute" },
  erro: { label: "Erro", cls: "wms-badge-danger" },
  revertendo: { label: "Revertendo", cls: "wms-badge-warn" },
  revertido: { label: "Revertido", cls: "wms-badge-mute" },
};

function StatusPill({ status }: { status: TransferenciaStatus }) {
  const s = STATUS_BADGE[status];
  return <span className={`wms-badge ${s.cls}`}>{s.label}</span>;
}

function localDisplay(empresa?: { nome: string }, galpao?: { nome: string }) {
  const e = empresa?.nome?.trim();
  const g = galpao?.nome?.trim();
  if (e && g) return { empresa: e, galpao: g };
  if (e) return { empresa: e, galpao: null };
  if (g) return { empresa: null, galpao: g };
  return { empresa: "—", galpao: null };
}

export default function TransferenciasPage() {
  const { user, activeGalpaoId } = useAuth();
  const queryClient = useQueryClient();

  const [view, setView] = useState<View>("list");
  const [selected, setSelected] = useState<SelectedTransferencia | null>(null);

  const { data: transferencias = [] } = useQuery<Transferencia[]>({
    queryKey: ["transferencias", activeGalpaoId],
    queryFn: async () => {
      const res = await sisoFetch("/api/transferencia");
      if (!res.ok) throw new Error("Erro ao carregar transferências");
      const data = await res.json();
      return data.transferencias ?? [];
    },
    enabled: !!user,
    refetchInterval: 30_000,
  });

  const emAndamento = useMemo(
    () =>
      transferencias.filter(
        (t) => t.status === "em_andamento" || t.status === "processando",
      ),
    [transferencias],
  );

  const historico = useMemo(
    () =>
      transferencias.filter(
        (t) =>
          t.status === "concluido" ||
          t.status === "erro" ||
          t.status === "revertido" ||
          t.status === "cancelado",
      ),
    [transferencias],
  );

  function handleCreated(transferenciaId: string, empresaOrigemId: string) {
    setSelected({ id: transferenciaId, empresa_origem_id: empresaOrigemId });
    setView("scan");
    queryClient.invalidateQueries({ queryKey: ["transferencias"] });
  }

  function handleRowClick(t: Transferencia) {
    if (t.status === "em_andamento") {
      setSelected({ id: t.id, empresa_origem_id: t.empresa_origem_id });
      setView("scan");
    } else {
      setSelected({ id: t.id, empresa_origem_id: t.empresa_origem_id });
      setView("progress");
    }
  }

  function handleProcessar() {
    if (!selected) return;
    if (
      !confirm(
        "Tem certeza que deseja processar esta transferência? Esta ação altera o estoque no Tiny ERP.",
      )
    )
      return;
    sisoFetch(`/api/transferencia/${selected.id}/processar`, { method: "POST" })
      .then((res) => {
        if (!res.ok)
          return res
            .json()
            .catch(() => ({}))
            .then((d: Record<string, string>) => {
              throw new Error(d.error ?? "Erro");
            });
        toast.success("Processamento iniciado");
        setView("progress");
        queryClient.invalidateQueries({ queryKey: ["transferencias"] });
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Erro ao processar");
      });
  }

  function handleCancelar() {
    if (!selected) return;
    if (!confirm("Tem certeza que deseja cancelar esta transferência?")) return;
    sisoFetch(`/api/transferencia/${selected.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelado" }),
    })
      .then((res) => {
        if (!res.ok)
          return res
            .json()
            .catch(() => ({}))
            .then((d: Record<string, string>) => {
              throw new Error(d.error ?? "Erro");
            });
        toast.success("Transferência cancelada");
        handleBack();
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Erro ao cancelar");
      });
  }

  function handleBack() {
    setView("list");
    setSelected(null);
    queryClient.invalidateQueries({ queryKey: ["transferencias"] });
  }

  const novaButton = (
    <button
      type="button"
      className="wms-btn wms-btn-primary"
      onClick={() => setView("create")}
    >
      <Icon name="plus" size={12} />
      Nova transferência
    </button>
  );

  const headerRight = view === "list" ? novaButton : undefined;

  return (
    <AppShell
      title="Transferências"
      subtitle="Movimentação par S+E entre empresas — gera saída na origem e entrada no destino"
      headerRight={headerRight}
    >
      {view === "list" && (
        <div className="wms-root">
          {emAndamento.length === 0 ? (
            <div className="wms-empty-block">
              <h3>Nenhuma transferência em trânsito</h3>
              <p className="wms-td-mute">
                Quando você inicia uma transferência entre empresas, ela
                aparece aqui com status (em andamento, processando, revertendo).
                Cada par é gerado com a mesma <span className="wms-mono">origem_id</span>.
              </p>
              <button
                type="button"
                className="wms-btn wms-btn-primary"
                onClick={() => setView("create")}
              >
                <Icon name="plus" size={12} />
                Iniciar transferência
              </button>
            </div>
          ) : (
            <>
              <h3 className="wms-sec-h">Em trânsito</h3>
              <TransferenciasTable
                rows={emAndamento}
                onRowClick={handleRowClick}
              />
            </>
          )}

          <h3 className="wms-sec-h" style={{ marginTop: 24 }}>
            Histórico recente
          </h3>
          {historico.length === 0 ? (
            <div className="wms-tbl wms-tbl-regular">
              <div
                className="wms-td-mute"
                style={{ padding: 32, textAlign: "center", fontSize: 13 }}
              >
                Nenhuma transferência concluída ainda.
              </div>
            </div>
          ) : (
            <TransferenciasTable rows={historico} onRowClick={handleRowClick} />
          )}
        </div>
      )}

      {view === "create" && <CriarTransferenciaForm onCreated={handleCreated} />}

      {view === "scan" && selected && (
        <ScanTransferencia
          transferenciaId={selected.id}
          onProcessar={handleProcessar}
          onCancelar={handleCancelar}
        />
      )}

      {view === "progress" && selected && (
        <ProgressoProcessamento sessionId={selected.id} tipo="transferencia" />
      )}
    </AppShell>
  );
}

function TransferenciasTable({
  rows,
  onRowClick,
}: {
  rows: Transferencia[];
  onRowClick: (t: Transferencia) => void;
}) {
  return (
    <div className="wms-tbl wms-tbl-regular">
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>Operador</th>
            <th>Origem</th>
            <th></th>
            <th>Destino</th>
            <th className="wms-tar">Itens</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const orig = localDisplay(t.empresa_origem, t.galpao_origem);
            const dest = localDisplay(t.empresa_destino, t.galpao_destino);
            return (
              <tr
                key={t.id}
                className="wms-tr-clickable"
                onClick={() => onRowClick(t)}
              >
                <td className="wms-td-mute">{fmtDateTime(t.created_at)}</td>
                <td>{t.usuario?.nome ?? "—"}</td>
                <td>
                  {orig.empresa && (
                    <span className="wms-chip-emp">{orig.empresa}</span>
                  )}
                  {orig.galpao && (
                    <>
                      {" "}
                      <span className="wms-td-mute">{orig.galpao}</span>
                    </>
                  )}
                </td>
                <td>
                  <Icon name="arrow-right" size={12} />
                </td>
                <td>
                  {dest.empresa && (
                    <span className="wms-chip-emp">{dest.empresa}</span>
                  )}
                  {dest.galpao && (
                    <>
                      {" "}
                      <span className="wms-td-mute">{dest.galpao}</span>
                    </>
                  )}
                </td>
                <td className="wms-tar wms-mono">
                  {fmtNum(t.total_itens ?? 0)}
                </td>
                <td>
                  <StatusPill status={t.status} />
                </td>
                <td className="wms-td-actions">
                  <Icon name="chevron-r" size={11} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
