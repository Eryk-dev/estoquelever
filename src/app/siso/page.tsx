"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { LogOut, RefreshCw, Settings } from "lucide-react";
import Link from "next/link";

import { AppShell } from "@/components/app-shell";
import { REFRESH_INTERVAL_LIST } from "@/lib/constants";
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

const SISO_STATUSES = "pendente,erro,aguardando_compra,aguardando_nf,aguardando_separacao,em_separacao,separado,embalado";

async function fetchPedidos(): Promise<Pedido[]> {
  const res = await fetch(`/api/pedidos?status_unificado=${SISO_STATUSES}`);
  if (!res.ok) throw new Error("Erro ao carregar pedidos");
  return res.json();
}

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab["id"]>("pendente");

  // IDs approved this session — survives refetches so cards never come back
  const approvedIdsRef = useRef(new Set<string>());

  const { data: allPedidos = [], isRefetching } = useQuery({
    queryKey: ["pedidos"],
    queryFn: fetchPedidos,
    enabled: !!user,
    refetchInterval: REFRESH_INTERVAL_LIST,
  });

  // Clean up approvedIds that no longer exist on the server (e.g. reprocessed)
  useEffect(() => {
    const serverIds = new Set(allPedidos.map((p) => p.id));
    for (const id of approvedIdsRef.current) {
      if (!serverIds.has(id)) approvedIdsRef.current.delete(id);
    }
  }, [allPedidos]);

  const pendentes = useMemo(
    () => allPedidos.filter((p) =>
      !approvedIdsRef.current.has(p.id) &&
      (p.statusUnificado === "pendente" || p.statusUnificado === "erro")
    ),
    [allPedidos],
  );
  const concluidos = useMemo(
    () => allPedidos.filter((p) =>
      p.tipoResolucao === "manual" &&
      ["aguardando_compra", "aguardando_nf", "aguardando_separacao", "em_separacao", "separado", "embalado"].includes(p.statusUnificado ?? "")
    ),
    [allPedidos],
  );
  const auto = useMemo(
    () => allPedidos.filter((p) => p.tipoResolucao === "auto"),
    [allPedidos],
  );

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

  const handleAprovar = useCallback(
    (id: string, decisao: Decisao) => {
      const pedido = allPedidos.find((p) => p.id === id);

      // Mark as approved locally — card never comes back regardless of refetches
      approvedIdsRef.current.add(id);

      // Force re-render so the card disappears immediately
      queryClient.setQueryData<Pedido[]>(["pedidos"], (old) => old ? [...old] : []);
      toast.success(`Pedido #${pedido?.numero ?? id} aprovado → ${decisao}`);

      // Fire-and-forget: API call runs in background
      fetch("/api/pedidos/aprovar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedidoId: id,
          decisao,
          operadorId: user?.id,
          operadorNome: user?.nome,
        }),
      })
        .then((res) => {
          if (!res.ok && res.status !== 409) {
            res.json().catch(() => ({})).then((data) => {
              toast.error(data.error ?? "Erro ao aprovar pedido");
            });
          }
        })
        .catch(() => {
          toast.error("Erro de conexão ao aprovar pedido");
        });
    },
    [allPedidos, queryClient, user],
  );

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
        onClick={() => logout()}
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
      <div className="mb-5">
        <Tabs
          tabs={visibleTabs}
          activeTab={activeTab}
          onChange={(id) => setActiveTab(id as Tab["id"])}
        />
      </div>

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
