"use client";

import { useMemo, useState } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { LogOut, RefreshCw, Settings } from "lucide-react";
import Link from "next/link";

import { AppShell } from "@/components/app-shell";
import { Tabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { PedidoCardConcluido } from "@/components/pedido/pedido-card-concluido";
import { PedidoCard } from "@/components/pedido/pedido-card";
import { useAuth } from "@/lib/auth-context";
import {
  filtrarPendentes,
  filtrarConcluidos,
  filtrarAuto,
} from "@/lib/filtrar-pedidos";
import { CARGO_LABELS } from "@/types";

import type { Tab, Pedido, Decisao } from "@/types";

async function fetchPedidos(): Promise<Pedido[]> {
  const res = await fetch("/api/pedidos");
  if (!res.ok) throw new Error("Erro ao carregar pedidos");
  return res.json();
}

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab["id"]>("pendente");

  const { data: allPedidos = [], isRefetching } = useQuery({
    queryKey: ["pedidos"],
    queryFn: fetchPedidos,
    enabled: !!user,
    refetchInterval: 30_000,
  });

  // Split into categories
  const pendentes = useMemo(
    () => allPedidos.filter((p) => p.status === "pendente"),
    [allPedidos],
  );
  const concluidos = useMemo(
    () => allPedidos.filter((p) => p.status === "concluido" && p.tipoResolucao !== "auto"),
    [allPedidos],
  );
  const auto = useMemo(
    () => allPedidos.filter((p) => p.tipoResolucao === "auto"),
    [allPedidos],
  );

  // Filter by role
  const cargo = user?.cargo ?? "admin";

  const pendentesFiltrados = useMemo(
    () => filtrarPendentes(pendentes, cargo),
    [pendentes, cargo],
  );
  const concluidosFiltrados = useMemo(
    () => filtrarConcluidos(concluidos, cargo),
    [concluidos, cargo],
  );
  const autoFiltrados = useMemo(
    () => filtrarAuto(auto, cargo),
    [auto, cargo],
  );

  const tabs: Tab[] = [
    { id: "pendente", label: "Pendente", count: pendentesFiltrados.length },
    { id: "concluidos", label: "Concluídos", count: concluidosFiltrados.length },
    { id: "auto", label: "Auto", count: autoFiltrados.length },
  ];

  const visibleTabs = cargo === "comprador" ? tabs.filter((t) => t.id !== "auto") : tabs;

  async function handleAprovar(id: string, decisao: Decisao) {
    const pedido = pendentes.find((p) => p.id === id);
    try {
      const res = await fetch("/api/pedidos/aprovar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedidoId: id,
          decisao,
          operadorId: user?.id,
          operadorNome: user?.nome,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Erro ao aprovar pedido");
        return;
      }

      toast.success(`Pedido #${pedido?.numero ?? id} aprovado → ${decisao}`);
      queryClient.invalidateQueries({ queryKey: ["pedidos"] });
    } catch {
      toast.error("Erro de conexão ao aprovar pedido");
    }
  }

  function handleLogout() {
    logout();
  }

  const headerRight = (
    <>
      {user?.cargo === "admin" && (
        <Link
          href="/configuracoes"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
          title="Configurações"
        >
          <Settings className="h-4 w-4" />
        </Link>
      )}
      <button
        type="button"
        onClick={() => queryClient.invalidateQueries({ queryKey: ["pedidos"] })}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
        title="Atualizar"
      >
        <RefreshCw className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} />
      </button>
      <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5">
        <span className="font-mono text-xs font-semibold text-ink">
          {user?.nome}
        </span>
        <span className="text-[10px] text-ink-faint">
          {user ? CARGO_LABELS[user.cargo] : ""}
        </span>
      </div>
      <button
        type="button"
        onClick={handleLogout}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
        title="Sair"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </>
  );

  return (
    <AppShell
      title="SISO"
      subtitle="Separação de Ordens"
      headerRight={headerRight}
    >
      {/* Tab bar */}
      <div className="mb-5">
        <Tabs
          tabs={visibleTabs}
          activeTab={activeTab}
          onChange={(id) => setActiveTab(id as Tab["id"])}
        />
      </div>

      {/* Pendente tab */}
      {activeTab === "pendente" && (
        <div className="flex flex-col gap-3">
          {pendentesFiltrados.length === 0 ? (
            <EmptyState message="Nenhum pedido pendente no momento." />
          ) : (
            pendentesFiltrados.map((pedido) => (
              <PedidoCard
                key={pedido.id}
                pedido={pedido}
                onAprovar={handleAprovar}
              />
            ))
          )}
        </div>
      )}

      {/* Concluidos tab */}
      {activeTab === "concluidos" && (
        <div className="flex flex-col gap-1.5">
          {concluidosFiltrados.length === 0 ? (
            <EmptyState message="Nenhum pedido concluído ainda." />
          ) : (
            <>
              <p className="mb-2 text-xs text-ink-faint">
                {concluidosFiltrados.length} pedido{concluidosFiltrados.length !== 1 ? "s" : ""} concluído{concluidosFiltrados.length !== 1 ? "s" : ""}
              </p>
              {concluidosFiltrados.map((pedido) => (
                <PedidoCardConcluido key={pedido.id} pedido={pedido} />
              ))}
            </>
          )}
        </div>
      )}

      {/* Auto tab */}
      {activeTab === "auto" && (
        <div className="flex flex-col gap-1.5">
          {autoFiltrados.length === 0 ? (
            <EmptyState message="Nenhum pedido processado automaticamente." />
          ) : (
            <>
              <p className="mb-2 text-xs text-ink-faint">
                {autoFiltrados.length} pedido{autoFiltrados.length !== 1 ? "s" : ""} processado{autoFiltrados.length !== 1 ? "s" : ""} automaticamente
              </p>
              {autoFiltrados.map((pedido) => (
                <PedidoCardConcluido key={pedido.id} pedido={pedido} />
              ))}
            </>
          )}
        </div>
      )}
    </AppShell>
  );
}
