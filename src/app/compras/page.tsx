"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Package } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Tabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { sisoFetch } from "@/lib/auth-context";

import { FornecedorComprarCard } from "@/components/compras/fornecedor-comprar-card";
import { FornecedorReceberCard } from "@/components/compras/fornecedor-receber-card";
import { ExcecoesBanner } from "@/components/compras/excecoes-banner";
import { ProgressModal } from "@/components/compras/progress-modal";
import { formatDate } from "@/components/compras/compras-helpers";

// ─── Types ──────────────────────────────────────────────────────────────────

type TabId = "comprar" | "receber" | "historico";

interface Counts {
  comprar: number;
  receber: number;
  excecoes: number;
  historico: number;
  pedidos_bloqueados: number;
}

interface ComprarResponse {
  counts: Counts;
  fornecedores: Array<{
    fornecedor: string;
    galpao_sugerido_id: string | null;
    galpao_sugerido_nome: string | null;
    skus_count: number;
    pedidos_bloqueados: number;
    aging_dias: number;
    itens: Array<{
      sku: string;
      descricao: string;
      imagem_url: string | null;
      quantidade_necessaria: number;
      aging_dias: number;
      pedidos: Array<{
        pedido_id: string;
        numero: string;
        cliente_nome: string;
        quantidade: number;
        aging_dias: number;
        item_id: string;
      }>;
    }>;
  }>;
  excecoes: Array<{
    id: string;
    sku: string;
    descricao: string;
    imagem_url: string | null;
    compra_status: string;
    quantidade: number;
    aging_dias: number;
    fornecedor_oc: string | null;
    pedido_id: string;
    numero_pedido: string;
    compra_equivalente_sku: string | null;
    compra_equivalente_descricao: string | null;
    compra_equivalente_fornecedor: string | null;
    compra_equivalente_observacao: string | null;
    compra_cancelamento_motivo: string | null;
  }>;
}

interface ReceberResponse {
  counts: Counts;
  fornecedores: Array<{
    fornecedor: string;
    galpao_sugerido_nome: string | null;
    skus_count: number;
    pendente_count: number;
    aging_dias: number;
    itens: Array<{
      sku: string;
      descricao: string;
      imagem_url: string | null;
      quantidade_comprada: number;
      quantidade_recebida: number;
      quantidade_pendente: number;
      aging_dias: number;
      comprado_em: string | null;
      pedidos: Array<{
        pedido_id: string;
        numero: string;
        cliente_nome: string;
        quantidade: number;
        aging_dias: number;
        item_id: string;
      }>;
    }>;
  }>;
}

interface HistoricoResponse {
  counts: Counts;
  fornecedores: Array<{
    fornecedor: string;
    data_recebimento: string;
    itens: Array<{
      sku: string;
      descricao: string;
      quantidade_recebida: number;
      recebido_em: string | null;
    }>;
  }>;
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ComprasPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabId>("comprar");
  const [progressPedidos, setProgressPedidos] = useState<string[] | null>(null);

  // Queries — only fetch active tab
  const comprarQuery = useQuery<ComprarResponse>({
    queryKey: ["compras", "comprar"],
    queryFn: () => sisoFetch("/api/compras?tab=comprar").then((r) => r.json()),
    enabled: tab === "comprar",
    refetchInterval: 30_000,
  });

  const receberQuery = useQuery<ReceberResponse>({
    queryKey: ["compras", "receber"],
    queryFn: () => sisoFetch("/api/compras?tab=receber").then((r) => r.json()),
    enabled: tab === "receber",
    refetchInterval: 30_000,
  });

  const historicoQuery = useQuery<HistoricoResponse>({
    queryKey: ["compras", "historico"],
    queryFn: () => sisoFetch("/api/compras?tab=historico").then((r) => r.json()),
    enabled: tab === "historico",
    refetchInterval: 60_000,
  });

  // Counts from whichever query loaded
  const counts = comprarQuery.data?.counts ?? receberQuery.data?.counts ?? historicoQuery.data?.counts;

  const tabs = [
    { id: "comprar", label: "Comprar", count: counts?.comprar ?? 0 },
    { id: "receber", label: "Aguardando recebimento", count: counts?.receber ?? 0 },
    { id: "historico", label: "Recebidos", count: counts?.historico ?? 0 },
  ];

