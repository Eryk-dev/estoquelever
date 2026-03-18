"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Clock3,
  Filter,
  RefreshCw,
  Search,
  ShoppingCart,
} from "lucide-react";

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
type Prioridade = "critica" | "alta" | "normal";
type PrioridadeFilter = "todas" | Prioridade;
type AgingFilter = "todos" | "hoje" | "1-2" | "3+";

interface ComprasCounts {
  aguardando_compra: number;
  comprado: number;
  indisponivel: number;
}

interface SummaryItem {
  nome: string | null;
  quantidade: number;
  pedidos: number;
  empresa_id?: string | null;
}

interface ComprasSummary {
  itens_pendentes: number;
  quantidade_pendente: number;
  pedidos_bloqueados: number;
  empresas_em_compra: number;
  ocs_abertas: number;
  excecoes: number;
  mais_antigo_dias: number;
  gargalos_fornecedor: SummaryItem[];
  gargalos_empresa: SummaryItem[];
}

interface FornecedorGroup {
  fornecedor: string;
  empresa_id: string | null;
  empresa_nome: string | null;
  prioridade: Prioridade;
  aging_dias: number;
  pedidos_bloqueados: number;
  quantidade_total: number;
  total_skus: number;
  rascunho_ocs: number;
  itens_em_rascunho: number;
  proxima_acao: string;
  itens: CompraItemAgrupado[];
}

interface OcData {
  id: string;
  fornecedor: string;
  empresa_nome: string | null;
  status: string;
  observacao: string | null;
  comprado_por_nome: string | null;
  comprado_em: string | null;
  aging_dias: number;
  prioridade: Prioridade;
  pedidos_bloqueados: number;
  quantidade_total: number;
  quantidade_recebida: number;
  total_itens: number;
  itens_recebidos: number;
  proxima_acao: string;
  itens: Array<{
    id: string;
    sku: string;
    descricao: string;
    imagem: string | null;
    quantidade: number;
    compra_status: string | null;
    compra_quantidade_recebida: number;
    pedido_id: string;
    numero_pedido: string;
    aging_dias: number;
  }>;
}

interface ExceptionData {
  id: string;
  sku: string;
  descricao: string;
  imagem: string | null;
  quantidade: number;
  aging_dias: number;
  prioridade: Prioridade;
  proxima_acao: string;
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
}

interface ComprasResponse {
  counts: ComprasCounts;
  summary: ComprasSummary;
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

function normalizeText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function matchesAging(days: number, filter: AgingFilter) {
  if (filter === "todos") return true;
  if (filter === "hoje") return days === 0;
  if (filter === "1-2") return days >= 1 && days <= 2;
  return days >= 3;
}

function formatDays(days: number) {
  if (days <= 0) return "Hoje";
  if (days === 1) return "1 dia";
  return `${days} dias`;
}

const EXCEPTION_META = {
  equivalente_pendente: {
    title: "Intercambiáveis aguardando confirmação",
    description: "Itens com SKU alternativo já definido, mas ainda dependentes de ajuste externo.",
  },
  cancelamento_pendente: {
    title: "Cancelamentos pendentes",
    description: "Itens que precisam ser removidos ou cancelados fora do SISO antes de liberar o pedido.",
  },
  indisponivel: {
    title: "Indisponíveis sem saída",
    description: "Itens travados que ainda exigem decisão do comprador.",
  },
} as const;

export default function ComprasPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<CompraTab>("aguardando_compra");
  const [search, setSearch] = useState("");
  const [empresaFilter, setEmpresaFilter] = useState("todas");
  const [prioridadeFilter, setPrioridadeFilter] = useState<PrioridadeFilter>("todas");
  const [agingFilter, setAgingFilter] = useState<AgingFilter>("todos");
  const deferredSearch = useDeferredValue(search);

  const cargos = user?.cargos ?? (user?.cargo ? [user.cargo] : []);
  const cargo = cargos.find((c) => ALLOWED_CARGOS.includes(c)) ?? "";
  const allowed = cargo !== "";

  const { data, error, isError, isLoading, isRefetching } = useQuery({
    queryKey: ["compras", activeTab, cargo],
    queryFn: () => fetchCompras(activeTab, cargo),
    enabled: !!user && allowed,
    refetchInterval: 30_000,
  });
  const queryError = error instanceof Error ? error.message : "Erro ao carregar compras";

