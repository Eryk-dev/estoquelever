"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { sisoFetch, useAuth } from "@/lib/auth-context";
import { PageHeader, Icon, Pagination, StatusBadge } from "@/components/wms/ui/wms-ui";
import { FormCriarPedidoModal } from "@/components/wms/vendas/form-criar-pedido";
import { getMarketplaceName, formatRelativeTime } from "@/lib/domain-helpers";

type Tab = "pendentes" | "em_separacao" | "baixados" | "concluidos";

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

const TABS: { id: Tab; label: string }[] = [
  { id: "pendentes", label: "Pendentes" },
  { id: "em_separacao", label: "Em separação" },
  { id: "baixados", label: "Baixados" },
  { id: "concluidos", label: "Concluídos" },
];

export default function VendasPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const { user } = useAuth();
  const cargos = useMemo(() => user?.cargos ?? (user?.cargo ? [user.cargo] : []), [user]);
  const isVendedor = cargos.includes("vendedor");

  const tab = ((sp?.get("tab") as Tab) ?? "pendentes") as Tab;
  const page = Math.max(1, parseInt(sp?.get("page") ?? "1", 10));
  const vendedorParam = sp?.get("vendedor_id") ?? "";
  const marketplace = sp?.get("marketplace") ?? "";
  const buscaParam = sp?.get("busca") ?? "";

  const [busca, setBusca] = useState(buscaParam);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    setBusca(buscaParam);
  }, [buscaParam]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (busca === buscaParam) return;
      const params = new URLSearchParams(Array.from(sp?.entries() ?? []));
      if (busca) params.set("busca", busca);
      else params.delete("busca");
      params.delete("page");
      router.replace(`?${params.toString()}`, { scroll: false });
    }, 350);
    return () => clearTimeout(t);
  }, [busca, buscaParam, sp, router]);

  const updateParam = (key: string, value: string | null) => {
    const params = new URLSearchParams(Array.from(sp?.entries() ?? []));
    if (value) params.set(key, value);
    else params.delete(key);
    if (key !== "page") params.delete("page");
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  // Lista de vendedores pra filtro (admin/operador veem todos; vendedor vê todos pra toggle)
  const { data: vendedores } = useQuery<UsuarioOpt[]>({
    queryKey: ["vendas-vendedores"],
    queryFn: async () => {
      const res = await sisoFetch("/api/wms/admin/usuarios");
      if (!res.ok) return [];
      const data = (await res.json()) as { usuarios?: UsuarioOpt[] };
      const list = data.usuarios ?? [];
      return list.filter((u) => u.cargos?.includes("vendedor"));
    },
    enabled: !!user,
  });

  const { data, isLoading, refetch } = useQuery<VendasResponse>({
    queryKey: ["vendas-lista", tab, vendedorParam, marketplace, buscaParam, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("tab", tab);
      params.set("page", String(page));
      if (vendedorParam) params.set("vendedor_id", vendedorParam);
      if (marketplace) params.set("marketplace", marketplace);
      if (buscaParam) params.set("busca", buscaParam);
      const res = await sisoFetch(`/api/wms/vendas?${params.toString()}`);
      if (!res.ok) throw new Error("Falha ao carregar vendas");
      return res.json();
    },
    enabled: !!user,
  });

  const showingMyOnly = data?.auto_filtro_meus ?? false;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Vendas Diretas"
        subtitle="Pedidos manuais inseridos por vendedores + marketplaces (ML / Shopee)."
      >
        <button
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          <Icon name="plus" size={12} />
          Nova venda
        </button>
      </PageHeader>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-200 px-4 dark:border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => updateParam("tab", t.id)}
            className={`relative px-3 py-2 text-xs font-medium transition-colors ${
              tab === t.id
                ? "text-zinc-900 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            {t.label}
            {tab === t.id && (
              <span className="absolute inset-x-2 -bottom-px h-px bg-zinc-900 dark:bg-zinc-100" />
            )}
          </button>
        ))}
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Icon
            name="search"
            size={12}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400"
          />
          <input
            type="text"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Número, cliente, ID marketplace…"
            className="w-full rounded-md border border-zinc-200 bg-white pl-7 pr-2 py-1.5 text-xs placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:placeholder:text-zinc-500"
          />
        </div>

        <select
          value={marketplace}
          onChange={(e) => updateParam("marketplace", e.target.value || null)}
          className="rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">Todas origens</option>
          <option value="manual">Manual</option>
          <option value="Mercado Livre">Mercado Livre</option>
          <option value="Shopee">Shopee</option>
        </select>

        <select
          value={vendedorParam}
          onChange={(e) => updateParam("vendedor_id", e.target.value || null)}
          className="rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        >
          {isVendedor ? (
            <>
              <option value="">Meus pedidos</option>
              <option value="__todos__">Todos os vendedores</option>
            </>
          ) : (
            <option value="">Todos vendedores</option>
          )}
          {(vendedores ?? []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.nome}
            </option>
          ))}
        </select>

        {showingMyOnly && (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            mostrando só meus pedidos
          </span>
        )}
      </div>

      {/* Tabela */}
      <div className="flex-1 overflow-auto px-4 py-3">
        {isLoading ? (
          <div className="py-12 text-center text-xs text-zinc-500">Carregando…</div>
        ) : (data?.pedidos?.length ?? 0) === 0 ? (
          <div className="py-12 text-center">
            <Icon name="box" size={24} className="mx-auto text-zinc-300" />
            <p className="mt-2 text-xs text-zinc-500">Nenhum pedido nesta aba.</p>
          </div>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
                <th className="py-2 pr-3 font-medium">Número</th>
                <th className="py-2 pr-3 font-medium">Data</th>
                <th className="py-2 pr-3 font-medium">Cliente</th>
                <th className="py-2 pr-3 font-medium">Origem</th>
                <th className="py-2 pr-3 font-medium">Vendedor</th>
                <th className="py-2 pr-3 font-medium">Canal</th>
                <th className="py-2 pr-3 font-medium">Galpão</th>
                <th className="py-2 pr-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {(data?.pedidos ?? []).map((p) => (
                <tr
                  key={p.id}
                  onClick={() => router.push(`/wms/vendas/${encodeURIComponent(p.id)}`)}
                  className="cursor-pointer border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/50"
                >
                  <td className="py-2 pr-3 font-medium text-zinc-900 dark:text-zinc-100">
                    #{p.numero}
                  </td>
                  <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-400">
                    {formatRelativeTime(p.criado_em)}
                  </td>
                  <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{p.cliente_nome}</td>
                  <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-400">
                    {p.origem_pedido === "manual"
                      ? "Manual"
                      : getMarketplaceName(p.nome_ecommerce ?? "") || p.nome_ecommerce}
                  </td>
                  <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-400">
                    {p.vendedor_nome ?? <span className="text-zinc-400">— atribuir</span>}
                  </td>
                  <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-400">
                    {p.canal_venda ?? "—"}
                  </td>
                  <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-400">
                    {p.filial_origem ?? "—"}
                  </td>
                  <td className="py-2 pr-3">
                    <StatusBadge status={p.status_separacao ?? p.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Paginação */}
      {data && (
        <div className="border-t border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <Pagination
            total={data.total}
            pageSize={data.page_size}
            page={page}
            onPageChange={(p) => updateParam("page", String(p))}
            label="vendas"
          />
        </div>
      )}

      {modalOpen && (
        <FormCriarPedidoModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onCreated={(pedidoId) => {
            setModalOpen(false);
            refetch();
            router.push(`/wms/vendas/${encodeURIComponent(pedidoId)}`);
          }}
        />
      )}
    </div>
  );
}