  function handleRecebimentoConcluido(pedidos: string[]) {
    setProgressPedidos(pedidos);
  }

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["compras"] });
  }

  return (
    <AppShell title="Compras">
      <div className="space-y-4">
        {/* Summary */}
        {counts && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-muted">
            <span>{counts.pedidos_bloqueados} pedido{counts.pedidos_bloqueados !== 1 ? "s" : ""} bloqueado{counts.pedidos_bloqueados !== 1 ? "s" : ""}</span>
            {counts.excecoes > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                {counts.excecoes} {counts.excecoes === 1 ? "excecao" : "excecoes"}
              </span>
            )}
          </div>
        )}

        {/* Tabs */}
        <Tabs tabs={tabs} activeTab={tab} onChange={(id) => setTab(id as TabId)} />

        {/* Tab: Comprar */}
        {tab === "comprar" && (
          <>
            {comprarQuery.isLoading && <LoadingSpinner message="Carregando itens..." />}
            {comprarQuery.isError && (
              <p className="py-8 text-center text-sm text-red-600">Erro ao carregar</p>
            )}
            {comprarQuery.data && (
              <div className="space-y-3">
                {/* Excecoes banner */}
                {comprarQuery.data.excecoes.length > 0 && (
                  <ExcecoesBanner
                    excecoes={comprarQuery.data.excecoes}
                    onMutated={invalidateAll}
                  />
                )}

                {/* Fornecedor cards */}
                {comprarQuery.data.fornecedores.length === 0 ? (
                  <EmptyState message="Nenhum item para comprar" />
                ) : (
                  comprarQuery.data.fornecedores.map((f) => (
                    <FornecedorComprarCard key={f.fornecedor} fornecedor={f} />
                  ))
                )}
              </div>
            )}
          </>
        )}

        {/* Tab: Receber */}
        {tab === "receber" && (
          <>
            {receberQuery.isLoading && <LoadingSpinner message="Carregando itens..." />}
            {receberQuery.isError && (
              <p className="py-8 text-center text-sm text-red-600">Erro ao carregar</p>
            )}
            {receberQuery.data && (
              <div className="space-y-3">
                {receberQuery.data.fornecedores.length === 0 ? (
                  <EmptyState message="Nenhum item aguardando recebimento" />
                ) : (
                  receberQuery.data.fornecedores.map((f) => (
                    <FornecedorReceberCard
                      key={f.fornecedor}
                      fornecedor={f}
                      onRecebimentoConcluido={handleRecebimentoConcluido}
                    />
                  ))
                )}
              </div>
            )}
          </>
        )}

        {/* Tab: Historico */}
        {tab === "historico" && (
          <>
            {historicoQuery.isLoading && <LoadingSpinner message="Carregando historico..." />}
            {historicoQuery.isError && (
              <p className="py-8 text-center text-sm text-red-600">Erro ao carregar</p>
            )}
            {historicoQuery.data && (
              <div className="space-y-3">
                {historicoQuery.data.fornecedores.length === 0 ? (
                  <EmptyState message="Nenhum recebimento registrado" />
                ) : (
                  historicoQuery.data.fornecedores.map((group, i) => (
                    <div
                      key={`${group.fornecedor}-${group.data_recebimento}-${i}`}
                      className="overflow-hidden rounded-xl border border-line bg-paper"
                    >
                      <div className="flex items-center justify-between bg-zinc-50 px-4 py-2.5">
                        <h3 className="text-xs font-semibold text-ink">{group.fornecedor}</h3>
                        <span className="text-[10px] text-ink-muted">
                          {formatDate(group.data_recebimento)}
                        </span>
                      </div>
                      <div className="divide-y divide-line/60">
                        {group.itens.map((item, j) => (
                          <div key={`${item.sku}-${j}`} className="flex items-center gap-3 px-4 py-2.5">
                            <Package className="h-4 w-4 shrink-0 text-ink-faint" />
                            <div className="min-w-0 flex-1">
                              <span className="font-mono text-xs font-semibold text-ink">
                                {item.sku}
                              </span>
                              <p className="truncate text-[11px] text-ink-muted">
                                {item.descricao}
                              </p>
                            </div>
                            <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                              {item.quantidade_recebida} un
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Progress Modal */}
      {progressPedidos && (
        <ProgressModal
          pedidoIds={progressPedidos}
          onClose={() => {
            setProgressPedidos(null);
            invalidateAll();
          }}
        />
      )}
    </AppShell>
  );
}
