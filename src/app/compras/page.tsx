"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ShoppingCart } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Tabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { FornecedorCard } from "@/components/compras/fornecedor-card";
import { OrdemCompraCard } from "@/components/compras/ordem-compra-card";
import { ExceptionItemCard } from "@/components/compras/exception-item-card";
import { useAuth } from "@/lib/auth-context";

import type { Tab, CompraItemAgrupado } from "@/types";

type CompraTab = "aguardando_compra" | "comprado" | "excecoes";

interface ComprasCounts {
  aguardando_compra: number;
  comprado: number;
  indisponivel: number;
}

interface FornecedorGroup {
  fornecedor: string;
  empresa_id: string | null;
  empresa_nome: string | null;
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

  const cargos = user?.cargos ?? (user?.cargo ? [user.cargo] : []);
  const cargo = cargos.find((c) => ALLOWED_CARGOS.includes(c)) ?? "";
  const allowed = cargo !== "";

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
    { id: "excecoes", label: "Exceções", count: counts.indisponivel },
  ];

  const emptyMessages: Record<CompraTab, string> = {
    aguardando_compra: "Nenhum item aguardando compra.",
    comprado: "Nenhuma ordem de compra aguardando entrega.",
    excecoes: "Nenhuma exceção de compra.",
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
                    ? `grupo${items.length !== 1 ? "s" : ""}`
                    : `exce${items.length !== 1 ? "ões" : "ção"}`}
              </p>
              {activeTab === "aguardando_compra" &&
                (items as FornecedorGroup[]).map((group) => (
                  <FornecedorCard
                    key={`${group.fornecedor}-${group.empresa_id ?? "sem-empresa"}`}
                    fornecedor={group.fornecedor}
                    empresa_id={group.empresa_id}
                    empresa_nome={group.empresa_nome}
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
                    cargo={cargo}
                  />
                ))}
              {activeTab === "excecoes" &&
                (
                  items as Array<{
                    id: string;
                    sku: string;
                    descricao: string;
                    imagem: string | null;
                    quantidade: number;
                    fornecedor_oc: string | null;
                    pedido_id: string;
                    numero_pedido: string;
                    empresa_nome: string | null;
                    compra_status: string | null;
                    compra_equivalente_sku: string | null;
                    compra_equivalente_descricao: string | null;
                    compra_equivalente_fornecedor: string | null;
                    compra_equivalente_observacao: string | null;
                    compra_cancelamento_motivo: string | null;
                  }>
                ).map((item) => (
                  <ExceptionItemCard
                    key={item.id}
                    item={item}
                    cargo={cargo}
                    usuario_id={user!.id}
                  />
                ))}
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
