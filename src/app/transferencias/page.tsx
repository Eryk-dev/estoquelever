"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, ArrowLeft } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Tabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { TransferenciaCard } from "@/components/transferencia/transferencia-card";
import { CriarTransferenciaForm } from "@/components/transferencia/criar-transferencia-form";
import { ScanTransferencia } from "@/components/transferencia/scan-transferencia";
import { ProgressoProcessamento } from "@/components/inventario/progresso-processamento";
import { useAuth } from "@/lib/auth-context";
import { sisoFetch } from "@/lib/auth-context";
import type { Transferencia, Tab } from "@/types";

type View = "list" | "create" | "scan" | "progress";

interface SelectedTransferencia {
  id: string;
  empresa_origem_id: string;
}

export default function TransferenciasPage() {
  const { user, activeGalpaoId } = useAuth();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<string>("em_andamento");
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

  const concluidos = useMemo(
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

  const tabs: Tab[] = [
    { id: "em_andamento", label: "Em Andamento", count: emAndamento.length },
    { id: "concluidos", label: "Concluídos", count: concluidos.length },
  ];

  function handleCreated(transferenciaId: string, empresaOrigemId: string) {
    setSelected({ id: transferenciaId, empresa_origem_id: empresaOrigemId });
    setView("scan");
    queryClient.invalidateQueries({ queryKey: ["transferencias"] });
  }

  function handleCardClick(t: Transferencia) {
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
    if (!confirm("Tem certeza que deseja processar esta transferência? Esta ação altera o estoque no Tiny ERP.")) return;
    sisoFetch(`/api/transferencia/${selected.id}/processar`, { method: "POST" })
      .then((res) => {
        if (!res.ok) return res.json().catch(() => ({})).then((d: Record<string, string>) => { throw new Error(d.error ?? "Erro"); });
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
        if (!res.ok) return res.json().catch(() => ({})).then((d: Record<string, string>) => { throw new Error(d.error ?? "Erro"); });
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

  const headerRight =
    view === "list" ? (
      <button
        type="button"
        onClick={() => setView("create")}
        className="inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-paper transition-opacity hover:opacity-90"
      >
        <Plus className="h-3.5 w-3.5" />
        Nova
      </button>
    ) : (
      <button
        type="button"
        onClick={handleBack}
        className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:bg-surface hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Voltar
      </button>
    );

  return (
    <AppShell title="Transferência" backHref="/" headerRight={headerRight}>
      {view === "list" && (
        <>
          <div className="mb-5">
            <Tabs
              tabs={tabs}
              activeTab={activeTab}
              onChange={(id) => setActiveTab(id)}
            />
          </div>

          {activeTab === "em_andamento" && (
            <div className="flex flex-col gap-3">
              {emAndamento.length === 0 ? (
                <EmptyState message="Nenhuma transferência em andamento." />
              ) : (
                emAndamento.map((t) => (
                  <TransferenciaCard
                    key={t.id}
                    transferencia={t}
                    onClick={() => handleCardClick(t)}
                  />
                ))
              )}
            </div>
          )}

          {activeTab === "concluidos" && (
            <div className="flex flex-col gap-3">
              {concluidos.length === 0 ? (
                <EmptyState message="Nenhuma transferência concluída." />
              ) : (
                concluidos.map((t) => (
                  <TransferenciaCard
                    key={t.id}
                    transferencia={t}
                    onClick={() => handleCardClick(t)}
                  />
                ))
              )}
            </div>
          )}
        </>
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
