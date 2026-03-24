"use client";

import { useMemo, useState } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { LogOut, RefreshCw, Settings, Search } from "lucide-react";
import Link from "next/link";

import { AppShell } from "@/components/app-shell";
import { Tabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { PedidoCardConcluido } from "@/components/pedido/pedido-card-concluido";
import { PedidoCard } from "@/components/pedido/pedido-card";
import { useAuth } from "@/lib/auth-context";
import {
  filtrarPendentesGalpao,
  filtrarConcluidosGalpao,
  filtrarAutoGalpao,
} from "@/lib/filtrar-pedidos";
import { GalpaoSelector } from "@/components/galpao-selector";

import type { Tab, Pedido, Decisao } from "@/types";

async function fetchPedidos(): Promise<Pedido[]> {
  const res = await fetch("/api/pedidos");
  if (!res.ok) throw new Error("Erro ao carregar pedidos");
  return res.json();
}

export default function DashboardPage() {
  const { user, logout, activeGalpaoNome } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab["id"]>("todos");
  const [busca, setBusca] = useState("");

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

  // Search filter — matches cliente nome, EC number, or SKU
  function matchBusca(p: Pedido): boolean {
    const q = busca.trim().toLowerCase();
    if (!q) return true;
    if (p.cliente.nome.toLowerCase().includes(q)) return true;
    if (p.idPedidoEcommerce?.toLowerCase().includes(q)) return true;
    if (p.numero?.toLowerCase().includes(q)) return true;
    if (p.itens?.some((i) => i.sku.toLowerCase().includes(q))) return true;
    return false;
  }

  // Filter by active galpão + search
  const pendentesFiltrados = useMemo(
    () => filtrarPendentesGalpao(pendentes, activeGalpaoNome).filter(matchBusca),
    [pendentes, activeGalpaoNome, busca],
  );
  const concluidosFiltrados = useMemo(
    () => filtrarConcluidosGalpao(concluidos, activeGalpaoNome).filter(matchBusca),
    [concluidos, activeGalpaoNome, busca],
  );
  const autoFiltrados = useMemo(
    () => filtrarAutoGalpao(auto, activeGalpaoNome).filter(matchBusca),
    [auto, activeGalpaoNome, busca],
  );
  const todosFiltrados = useMemo(() => {
    // Combine all filtered lists, dedup by id
    const seen = new Set<string>();
    const result: Pedido[] = [];
    for (const p of [...pendentesFiltrados, ...concluidosFiltrados, ...autoFiltrados]) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        result.push(p);
      }
    }
    return result;
  }, [pendentesFiltrados, concluidosFiltrados, autoFiltrados]);

  const tabs: Tab[] = [
    { id: "todos", label: "Todos", count: todosFiltrados.length },
    { id: "pendente", label: "Pendente", count: pendentesFiltrados.length },
    { id: "concluidos", label: "Concluídos", count: concluidosFiltrados.length },
    { id: "auto", label: "Auto", count: autoFiltrados.length },
  ];

  // Hide auto tab only if user ONLY has comprador (no other roles)
  const userCargos = user?.cargos ?? [user?.cargo ?? "admin"];
  const onlyComprador = userCargos.length === 1 && userCargos[0] === "comprador";
  const visibleTabs = onlyComprador ? tabs.filter((t) => t.id !== "auto") : tabs;

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
      {(user?.cargos ?? [user?.cargo]).includes("admin") && (
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
      <GalpaoSelector />
      <div className="hidden sm:flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5">
        <span className="font-mono text-xs font-semibold text-ink">
          {user?.nome}
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
      backHref="/"
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

      {/* Search */}
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
        <input
          type="text"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar cliente, EC, SKU..."
          className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
        />
      </div>

      {/* Todos tab */}
      {activeTab === "todos" && (
        <div className="flex flex-col gap-1.5">
          {todosFiltrados.length === 0 ? (
            <EmptyState message="Nenhum pedido encontrado." />
          ) : (
            <>
              <p className="mb-2 text-xs text-ink-faint">
                {todosFiltrados.length} pedido{todosFiltrados.length !== 1 ? "s" : ""}
              </p>
              {todosFiltrados.map((pedido) => (
                pedido.status === "pendente" ? (
                  <PedidoCard
                    key={pedido.id}
                    pedido={pedido}
                    onAprovar={handleAprovar}
                    onStockUpdated={() => queryClient.invalidateQueries({ queryKey: ["pedidos"] })}
                  />
                ) : (
                  <PedidoCardConcluido key={pedido.id} pedido={pedido} />
                )
              ))}
            </>
          )}
        </div>
      )}

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
                onStockUpdated={() => queryClient.invalidateQueries({ queryKey: ["pedidos"] })}
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
