"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { sisoFetch, useAuth } from "@/lib/auth-context";
import {
  Icon,
  PageHeader,
  Pagination,
  StatusBadge,
} from "@/components/wms/ui/wms-ui";
import { formatRelativeTime, getMarketplaceName } from "@/lib/domain-helpers";

type Tab = "pendentes" | "em_separacao" | "baixados" | "concluidos" | "full";

interface ResumoItens {
  itens_total: number;
  itens_processados: number;
  itens_com_excecao: number;
  unidades_total: number;
  unidades_processadas: number;
}

interface VendaPedido {
  id: string;
  numero: string;
  data: string;
  filial_origem: string | null;
  empresa_origem_id: string | null;
  cliente_nome: string;
  cliente_cpf_cnpj: string | null;
  nome_ecommerce: string | null;
  id_pedido_ecommerce: string | null;
  status: string;
  status_separacao: string | null;
  vendedor_id: string | null;
  vendedor_nome: string | null;
  origem_pedido: "webhook" | "manual";
  canal_venda: string | null;
  criado_em: string;
  marcadores: string[];
  separacao_full: boolean;
  fechado_em: string | null;
  resumo_itens: ResumoItens;
}

interface VendasResponse {
  pedidos: VendaPedido[];
  total: number;
  page: number;
  page_size: number;
  auto_filtro_meus: boolean;
  hide_custo: boolean;
}

interface UsuarioOpt {
  id: string;
  nome: string;
  cargos: string[];
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "pendentes", label: "Pendentes" },
  { id: "em_separacao", label: "Em separação" },
  { id: "baixados", label: "Baixa direta" },
  { id: "concluidos", label: "Concluídos" },
  { id: "full", label: "Full" },
];

const TAB_COPY: Record<Tab, string> = {
  pendentes: "Pedidos que ainda precisam de decisão ou processamento.",
  em_separacao: "Pedidos em andamento no chão do galpão.",
  baixados: "Vendas manuais já baixadas diretamente do estoque.",
  concluidos: "Histórico concluído de vendas e marketplaces.",
  full: "Envios de estoque para o Mercado Livre Full, linha por linha.",
};

function formatCreatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function VendasPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const { user } = useAuth();
  const cargos = useMemo(
    () => user?.cargos ?? (user?.cargo ? [user.cargo] : []),
    [user],
  );
  const isVendedor = cargos.includes("vendedor");

  const tab = ((sp.get("tab") as Tab) ?? "pendentes") as Tab;
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10));
  const vendedorParam = sp.get("vendedor_id") ?? "";
  const marketplace = sp.get("marketplace") ?? "";
  const buscaParam = sp.get("busca") ?? "";
  const dataDe = sp.get("data_de") ?? "";
  const dataAte = sp.get("data_ate") ?? "";
  const [busca, setBusca] = useState(buscaParam);

  useEffect(() => {
    setBusca(buscaParam);
  }, [buscaParam]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (busca === buscaParam) return;
      const params = new URLSearchParams(sp.toString());
      if (busca.trim()) params.set("busca", busca.trim());
      else params.delete("busca");
      params.delete("page");
      router.replace(`?${params.toString()}`, { scroll: false });
    }, 350);
    return () => clearTimeout(timer);
  }, [busca, buscaParam, router, sp]);

  const updateParam = (key: string, value: string | null) => {
    const params = new URLSearchParams(sp.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    if (key !== "page") params.delete("page");
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  const clearFilters = () => {
    const params = new URLSearchParams();
    if (tab !== "pendentes") params.set("tab", tab);
    router.replace(params.size > 0 ? `?${params.toString()}` : "/wms/vendas", {
      scroll: false,
    });
  };

  const hasFilters = Boolean(
    buscaParam || vendedorParam || marketplace || dataDe || dataAte,
  );

  const { data: vendedores } = useQuery<UsuarioOpt[]>({
    queryKey: ["vendas-vendedores"],
    queryFn: async () => {
      const response = await sisoFetch("/api/wms/admin/usuarios");
      if (!response.ok) return [];
      const payload = (await response.json()) as { usuarios?: UsuarioOpt[] };
      return (payload.usuarios ?? []).filter((usuario) =>
        usuario.cargos?.includes("vendedor"),
      );
    },
    enabled: !!user,
    staleTime: 60_000,
  });

  const { data, isLoading, isError, refetch } = useQuery<VendasResponse>({
    queryKey: [
      "vendas-lista",
      tab,
      vendedorParam,
      marketplace,
      buscaParam,
      dataDe,
      dataAte,
      page,
    ],
    queryFn: async () => {
      const params = new URLSearchParams({
        tab,
        page: String(page),
      });
      if (vendedorParam) params.set("vendedor_id", vendedorParam);
      if (marketplace) params.set("marketplace", marketplace);
      if (buscaParam) params.set("busca", buscaParam);
      if (dataDe) params.set("data_de", dataDe);
      if (dataAte) params.set("data_ate", dataAte);
      const response = await sisoFetch(`/api/wms/vendas?${params.toString()}`);
      if (!response.ok) throw new Error("Falha ao carregar vendas");
      return response.json();
    },
    enabled: !!user,
  });

  const showingMyOnly = data?.auto_filtro_meus ?? false;
  const pageUnits = (data?.pedidos ?? []).reduce(
    (sum, pedido) => sum + pedido.resumo_itens.unidades_total,
    0,
  );

  return (
    <div className="wms-sales-page">
      <PageHeader
        title="Vendas diretas"
        subtitle="Do pedido à baixa: acompanhe responsável, itens e movimentações sem perder a linha."
      >
        <button
          type="button"
          className="wms-btn wms-btn-ghost"
          onClick={() => router.push("/wms/vendas/nova?tipo=full")}
        >
          <Icon name="box" size={12} />
          Criar envio Full
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          onClick={() => router.push("/wms/vendas/nova")}
        >
          <Icon name="plus" size={12} />
          Nova venda
        </button>
      </PageHeader>

      <nav className="wms-sales-tabs" aria-label="Status das vendas">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? "is-active" : undefined}
            onClick={() => updateParam("tab", item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <section className="wms-sales-toolbar" aria-label="Filtros de vendas">
        <div className="wms-sales-search">
          <Icon name="search" size={13} />
          <input
            type="search"
            value={busca}
            onChange={(event) => setBusca(event.target.value)}
            placeholder="Pedido, cliente ou ID marketplace"
            aria-label="Buscar vendas"
          />
          {busca && (
            <button
              type="button"
              onClick={() => setBusca("")}
              aria-label="Limpar busca"
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </div>

        <select
          value={marketplace}
          onChange={(event) =>
            updateParam("marketplace", event.target.value || null)
          }
          className="wms-select"
          aria-label="Filtrar por origem"
        >
          <option value="">Todas as origens</option>
          <option value="manual">Venda manual</option>
          <option value="Mercado Livre">Mercado Livre</option>
          <option value="Shopee">Shopee</option>
        </select>

        <select
          value={vendedorParam}
          onChange={(event) =>
            updateParam("vendedor_id", event.target.value || null)
          }
          className="wms-select"
          aria-label="Filtrar por vendedor"
        >
          {isVendedor ? (
            <>
              <option value="">Meus pedidos</option>
              <option value="__todos__">Todos os vendedores</option>
            </>
          ) : (
            <option value="">Todos os vendedores</option>
          )}
          {(vendedores ?? []).map((vendedor) => (
            <option key={vendedor.id} value={vendedor.id}>
              {vendedor.nome}
            </option>
          ))}
        </select>

        <label className="wms-sales-date-filter">
          <span>De</span>
          <input
            type="date"
            value={dataDe}
            onChange={(event) => updateParam("data_de", event.target.value || null)}
          />
        </label>
        <label className="wms-sales-date-filter">
          <span>Até</span>
          <input
            type="date"
            value={dataAte}
            onChange={(event) => updateParam("data_ate", event.target.value || null)}
          />
        </label>

        {hasFilters && (
          <button
            type="button"
            className="wms-btn-link wms-sales-clear"
            onClick={clearFilters}
          >
            Limpar filtros
          </button>
        )}
      </section>

      <div className="wms-sales-results-head">
        <div>
          <strong>{data?.total ?? 0} pedidos</strong>
          <span>{TAB_COPY[tab]}</span>
        </div>
        <div className="wms-sales-page-summary">
          {showingMyOnly && <span>Somente meus pedidos</span>}
          {!isLoading && pageUnits > 0 && (
            <span>{pageUnits.toLocaleString("pt-BR")} un. nesta página</span>
          )}
        </div>
      </div>

      <div className="wms-sales-table-wrap">
        {isLoading ? (
          <div className="wms-sales-skeleton" aria-label="Carregando vendas">
            {Array.from({ length: 6 }).map((_, index) => (
              <span key={index} />
            ))}
          </div>
        ) : isError ? (
          <div className="wms-sales-state">
            <span className="wms-sales-state-icon is-error">
              <Icon name="alert" size={18} />
            </span>
            <strong>Não foi possível carregar as vendas</strong>
            <p>A conexão falhou. Tente novamente sem recarregar a página.</p>
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              onClick={() => refetch()}
            >
              Tentar novamente
            </button>
          </div>
        ) : (data?.pedidos.length ?? 0) === 0 ? (
          <div className="wms-sales-state">
            <span className="wms-sales-state-icon">
              <Icon name="handshake" size={18} />
            </span>
            <strong>Nenhum pedido encontrado</strong>
            <p>
              {hasFilters
                ? "Os filtros atuais não retornaram pedidos."
                : "Essa etapa está vazia no momento."}
            </p>
            {hasFilters && (
              <button
                type="button"
                className="wms-btn wms-btn-ghost"
                onClick={clearFilters}
              >
                Limpar filtros
              </button>
            )}
          </div>
        ) : (
          <table className="wms-sales-table">
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Cliente / destino</th>
                <th>Responsável</th>
                <th>Itens</th>
                <th>Status</th>
                <th aria-label="Abrir pedido" />
              </tr>
            </thead>
            <tbody>
              {data?.pedidos.map((pedido) => {
                const resumo = pedido.resumo_itens;
                const progress =
                  resumo.unidades_total > 0
                    ? Math.round(
                        (resumo.unidades_processadas / resumo.unidades_total) *
                          100,
                      )
                    : 0;
                const origem =
                  pedido.origem_pedido === "manual"
                    ? "Manual"
                    : getMarketplaceName(pedido.nome_ecommerce ?? "") ||
                      pedido.nome_ecommerce ||
                      "Marketplace";
                const open = () =>
                  router.push(`/wms/vendas/${encodeURIComponent(pedido.id)}`);

                return (
                  <tr
                    key={pedido.id}
                    role="link"
                    tabIndex={0}
                    onClick={open}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") open();
                    }}
                  >
                    <td>
                      <div className="wms-sales-order">
                        <span
                          className={`wms-sales-origin ${
                            pedido.separacao_full ? "is-full" : ""
                          }`}
                        >
                          {pedido.separacao_full ? "FULL" : origem}
                        </span>
                        <strong>#{pedido.numero}</strong>
                        <time
                          dateTime={pedido.criado_em}
                          title={formatCreatedAt(pedido.criado_em)}
                        >
                          {formatCreatedAt(pedido.criado_em)}
                          <small>{formatRelativeTime(pedido.criado_em)}</small>
                        </time>
                      </div>
                    </td>
                    <td>
                      <div className="wms-sales-customer">
                        <strong>
                          {pedido.separacao_full
                            ? "Envio ao Mercado Livre"
                            : pedido.cliente_nome || "Cliente não informado"}
                        </strong>
                        <span>
                          {pedido.separacao_full
                            ? "Centro de distribuição Full"
                            : [pedido.canal_venda, origem]
                                .filter(Boolean)
                                .join(" · ")}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="wms-sales-owner">
                        <span className="wms-sales-avatar" aria-hidden="true">
                          {(pedido.vendedor_nome ?? "?")
                            .trim()
                            .slice(0, 1)
                            .toUpperCase()}
                        </span>
                        <div>
                          <strong>{pedido.vendedor_nome ?? "Não atribuído"}</strong>
                          <span>{pedido.filial_origem ?? "Galpão não definido"}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="wms-sales-progress">
                        <div>
                          <strong>
                            {resumo.unidades_processadas.toLocaleString("pt-BR")} /{" "}
                            {resumo.unidades_total.toLocaleString("pt-BR")} un.
                          </strong>
                          <span>{progress}%</span>
                        </div>
                        <span className="wms-sales-progress-track">
                          <i style={{ width: `${Math.min(100, progress)}%` }} />
                        </span>
                        <small>
                          {resumo.itens_processados}/{resumo.itens_total} itens
                          {resumo.itens_com_excecao > 0
                            ? ` · ${resumo.itens_com_excecao} com atenção`
                            : ""}
                        </small>
                      </div>
                    </td>
                    <td>
                      <StatusBadge
                        status={pedido.status_separacao ?? pedido.status}
                      />
                    </td>
                    <td>
                      <span className="wms-sales-open">
                        <Icon name="chevron-r" size={13} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {data && data.total > 0 && (
        <footer className="wms-sales-pagination">
          <Pagination
            total={data.total}
            pageSize={data.page_size}
            page={page}
            onPageChange={(nextPage) =>
              updateParam("page", String(nextPage))
            }
            label="pedidos"
          />
        </footer>
      )}
    </div>
  );
}