  const counts = data?.counts ?? {
    aguardando_compra: 0,
    comprado: 0,
    indisponivel: 0,
  };
  const summary = data?.summary ?? {
    itens_pendentes: 0,
    quantidade_pendente: 0,
    pedidos_bloqueados: 0,
    empresas_em_compra: 0,
    ocs_abertas: 0,
    excecoes: 0,
    mais_antigo_dias: 0,
    gargalos_fornecedor: [],
    gargalos_empresa: [],
  };
  const items = useMemo(() => (data?.data ?? []) as unknown[], [data?.data]);

  const tabs: Tab[] = [
    {
      id: "aguardando_compra",
      label: "Planejamento",
      count: counts.aguardando_compra,
    },
    { id: "comprado", label: "OCs Em Aberto", count: counts.comprado },
    { id: "excecoes", label: "Intercambiáveis / Exceções", count: counts.indisponivel },
  ];

  const emptyMessages: Record<CompraTab, string> = {
    aguardando_compra: "Nenhuma demanda aguardando decisão de compra.",
    comprado: "Nenhuma ordem de compra aberta.",
    excecoes: "Nenhum item bloqueado por intercambiável ou exceção.",
  };

  const empresaOptions = useMemo(() => {
    const map = new Map<string, string>();
    if (activeTab === "aguardando_compra") {
      for (const group of items as FornecedorGroup[]) {
        if (group.empresa_id) map.set(group.empresa_id, group.empresa_nome ?? group.empresa_id);
      }
    } else if (activeTab === "comprado") {
      for (const oc of items as OcData[]) {
        if (oc.empresa_nome) map.set(oc.empresa_nome, oc.empresa_nome);
      }
    } else {
      for (const item of items as ExceptionData[]) {
        if (item.empresa_nome) map.set(item.empresa_nome, item.empresa_nome);
      }
    }
    return [...map.entries()].map(([value, label]) => ({ value, label })).sort((a, b) =>
      a.label.localeCompare(b.label, "pt-BR"),
    );
  }, [activeTab, items]);

  const filteredItems = useMemo(() => {
    const searchTerm = normalizeText(deferredSearch);

    if (activeTab === "aguardando_compra") {
      return (items as FornecedorGroup[]).filter((group) => {
        if (empresaFilter !== "todas" && group.empresa_id !== empresaFilter) return false;
        if (prioridadeFilter !== "todas" && group.prioridade !== prioridadeFilter) return false;
        if (!matchesAging(group.aging_dias, agingFilter)) return false;

        if (!searchTerm) return true;

        const haystack = normalizeText(
          [
            group.fornecedor,
            group.empresa_nome,
            group.proxima_acao,
            ...group.itens.flatMap((item) => [
              item.sku,
              item.descricao,
              ...item.pedidos.map((pedido) => pedido.numero_pedido),
            ]),
          ].join(" "),
        );
        return haystack.includes(searchTerm);
      });
    }

    if (activeTab === "comprado") {
      return (items as OcData[]).filter((oc) => {
        if (empresaFilter !== "todas" && oc.empresa_nome !== empresaFilter) return false;
        if (prioridadeFilter !== "todas" && oc.prioridade !== prioridadeFilter) return false;
        if (!matchesAging(oc.aging_dias, agingFilter)) return false;

        if (!searchTerm) return true;

        const haystack = normalizeText(
          [
            oc.fornecedor,
            oc.empresa_nome,
            oc.proxima_acao,
            ...oc.itens.flatMap((item) => [
              item.sku,
              item.descricao,
              item.numero_pedido,
            ]),
          ].join(" "),
        );
        return haystack.includes(searchTerm);
      });
    }

    return (items as ExceptionData[]).filter((item) => {
      if (empresaFilter !== "todas" && item.empresa_nome !== empresaFilter) return false;
      if (prioridadeFilter !== "todas" && item.prioridade !== prioridadeFilter) return false;
      if (!matchesAging(item.aging_dias, agingFilter)) return false;

      if (!searchTerm) return true;

      const haystack = normalizeText(
        [
          item.sku,
          item.descricao,
          item.fornecedor_oc,
          item.numero_pedido,
          item.proxima_acao,
        ].join(" "),
      );
      return haystack.includes(searchTerm);
    });
  }, [activeTab, agingFilter, deferredSearch, empresaFilter, items, prioridadeFilter]);

