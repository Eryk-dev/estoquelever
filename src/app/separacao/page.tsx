"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Home, LogOut } from "lucide-react";
import Link from "next/link";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { Tabs } from "@/components/ui/tabs";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import {
  SeparacaoCard,
  type SeparacaoPedido,
} from "@/components/separacao/separacao-card";
import { CARGO_LABELS } from "@/types";
import type { Tab, StatusSeparacao, SeparacaoCounts } from "@/types";

// 5 tabs mapping 1:1 to StatusSeparacao values
const TAB_CONFIG: {
  id: StatusSeparacao;
  label: string;
  emptyMessage: string;
}[] = [
  {
    id: "aguardando_nf",
    label: "Aguardando NF",
    emptyMessage: "Nenhum pedido aguardando nota fiscal",
  },
  {
    id: "aguardando_separacao",
    label: "Aguardando Separação",
    emptyMessage: "Nenhum pedido aguardando separação",
  },
  {
    id: "em_separacao",
    label: "Em Separação",
    emptyMessage: "Nenhum pedido em separação",
  },
  {
    id: "separado",
    label: "Separados",
    emptyMessage: "Nenhum pedido separado",
  },
  {
    id: "embalado",
    label: "Embalados",
    emptyMessage: "Nenhum pedido embalado",
  },
];

const EMPTY_COUNTS: SeparacaoCounts = {
  aguardando_nf: 0,
  aguardando_separacao: 0,
  em_separacao: 0,
  separado: 0,
  embalado: 0,
};

interface SeparacaoResponse {
  counts: SeparacaoCounts;
  pedidos: SeparacaoPedido[];
}

export default function SeparacaoPage() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<StatusSeparacao>("aguardando_separacao");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

  const canFetch = !loading && !!user;

  // Fetch pedidos for active tab + counts for all tabs
  const {
    data,
    isLoading: isFetching,
  } = useQuery<SeparacaoResponse>({
    queryKey: ["separacao", activeTab],
    queryFn: async () => {
      const params = new URLSearchParams({ status_separacao: activeTab });
      const res = await sisoFetch(`/api/separacao?${params}`);
      if (!res.ok) return { counts: EMPTY_COUNTS, pedidos: [] };
      return res.json();
    },
    enabled: canFetch,
    refetchInterval: 10000,
  });

  const counts = data?.counts ?? EMPTY_COUNTS;
  const pedidos = data?.pedidos ?? [];

  const activeConfig = TAB_CONFIG.find((t) => t.id === activeTab)!;

  const tabs: Tab[] = TAB_CONFIG.map((t) => ({
    id: t.id,
    label: t.label,
    count: counts[t.id as keyof SeparacaoCounts] ?? 0,
  }));

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
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
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

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-4">
        {/* Tabs — horizontal scroll on mobile */}
        <div className="overflow-x-auto">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onChange={(id) => {
              setActiveTab(id as StatusSeparacao);
              setSelectedIds(new Set());
            }}
          />
        </div>

        {/* Tab content */}
        {isFetching ? (
          <LoadingSpinner message="Carregando pedidos..." />
        ) : pedidos.length === 0 ? (
          <EmptyState message={activeConfig.emptyMessage} />
        ) : (
          <div className="space-y-2">
            {pedidos.map((pedido) => {
              const showCheckbox =
                activeTab === "aguardando_separacao" ||
                activeTab === "separado";
              return (
                <SeparacaoCard
                  key={pedido.id}
                  pedido={pedido}
                  checkbox={showCheckbox}
                  checked={selectedIds.has(pedido.id)}
                  onToggle={toggleSelected}
                />
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
