"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Home, LogOut, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { Tabs } from "@/components/ui/tabs";
import { TabPendentes } from "@/components/separacao/tab-pendentes";
import { TabAguardandoNf } from "@/components/separacao/tab-aguardando-nf";
import { TabEmbalados } from "@/components/separacao/tab-embalados";
import { TabExpedidos } from "@/components/separacao/tab-expedidos";
import { CARGO_LABELS } from "@/types";
import type { Tab } from "@/types";
import type { PedidoSeparacao } from "@/components/separacao/pedido-separacao-card";

type TabId = "aguardando_nf" | "pendentes" | "embalados" | "expedidos";

function statusToTab(status: string): TabId {
  if (status === "aguardando_separacao" || status === "em_separacao") return "pendentes";
  if (status === "aguardando_nf") return "aguardando_nf";
  if (status === "embalado") return "embalados";
  if (status === "separado") return "expedidos";
  return "pendentes";
}

interface GalpaoOption {
  id: string;
  nome: string;
}

export default function SeparacaoPage() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabId>("pendentes");
  const [selectedGalpaoId, setSelectedGalpaoId] = useState<string | null>(null);

  const isAdmin = user?.cargo === "admin";

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

  // Fetch galpões for admin selector
  const { data: galpoes } = useQuery<GalpaoOption[]>({
    queryKey: ["galpoes-list"],
    queryFn: async () => {
      const res = await sisoFetch("/api/admin/galpoes");
      if (!res.ok) return [];
      const data = await res.json();
      return data.map((g: { id: string; nome: string }) => ({
        id: g.id,
        nome: g.nome,
      }));
    },
    enabled: isAdmin,
  });

  // Derive effective galpão: use explicit selection or default to first loaded
  const effectiveGalpaoId = selectedGalpaoId ?? galpoes?.[0]?.id ?? null;

  // Build query params
  const galpaoParam =
    isAdmin && effectiveGalpaoId ? `?galpao_id=${effectiveGalpaoId}` : "";
  const canFetch = !loading && !!user && (!isAdmin || !!effectiveGalpaoId);

  // Fetch all orders (no status filter) — group on client for tab counts
  const { data: allPedidos, refetch } = useQuery<PedidoSeparacao[]>({
    queryKey: ["separacao-all", galpaoParam],
    queryFn: async () => {
      const res = await sisoFetch(`/api/separacao${galpaoParam}`);
      if (!res.ok) return [];
      const json = await res.json();
      // API returns { counts, pedidos } — extract pedidos array
      return json.pedidos ?? json;
    },
    enabled: canFetch,
    refetchInterval: 10000,
  });

  // Group pedidos by tab
  const grouped: Record<TabId, PedidoSeparacao[]> = {
    aguardando_nf: [],
    pendentes: [],
    embalados: [],
    expedidos: [],
  };

  for (const p of allPedidos ?? []) {
    const tab = statusToTab(p.status_separacao);
    grouped[tab].push(p);
  }

  const tabs: Tab[] = [
    {
      id: "aguardando_nf",
      label: "Aguardando NF",
      count: grouped.aguardando_nf.length,
    },
    { id: "pendentes", label: "Pendentes", count: grouped.pendentes.length },
    { id: "embalados", label: "Embalados", count: grouped.embalados.length },
    { id: "expedidos", label: "Expedidos", count: grouped.expedidos.length },
  ];

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-faint border-t-ink" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <header className="border-b border-line bg-paper">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <Link
            href="/"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
            title="Início"
          >
            <Home className="h-4 w-4" />
          </Link>
          <div className="flex-1">
            <h1 className="text-base font-bold tracking-tight text-ink">
              Separação
            </h1>
            <p className="text-[11px] text-ink-faint">
              Separação física por galpão
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5">
              <span className="font-mono text-xs font-semibold text-ink">
                {user.nome}
              </span>
              <span className="text-[10px] text-ink-faint">
                {CARGO_LABELS[user.cargo]}
              </span>
            </div>
            <button
              type="button"
              onClick={logout}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
              title="Sair"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-4">
        {/* Admin galpão selector */}
        {isAdmin && galpoes && galpoes.length > 0 && (
          <div className="flex items-center gap-2">
            <label
              htmlFor="galpao-select"
              className="text-xs font-medium text-ink-muted"
            >
              Galpão:
            </label>
            <div className="relative">
              <select
                id="galpao-select"
                value={effectiveGalpaoId ?? ""}
                onChange={(e) => setSelectedGalpaoId(e.target.value)}
                className="appearance-none rounded-lg border border-line bg-paper py-1.5 pl-3 pr-8 text-sm font-semibold text-ink focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              >
                {galpoes.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.nome}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
                aria-hidden="true"
              />
            </div>
          </div>
        )}

        {/* Tabs */}
        <Tabs
          tabs={tabs}
          activeTab={activeTab}
          onChange={(id) => setActiveTab(id as TabId)}
        />

        {/* Tab content */}
        {activeTab === "pendentes" && (
          <TabPendentes
            pedidos={grouped.pendentes}
            onBipProcessed={() => refetch()}
          />
        )}
        {activeTab === "aguardando_nf" && (
          <TabAguardandoNf
            pedidos={grouped.aguardando_nf}
            onUpdated={() => refetch()}
          />
        )}
        {activeTab === "embalados" && (
          <TabEmbalados
            pedidos={grouped.embalados}
            onUpdated={() => refetch()}
          />
        )}
        {activeTab === "expedidos" && (
          <TabExpedidos pedidos={grouped.expedidos} />
        )}
      </main>
    </div>
  );
}
