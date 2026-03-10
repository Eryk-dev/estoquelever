"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, LogOut, RefreshCw } from "lucide-react";

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
import Link from "next/link";
import { useState } from "react";

async function fetchPedidos(): Promise<Pedido[]> {
  const res = await fetch("/api/pedidos");
  if (!res.ok) throw new Error("Erro ao carregar pedidos");
  return res.json();
}

export default function DashboardPage() {
  const { user, loading: authLoading, logout } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab["id"]>("pendente");

  const { data: allPedidos = [], isLoading, isRefetching } = useQuery({
    queryKey: ["pedidos"],
    queryFn: fetchPedidos,
    enabled: !!user,
    refetchInterval: 30_000,
  });

  // Redirect to login if not authenticated
  if (!authLoading && !user) {
    router.replace("/login");
  }

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
    router.replace("/login");
  }

  if (authLoading || (isLoading && !allPedidos.length)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div>
            <h1 className="text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
              SISO
            </h1>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
              Separação de Ordens
            </p>
          </div>

          {/* Settings + User */}
          <div className="flex items-center gap-2">
            {user.cargo === "admin" && (
              <Link
                href="/configuracoes"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                title="Configurações"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                  <path fillRule="evenodd" d="M8.34 1.804A1 1 0 019.32 1h1.36a1 1 0 01.98.804l.295 1.473c.497.144.971.342 1.416.587l1.25-.834a1 1 0 011.262.125l.962.962a1 1 0 01.125 1.262l-.834 1.25c.245.445.443.919.587 1.416l1.473.295a1 1 0 01.804.98v1.361a1 1 0 01-.804.98l-1.473.295a6.95 6.95 0 01-.587 1.416l.834 1.25a1 1 0 01-.125 1.262l-.962.962a1 1 0 01-1.262.125l-1.25-.834a6.953 6.953 0 01-1.416.587l-.295 1.473a1 1 0 01-.98.804H9.32a1 1 0 01-.98-.804l-.295-1.473a6.957 6.957 0 01-1.416-.587l-1.25.834a1 1 0 01-1.262-.125l-.962-.962a1 1 0 01-.125-1.262l.834-1.25a6.957 6.957 0 01-.587-1.416l-1.473-.295A1 1 0 011 11.18V9.82a1 1 0 01.804-.98l1.473-.295c.144-.497.342-.971.587-1.416l-.834-1.25a1 1 0 01.125-1.262l.962-.962A1 1 0 015.38 3.53l1.25.834a6.957 6.957 0 011.416-.587l.295-1.473zM13 10a3 3 0 11-6 0 3 3 0 016 0z" clipRule="evenodd" />
                </svg>
              </Link>
            )}
            <button
              type="button"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["pedidos"] })}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              title="Atualizar"
            >
              <RefreshCw className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} />
            </button>
            <div className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-800">
              <span className="font-mono text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                {user.nome}
              </span>
              <span className="text-[10px] text-zinc-400">
                {CARGO_LABELS[user.cargo]}
              </span>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              title="Sair"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-3xl px-4 py-6">
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
                <p className="mb-2 text-xs text-zinc-400 dark:text-zinc-500">
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
                <p className="mb-2 text-xs text-zinc-400 dark:text-zinc-500">
                  {autoFiltrados.length} pedido{autoFiltrados.length !== 1 ? "s" : ""} processado{autoFiltrados.length !== 1 ? "s" : ""} automaticamente
                </p>
                {autoFiltrados.map((pedido) => (
                  <PedidoCardConcluido key={pedido.id} pedido={pedido} />
                ))}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
