"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, ArrowLeft } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Tabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { InventarioCard } from "@/components/inventario/inventario-card";
import { CriarInventarioForm } from "@/components/inventario/criar-inventario-form";
import { ScanInventario } from "@/components/inventario/scan-inventario";
import { ProgressoProcessamento } from "@/components/inventario/progresso-processamento";
import { useAuth } from "@/lib/auth-context";
import { sisoFetch } from "@/lib/auth-context";
import type { Inventario, Tab } from "@/types";

type View = "list" | "create" | "scan" | "progress";

interface SelectedInventario {
  id: string;
  empresa_id: string;
  modo: string;
  tipo_estoque: string | null;
}

export default function InventarioPage() {
  const { user, activeGalpaoId } = useAuth();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<string>("em_andamento");
  const [view, setView] = useState<View>("list");
  const [selected, setSelected] = useState<SelectedInventario | null>(null);

  const { data: inventarios = [] } = useQuery<Inventario[]>({
    queryKey: ["inventarios", activeGalpaoId],
    queryFn: async () => {
      const res = await sisoFetch("/api/inventario");
      if (!res.ok) throw new Error("Erro ao carregar inventários");
      const data = await res.json();
      return data.inventarios ?? [];
    },
    enabled: !!user,
    refetchInterval: 30_000,
  });

  // Split by tab
  const emAndamento = useMemo(
    () =>
      inventarios.filter(
        (i) => i.status === "em_andamento" || i.status === "processando",
      ),
    [inventarios],
  );

  const concluidos = useMemo(
    () =>
      inventarios.filter(
        (i) =>
          i.status === "concluido" ||
          i.status === "erro" ||
          i.status === "revertido" ||
          i.status === "cancelado",
      ),
    [inventarios],
  );

  const tabs: Tab[] = [
    { id: "em_andamento", label: "Em Andamento", count: emAndamento.length },
    { id: "concluidos", label: "Concluídos", count: concluidos.length },
  ];

  function handleCreated(inventarioId: string) {
    // Fetch the created inventario detail to get modo/tipo_estoque
    sisoFetch(`/api/inventario/${inventarioId}`)
      .then((res) => res.json())
      .then((inv) => {
        setSelected({
          id: inv.id,
          empresa_id: inv.empresa_id,
          modo: inv.modo,
          tipo_estoque: inv.tipo_estoque,
        });
        setView("scan");
        queryClient.invalidateQueries({ queryKey: ["inventarios"] });
      })
      .catch(() => {
        toast.error("Erro ao carregar inventário criado");
        setView("list");
      });
  }

  function handleCardClick(inv: Inventario) {
    if (inv.status === "em_andamento") {
      setSelected({
        id: inv.id,
        empresa_id: inv.empresa_id,
        modo: inv.modo,
        tipo_estoque: inv.tipo_estoque,
      });
      setView("scan");
    } else if (inv.status === "processando" || inv.status === "revertendo") {
      setSelected({ id: inv.id, empresa_id: inv.empresa_id, modo: inv.modo, tipo_estoque: inv.tipo_estoque });
      setView("progress");
    } else {
      // concluido, erro, revertido — show progress (results)
      setSelected({ id: inv.id, empresa_id: inv.empresa_id, modo: inv.modo, tipo_estoque: inv.tipo_estoque });
      setView("progress");
    }
  }

  function handleProcessar() {
    if (!selected) return;
    if (!confirm("Tem certeza que deseja processar este inventário? Esta ação altera o estoque no Tiny ERP.")) return;
    sisoFetch(`/api/inventario/${selected.id}/processar`, { method: "POST" })
      .then((res) => {
        if (!res.ok) return res.json().catch(() => ({})).then((d: Record<string, string>) => { throw new Error(d.error ?? "Erro"); });
        toast.success("Processamento iniciado");
        setView("progress");
        queryClient.invalidateQueries({ queryKey: ["inventarios"] });
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Erro ao processar");
      });
  }

  function handleCancelar() {
    if (!selected) return;
    if (!confirm("Tem certeza que deseja cancelar este inventário?")) return;
    sisoFetch(`/api/inventario/${selected.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelado" }),
    })
      .then((res) => {
        if (!res.ok) return res.json().catch(() => ({})).then((d: Record<string, string>) => { throw new Error(d.error ?? "Erro"); });
        toast.success("Inventário cancelado");
        handleBack();
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Erro ao cancelar");
      });
  }

  function handleBack() {
    setView("list");
    setSelected(null);
    queryClient.invalidateQueries({ queryKey: ["inventarios"] });
  }

  // Header right: +Novo button (only in list view)
  const headerRight =
    view === "list" ? (
      <button
        type="button"
        onClick={() => setView("create")}
        className="inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-paper transition-opacity hover:opacity-90"
      >
        <Plus className="h-3.5 w-3.5" />
        Novo
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
    <AppShell title="Inventário" backHref="/" headerRight={headerRight}>
      {/* List view */}
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
                <EmptyState message="Nenhum inventário em andamento." />
              ) : (
                emAndamento.map((inv) => (
                  <InventarioCard
                    key={inv.id}
                    inventario={inv}
                    onClick={() => handleCardClick(inv)}
                  />
                ))
              )}
            </div>
          )}

          {activeTab === "concluidos" && (
            <div className="flex flex-col gap-3">
              {concluidos.length === 0 ? (
                <EmptyState message="Nenhum inventário concluído." />
              ) : (
                concluidos.map((inv) => (
                  <InventarioCard
                    key={inv.id}
                    inventario={inv}
                    onClick={() => handleCardClick(inv)}
                  />
                ))
              )}
            </div>
          )}
        </>
      )}

      {/* Create view */}
      {view === "create" && <CriarInventarioForm onCreated={handleCreated} />}

      {/* Scan view */}
      {view === "scan" && selected && (
        <ScanInventario
          inventarioId={selected.id}
          modo={selected.modo}
          tipoEstoque={selected.tipo_estoque}
          onProcessar={handleProcessar}
          onCancelar={handleCancelar}
        />
      )}

      {/* Progress view */}
      {view === "progress" && selected && (
        <ProgressoProcessamento sessionId={selected.id} tipo="inventario" />
      )}
    </AppShell>
  );
}
