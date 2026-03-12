"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ShoppingCart, XCircle } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Tabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { FornecedorCard } from "@/components/compras/fornecedor-card";
import { OrdemCompraCard } from "@/components/compras/ordem-compra-card";
import { useAuth } from "@/lib/auth-context";

import type { Tab, CompraItemAgrupado } from "@/types";

type CompraTab = "aguardando_compra" | "comprado" | "indisponivel";

interface ComprasCounts {
  aguardando_compra: number;
  comprado: number;
  indisponivel: number;
}

interface FornecedorGroup {
  fornecedor: string;
  empresa_id: string | null;
  itens: CompraItemAgrupado[];
}

interface OcData {
  id: string;
  fornecedor: string;
  status: string;
  observacao: string | null;
  comprado_por_nome: string | null;
  comprado_em: string | null;
  total_itens: number;
  itens_recebidos: number;
  itens: Array<{
    id: string;
    sku: string;
    descricao: string;
    quantidade: number;
    compra_status: string | null;
    compra_quantidade_recebida: number;
    pedido_id: string;
    numero_pedido: string;
  }>;
}

interface ComprasResponse {
  counts: ComprasCounts;
  data: unknown[];
}

const ALLOWED_CARGOS = ["admin", "comprador"];

async function fetchCompras(
  status: CompraTab,
  cargo: string,
): Promise<ComprasResponse> {
  const res = await fetch(`/api/compras?status=${status}&cargo=${cargo}`);
  if (res.status === 403) throw new Error("Acesso negado");
  if (!res.ok) throw new Error("Erro ao carregar compras");
  return res.json();
}

export default function ComprasPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<CompraTab>("aguardando_compra");

  const cargo = user?.cargo ?? "";
  const allowed = ALLOWED_CARGOS.includes(cargo);

  const { data, isLoading, isRefetching } = useQuery({
    queryKey: ["compras", activeTab, cargo],
    queryFn: () => fetchCompras(activeTab, cargo),
    enabled: !!user && allowed,
    refetchInterval: 30_000,
  });

  const counts = data?.counts ?? {
    aguardando_compra: 0,
    comprado: 0,
    indisponivel: 0,
  };
  const items = (data?.data ?? []) as unknown[];

  const tabs: Tab[] = [
    {
      id: "aguardando_compra",
      label: "Aguardando Compra",
      count: counts.aguardando_compra,
    },
    { id: "comprado", label: "Comprado", count: counts.comprado },
    { id: "indisponivel", label: "Indisponíveis", count: counts.indisponivel },
  ];

  const emptyMessages: Record<CompraTab, string> = {
    aguardando_compra: "Nenhum item aguardando compra.",
    comprado: "Nenhuma ordem de compra aguardando entrega.",
    indisponivel: "Nenhum item indisponível.",
  };

  const headerRight = (
    <button
      type="button"
      onClick={() =>
        queryClient.invalidateQueries({ queryKey: ["compras"] })
      }
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
      title="Atualizar"
    >
      <RefreshCw
        className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`}
      />
    </button>
  );

  return (
    <AppShell
      title="Compras"
      subtitle="Ordens de Compra"
      backHref="/"
      headerRight={allowed ? headerRight : undefined}
    >
      {!allowed ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16">
          <ShoppingCart className="h-8 w-8 text-ink-faint" />
          <p className="text-sm text-ink-faint">
            Acesso negado. Apenas administradores e compradores podem acessar
            esta página.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-5">
            <Tabs
              tabs={tabs}
              activeTab={activeTab}
              onChange={(id) => setActiveTab(id as CompraTab)}
            />
          </div>

          {isLoading ? (
            <LoadingSpinner message="Carregando compras..." />
          ) : items.length === 0 ? (
            <EmptyState message={emptyMessages[activeTab]} />
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-ink-faint">
                {items.length}{" "}
                {activeTab === "comprado"
                  ? `ordem${items.length !== 1 ? "s" : ""}`
                  : activeTab === "aguardando_compra"
                    ? `fornecedor${items.length !== 1 ? "es" : ""}`
                    : `item${items.length !== 1 ? "s" : ""}`}
              </p>
              {activeTab === "aguardando_compra" &&
                (items as FornecedorGroup[]).map((group) => (
                  <FornecedorCard
                    key={group.fornecedor}
                    fornecedor={group.fornecedor}
                    empresa_id={group.empresa_id}
                    itens={group.itens}
                    usuario_id={user!.id}
                    cargo={cargo}
                  />
                ))}
              {activeTab === "comprado" &&
                (items as OcData[]).map((oc, idx) => (
                  <OrdemCompraCard
                    key={oc.id}
                    id={oc.id}
                    index={idx + 1}
                    fornecedor={oc.fornecedor}
                    status={oc.status}
                    observacao={oc.observacao}
                    comprado_por_nome={oc.comprado_por_nome}
                    comprado_em={oc.comprado_em}
                    total_itens={oc.total_itens}
                    itens_recebidos={oc.itens_recebidos}
                    itens={oc.itens}
                  />
                ))}
              {activeTab === "indisponivel" &&
                (
                  items as Array<{
                    id: string;
                    sku: string;
                    descricao: string;
                    quantidade: number;
                    fornecedor_oc: string | null;
                    pedido_id: string;
                    numero_pedido: string;
                  }>
                ).map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-line bg-paper px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink truncate">
                        {item.sku}
                      </p>
                      <p className="text-xs text-ink-muted truncate">
                        {item.descricao}
                      </p>
                      {item.fornecedor_oc && (
                        <p className="text-xs text-ink-faint mt-0.5">
                          Fornecedor: {item.fornecedor_oc}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-sm font-semibold text-ink tabular-nums">
                        {item.quantidade}un
                      </span>
                      <span className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                        #{item.numero_pedido}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">
                        <XCircle className="h-3 w-3" />
                        Indisponível
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