  const exceptionSections = useMemo(() => {
    if (activeTab !== "excecoes") return [];

    const grouped = new Map<string, ExceptionData[]>();
    for (const item of filteredItems as ExceptionData[]) {
      const key = item.compra_status ?? "indisponivel";
      const current = grouped.get(key) ?? [];
      current.push(item);
      grouped.set(key, current);
    }

    return ["equivalente_pendente", "cancelamento_pendente", "indisponivel"]
      .map((status) => ({
        status,
        title: EXCEPTION_META[status as keyof typeof EXCEPTION_META].title,
        description: EXCEPTION_META[status as keyof typeof EXCEPTION_META].description,
        items: grouped.get(status) ?? [],
      }))
      .filter((section) => section.items.length > 0);
  }, [activeTab, filteredItems]);

  const headerRight = (
    <button
      type="button"
      onClick={() =>
        queryClient.invalidateQueries({ queryKey: ["compras"] })
      }
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint hover:bg-surface hover:text-ink"
      title="Atualizar"
    >
      <RefreshCw className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} />
    </button>
  );

  return (
    <AppShell
      title="Compras"
      subtitle="Operação do comprador"
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
      ) : isError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-6 py-10">
          <div className="flex items-center gap-2 text-red-700">
            <AlertTriangle className="h-5 w-5" />
            <p className="text-sm font-semibold">Falha ao carregar compras</p>
          </div>
          <p className="mt-2 text-sm text-red-700/90">{queryError}</p>
          <button
            type="button"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["compras"] })}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-red-200 bg-paper px-4 py-2 text-sm font-medium text-red-700 hover:bg-white"
          >
            <RefreshCw className="h-4 w-4" />
            Tentar novamente
          </button>
        </div>
      ) : isLoading ? (
        <LoadingSpinner message="Carregando compras..." />
      ) : (
        <>
          <section className="mb-5 overflow-hidden rounded-2xl border border-line bg-[linear-gradient(135deg,rgba(244,244,245,0.95),rgba(255,255,255,1)_60%)] p-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <div className="rounded-xl border border-line bg-paper px-3 py-3">
                <p className="text-[11px] uppercase tracking-wide text-ink-faint">Itens pendentes</p>
                <p className="mt-1 text-2xl font-semibold text-ink">{summary.itens_pendentes}</p>
              </div>
              <div className="rounded-xl border border-line bg-paper px-3 py-3">
                <p className="text-[11px] uppercase tracking-wide text-ink-faint">Pedidos travados</p>
                <p className="mt-1 text-2xl font-semibold text-ink">{summary.pedidos_bloqueados}</p>
              </div>
              <div className="rounded-xl border border-line bg-paper px-3 py-3">
                <p className="text-[11px] uppercase tracking-wide text-ink-faint">Quantidade</p>
                <p className="mt-1 text-2xl font-semibold text-ink">{summary.quantidade_pendente} un</p>
              </div>
              <div className="rounded-xl border border-line bg-paper px-3 py-3">
                <p className="text-[11px] uppercase tracking-wide text-ink-faint">OCs abertas</p>
                <p className="mt-1 text-2xl font-semibold text-ink">{summary.ocs_abertas}</p>
              </div>
              <div className="rounded-xl border border-line bg-paper px-3 py-3">
                <p className="text-[11px] uppercase tracking-wide text-ink-faint">Empresas</p>
                <p className="mt-1 text-2xl font-semibold text-ink">{summary.empresas_em_compra}</p>
              </div>
              <div className="rounded-xl border border-line bg-paper px-3 py-3">
                <p className="text-[11px] uppercase tracking-wide text-ink-faint">Mais antigo</p>
                <p className="mt-1 flex items-center gap-1 text-2xl font-semibold text-ink">
                  <Clock3 className="h-5 w-5 text-ink-faint" />
                  {formatDays(summary.mais_antigo_dias)}
                </p>
              </div>
            </div>
          </section>

          <div className="mb-4">
            <Tabs
              tabs={tabs}
              activeTab={activeTab}
              onChange={(id) => setActiveTab(id as CompraTab)}
            />
          </div>

          <section className="mb-5 rounded-2xl border border-line bg-paper p-4">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-ink-faint" />
              <h3 className="text-sm font-semibold text-ink">Filtrar operação</h3>
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.6fr),repeat(3,minmax(0,1fr))]">
              <label className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar fornecedor, SKU, pedido ou ação"
                  className="w-full rounded-xl border border-line bg-surface py-2 pl-10 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
                />
              </label>

              <select
                value={empresaFilter}
                onChange={(e) => setEmpresaFilter(e.target.value)}
                className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
              >
                <option value="todas">Todas as empresas</option>
                {empresaOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>

              <select
                value={prioridadeFilter}
                onChange={(e) => setPrioridadeFilter(e.target.value as PrioridadeFilter)}
                className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
              >
                <option value="todas">Todas as prioridades</option>
                <option value="critica">Crítica</option>
                <option value="alta">Alta</option>
                <option value="normal">Normal</option>
              </select>

              <select
                value={agingFilter}
                onChange={(e) => setAgingFilter(e.target.value as AgingFilter)}
                className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
              >
                <option value="todos">Todo aging</option>
                <option value="hoje">Hoje</option>
                <option value="1-2">1 a 2 dias</option>
                <option value="3+">3 dias ou mais</option>
              </select>
            </div>
          </section>

          {items.length === 0 ? (
            <EmptyState message={emptyMessages[activeTab]} />
          ) : filteredItems.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line bg-paper px-6 py-10 text-center">
              <AlertTriangle className="mx-auto h-6 w-6 text-ink-faint" />
              <p className="mt-3 text-sm text-ink-muted">
                Nenhum resultado com os filtros atuais.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-ink-faint">
                {filteredItems.length} resultado{filteredItems.length !== 1 ? "s" : ""} exibido{filteredItems.length !== 1 ? "s" : ""} ·{" "}
                {summary.excecoes} {summary.excecoes === 1 ? "exceção" : "exceções"} no fluxo ·{" "}
                {formatDays(summary.mais_antigo_dias)} no item mais antigo
              </p>

              {activeTab === "aguardando_compra" && (
                <section className="rounded-2xl border border-line bg-surface/40 px-4 py-4">
                  <h3 className="text-sm font-semibold text-ink">Planejamento por fornecedor</h3>
                  <p className="mt-1 text-sm text-ink-muted">
                    Abra só o fornecedor que vai trabalhar agora. Dentro dele, selecione a rodada e confirme a OC.
                  </p>
                </section>
              )}

              {activeTab === "aguardando_compra" &&
                (filteredItems as FornecedorGroup[]).map((group) => (
                  <FornecedorCard
                    key={`${group.fornecedor}-${group.empresa_id ?? "sem-empresa"}`}
                    fornecedor={group.fornecedor}
                    empresa_id={group.empresa_id}
                    empresa_nome={group.empresa_nome}
                    prioridade={group.prioridade}
                    aging_dias={group.aging_dias}
                    pedidos_bloqueados={group.pedidos_bloqueados}
                    quantidade_total={group.quantidade_total}
                    total_skus={group.total_skus}
                    rascunho_ocs={group.rascunho_ocs}
                    itens_em_rascunho={group.itens_em_rascunho}
                    proxima_acao={group.proxima_acao}
                    itens={group.itens}
                    usuario_id={user!.id}
                    cargo={cargo}
                  />
                ))}

              {activeTab === "comprado" &&
                (filteredItems as OcData[]).map((oc, idx) => (
                  <OrdemCompraCard
                    key={oc.id}
                    id={oc.id}
                    index={idx + 1}
                    fornecedor={oc.fornecedor}
                    empresa_nome={oc.empresa_nome}
                    status={oc.status}
                    observacao={oc.observacao}
                    comprado_por_nome={oc.comprado_por_nome}
                    comprado_em={oc.comprado_em}
                    aging_dias={oc.aging_dias}
                    prioridade={oc.prioridade}
                    pedidos_bloqueados={oc.pedidos_bloqueados}
                    quantidade_total={oc.quantidade_total}
                    quantidade_recebida={oc.quantidade_recebida}
                    total_itens={oc.total_itens}
                    itens_recebidos={oc.itens_recebidos}
                    proxima_acao={oc.proxima_acao}
                    itens={oc.itens}
                    cargo={cargo}
                  />
                ))}

              {activeTab === "excecoes" &&
                exceptionSections.map((section) => (
                  <section
                    key={section.status}
                    className="rounded-2xl border border-line bg-paper p-4"
                  >
                    <div className="flex flex-col gap-1 border-b border-line pb-3">
                      <h3 className="text-sm font-semibold text-ink">{section.title}</h3>
                      <p className="text-xs text-ink-muted">{section.description}</p>
                    </div>
                    <div className="mt-4 flex flex-col gap-3">
                      {section.items.map((item) => (
                        <ExceptionItemCard
                          key={item.id}
                          item={item}
                          cargo={cargo}
                          usuario_id={user!.id}
                        />
                      ))}
                    </div>
                  </section>
                ))}
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
