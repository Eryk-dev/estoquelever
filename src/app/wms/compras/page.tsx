"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { sisoFetch, useAuth, usePermissoes } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import {
  ExcecoesBannerWms,
  type ExcecaoItem,
} from "@/components/wms/vendas/excecoes-banner-wms";
import {
  Icon,
  PageHeader,
  fmtDateTime,
  fmtNum,
  fmtRelative,
} from "@/components/wms/ui/wms-ui";
import { NovaCompraManualModal } from "@/components/wms/compras/nova-compra-manual-modal";
import { AbaManuais } from "@/components/wms/compras/aba-manuais";

// ── Tipos ────────────────────────────────────────────────────────────

type Tab = "comprar" | "receber" | "historico" | "manuais";

interface Counts {
  comprar: number;
  receber: number;
  excecoes: number;
  historico: number;
  pedidos_bloqueados: number;
}

interface PedidoVinc {
  pedido_id: string;
  numero: string;
  cliente_nome: string;
  quantidade: number;
  aging_dias: number;
  item_id: string;
}

type StatusCobertura = "critico" | "atencao" | "ok" | "sem_giro" | "lead_time_risco";

interface ComprarItem {
  sku: string;
  descricao: string;
  imagem_url: string | null;
  quantidade_necessaria: number;
  demanda_aberta: number;
  estoque_livre: number;
  em_transito: number;
  giro_diario: number;
  dias_cobertura: number | null;
  status_cobertura: StatusCobertura;
  lead_time_medio: number | null;
  aging_dias: number;
  pedidos: PedidoVinc[];
}

interface ComprarFornecedor {
  fornecedor: string;
  galpao_sugerido_id: string | null;
  galpao_sugerido_nome: string | null;
  skus_count: number;
  pedidos_bloqueados: number;
  aging_dias: number;
  itens: ComprarItem[];
}

interface ComprarResponse {
  counts: Counts;
  fornecedores: ComprarFornecedor[];
  excecoes: ExcecaoItem[];
}

interface ReceberItem {
  sku: string;
  descricao: string;
  imagem_url: string | null;
  quantidade_comprada: number;
  quantidade_recebida: number;
  quantidade_pendente: number;
  quantidade_excedente: number;
  aging_dias: number;
  comprado_em: string | null;
  pedidos: Array<{
    pedido_id: string;
    numero: string;
    quantidade: number;
    cliente_nome: string;
  }>;
}

interface ReceberFornecedor {
  fornecedor: string;
  galpao_sugerido_nome: string | null;
  skus_count: number;
  pendente_count: number;
  aging_dias: number;
  itens: ReceberItem[];
}

interface ReceberResponse {
  counts: Counts;
  fornecedores: ReceberFornecedor[];
}

interface HistoricoItem {
  sku: string;
  descricao: string;
  quantidade_recebida: number;
  recebido_em: string | null;
}

interface HistoricoFornecedor {
  fornecedor: string;
  data_recebimento: string;
  itens: HistoricoItem[];
}

interface HistoricoResponse {
  counts: Counts;
  fornecedores: HistoricoFornecedor[];
  next_cursor: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────

function agingClass(dias: number): "is-fresh" | "is-aging" | "is-overdue" {
  if (dias < 1) return "is-fresh";
  if (dias < 3) return "is-aging";
  return "is-overdue";
}

function coberturaLabel(s: StatusCobertura): { txt: string; color: string } {
  switch (s) {
    case "critico":
      return { txt: "crítico", color: "#dc2626" };
    case "lead_time_risco":
      return { txt: "risco lead time", color: "#d97706" };
    case "atencao":
      return { txt: "atenção", color: "#d97706" };
    case "ok":
      return { txt: "ok", color: "#16a34a" };
    default:
      return { txt: "sem giro", color: "#71717a" };
  }
}

// ── Página ──────────────────────────────────────────────────────────

export default function WmsComprasPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { can } = usePermissoes();
  const { activeGalpaoId } = useAuth();
  const podeExecutar = can("compras.executar");

  const [modalManualAberto, setModalManualAberto] = useState(false);

  const tab = ((searchParams?.get("tab") as Tab) ?? "comprar") as Tab;

  const setTab = useCallback(
    (next: Tab) => {
      const params = new URLSearchParams(
        Array.from(searchParams?.entries() ?? []),
      );
      params.set("tab", next);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const comprarQuery = useQuery<ComprarResponse>({
    queryKey: ["wms-compras", "comprar"],
    queryFn: () => wmsApi<ComprarResponse>("/api/wms/compras?tab=comprar"),
    enabled: tab === "comprar",
    refetchInterval: 30_000,
  });

  const receberQuery = useQuery<ReceberResponse>({
    queryKey: ["wms-compras", "receber"],
    queryFn: () => wmsApi<ReceberResponse>("/api/wms/compras?tab=receber"),
    enabled: tab === "receber",
    refetchInterval: 30_000,
  });

  // Histórico usa paginação cursor-based (useInfiniteQuery) com botão
  // "Carregar mais" — backend retorna até 100 itens por chamada + next_cursor.
  const historicoQuery = useInfiniteQuery<HistoricoResponse>({
    queryKey: ["wms-compras", "historico"],
    queryFn: ({ pageParam }) => {
      const cursor = pageParam as string | null;
      const url = cursor
        ? `/api/wms/compras?tab=historico&cursor=${encodeURIComponent(cursor)}&limit=100`
        : "/api/wms/compras?tab=historico&limit=100";
      return wmsApi<HistoricoResponse>(url);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled: tab === "historico",
    refetchInterval: 60_000,
  });

  const counts =
    comprarQuery.data?.counts ??
    receberQuery.data?.counts ??
    historicoQuery.data?.pages?.[0]?.counts;

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["wms-compras"] });
  }, [queryClient]);

  const refresh = useCallback(() => {
    if (tab === "comprar") comprarQuery.refetch();
    if (tab === "receber") receberQuery.refetch();
    if (tab === "historico") historicoQuery.refetch();
  }, [tab, comprarQuery, receberQuery, historicoQuery]);

  return (
    <>
      <PageHeader
        title="Compras"
        subtitle="Comprar, receber e histórico — itens consolidados por fornecedor"
        backHref="/wms"
        backLabel="Voltar ao WMS"
      >
        <button className="wms-btn wms-btn-ghost" onClick={refresh}>
          <Icon name="rotate" size={12} />
          Atualizar
        </button>
        {podeExecutar && (
          <button
            className="wms-btn wms-btn-primary"
            onClick={() => setModalManualAberto(true)}
          >
            <Icon name="plus" size={12} />
            Nova compra manual
          </button>
        )}
      </PageHeader>

      <div className="wms-vtab" style={{ marginBottom: 16 }}>
        <button
          className={`wms-vtab-btn ${tab === "comprar" ? "is-active" : ""}`}
          onClick={() => setTab("comprar")}
        >
          Comprar{" "}
          <span className="wms-vtab-n">{counts?.comprar ?? 0}</span>
        </button>
        <button
          className={`wms-vtab-btn ${tab === "receber" ? "is-active" : ""}`}
          onClick={() => setTab("receber")}
        >
          Receber{" "}
          <span className="wms-vtab-n">{counts?.receber ?? 0}</span>
          {counts && counts.receber > 0 ? (
            <span
              className="wms-aging-chip is-aging"
              style={{ marginLeft: 6 }}
              title="Pendentes"
            >
              !
            </span>
          ) : null}
        </button>
        <button
          className={`wms-vtab-btn ${tab === "historico" ? "is-active" : ""}`}
          onClick={() => setTab("historico")}
        >
          Histórico{" "}
          <span className="wms-vtab-n">{counts?.historico ?? 0}</span>
        </button>
        <button
          className={`wms-vtab-btn ${tab === "manuais" ? "is-active" : ""}`}
          onClick={() => setTab("manuais")}
        >
          Manuais
        </button>
      </div>

      {tab === "comprar" && (
        <TabComprar
          query={comprarQuery}
          onMutated={invalidateAll}
          podeExecutar={podeExecutar}
        />
      )}
      {tab === "receber" && (
        <TabReceber
          query={receberQuery}
          onMutated={invalidateAll}
          podeExecutar={podeExecutar}
        />
      )}
      {tab === "historico" && <TabHistorico query={historicoQuery} />}
      {tab === "manuais" && <AbaManuais />}

      {modalManualAberto && (
        <NovaCompraManualModal
          galpaoAtivo={activeGalpaoId}
          onClose={() => setModalManualAberto(false)}
        />
      )}
    </>
  );
}

// ── Tab Comprar ─────────────────────────────────────────────────────

function TabComprar({
  query,
  onMutated,
  podeExecutar,
}: {
  query: ReturnType<typeof useQuery<ComprarResponse>>;
  onMutated: () => void;
  podeExecutar: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qtyOverrides, setQtyOverrides] = useState<Map<string, number>>(
    new Map(),
  );
  const [pendingExcId, setPendingExcId] = useState<string | null>(null);
  // ref-per-fornecedor pra suportar shift+click range select isolado por card
  const lastCheckedRef = useRef<Map<string, number>>(new Map());

  const data = query.data;

  const toggleExpand = useCallback((fornecedor: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(fornecedor)) next.delete(fornecedor);
      else next.add(fornecedor);
      return next;
    });
  }, []);

  const toggleCheckbox = useCallback(
    (
      fornecedor: string,
      sku: string,
      idx: number,
      shiftKey: boolean,
      itens: ComprarItem[],
    ) => {
      setSelected((prev) => {
        const next = new Set(prev);
        const last = lastCheckedRef.current.get(fornecedor);
        const isChecking = !next.has(sku);

        if (shiftKey && last != null && last !== idx) {
          const [from, to] = last < idx ? [last, idx] : [idx, last];
          for (let i = from; i <= to; i++) {
            const it = itens[i];
            if (!it) continue;
            if (isChecking) next.add(it.sku);
            else next.delete(it.sku);
          }
        } else {
          if (isChecking) next.add(sku);
          else next.delete(sku);
        }
        lastCheckedRef.current.set(fornecedor, idx);
        return next;
      });
    },
    [],
  );

  const setQtyOverride = useCallback((sku: string, value: number) => {
    setQtyOverrides((prev) => {
      const next = new Map(prev);
      if (Number.isFinite(value)) next.set(sku, value);
      else next.delete(sku);
      return next;
    });
  }, []);

  // mutations
  const comprarMut = useMutation({
    mutationFn: async (itens: { sku: string; quantidade_comprada: number }[]) => {
      const r = await sisoFetch("/api/wms/compras/comprar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itens }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: (_d, vars) => {
      toast.success(
        `${vars.length} ite${vars.length === 1 ? "m" : "ns"} marcado${
          vars.length === 1 ? "" : "s"
        } como comprado${vars.length === 1 ? "" : "s"}`,
      );
      setSelected(new Set());
      setQtyOverrides(new Map());
      onMutated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const trocarSkuMut = useMutation({
    mutationFn: async (vars: { item_ids: string[]; novo_sku: string }) => {
      const r = await sisoFetch("/api/wms/compras/trocar-sku", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("SKU trocado");
      onMutated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const indisponivelMut = useMutation({
    mutationFn: async (itemId: string) => {
      const r = await sisoFetch(
        `/api/wms/compras/itens/${itemId}/indisponivel`,
        { method: "POST" },
      );
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Item marcado como indisponível");
      onMutated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelamentoMut = useMutation({
    mutationFn: async (vars: { itemId: string; motivo: string }) => {
      const r = await sisoFetch(
        `/api/wms/compras/itens/${vars.itemId}/cancelamento`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ motivo: vars.motivo }),
        },
      );
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Proposta de cancelamento registrada");
      onMutated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Excecoes — actions
  const confirmarCancelamentoMut = useMutation({
    mutationFn: async (itemId: string) => {
      setPendingExcId(itemId);
      const r = await sisoFetch(
        `/api/wms/compras/itens/${itemId}/cancelamento/confirmar`,
        { method: "POST" },
      );
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Cancelamento confirmado");
      setPendingExcId(null);
      onMutated();
    },
    onError: (e: Error) => {
      setPendingExcId(null);
      toast.error(e.message);
    },
  });

  const confirmarEquivalenteMut = useMutation({
    mutationFn: async (itemId: string) => {
      setPendingExcId(itemId);
      const r = await sisoFetch(
        `/api/wms/compras/itens/${itemId}/equivalente/confirmar`,
        { method: "POST" },
      );
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Equivalente confirmado");
      setPendingExcId(null);
      onMutated();
    },
    onError: (e: Error) => {
      setPendingExcId(null);
      toast.error(e.message);
    },
  });

  const devolverMut = useMutation({
    mutationFn: async (itemId: string) => {
      setPendingExcId(itemId);
      const r = await sisoFetch(
        `/api/wms/compras/itens/${itemId}/devolver`,
        { method: "POST" },
      );
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Item devolvido à fila");
      setPendingExcId(null);
      onMutated();
    },
    onError: (e: Error) => {
      setPendingExcId(null);
      toast.error(e.message);
    },
  });

  // Bulk action: marcar como comprados
  const allItensBySku = useMemo(() => {
    const map = new Map<string, ComprarItem>();
    for (const f of data?.fornecedores ?? []) {
      for (const it of f.itens) map.set(it.sku, it);
    }
    return map;
  }, [data]);

  const onMarcarComprados = useCallback(() => {
    const itens: { sku: string; quantidade_comprada: number }[] = [];
    for (const sku of selected) {
      const it = allItensBySku.get(sku);
      if (!it) continue;
      const qty = qtyOverrides.get(sku) ?? it.quantidade_necessaria;
      if (qty <= 0) continue;
      itens.push({ sku, quantidade_comprada: qty });
    }
    if (itens.length === 0) {
      toast.error("Nenhum item válido selecionado");
      return;
    }
    comprarMut.mutate(itens);
  }, [selected, allItensBySku, qtyOverrides, comprarMut]);

  const onTrocarSku = useCallback(
    (item: ComprarItem) => {
      const novoSku = window.prompt(
        `Trocar SKU ${item.sku} por:`,
        item.sku,
      );
      if (!novoSku || novoSku.trim() === "" || novoSku === item.sku) return;
      const itemIds = item.pedidos.map((p) => p.item_id);
      if (itemIds.length === 0) {
        toast.error("Nenhum item vinculado pra trocar");
        return;
      }
      trocarSkuMut.mutate({ item_ids: itemIds, novo_sku: novoSku.trim() });
    },
    [trocarSkuMut],
  );

  const onIndisponivel = useCallback(
    (item: ComprarItem) => {
      const itemId = item.pedidos[0]?.item_id;
      if (!itemId) return;
      if (
        !window.confirm(
          `Marcar SKU ${item.sku} como indisponível para o pedido #${item.pedidos[0]?.numero}?`,
        )
      )
        return;
      indisponivelMut.mutate(itemId);
    },
    [indisponivelMut],
  );

  const onPropostaCancelamento = useCallback(
    (item: ComprarItem) => {
      const itemId = item.pedidos[0]?.item_id;
      if (!itemId) return;
      const motivo = window.prompt(
        `Motivo do cancelamento (SKU ${item.sku}, pedido #${item.pedidos[0]?.numero}):`,
        "",
      );
      if (!motivo || motivo.trim() === "") return;
      cancelamentoMut.mutate({ itemId, motivo: motivo.trim() });
    },
    [cancelamentoMut],
  );

  if (query.isLoading) {
    return <div className="wms-loading-pane">Carregando itens…</div>;
  }
  if (query.isError) {
    return (
      <div className="wms-empty-block">
        <h3>Erro ao carregar</h3>
        <p>{(query.error as Error).message}</p>
      </div>
    );
  }
  if (!data) return null;

  const fornecedores = data.fornecedores ?? [];
  const excecoes = data.excecoes ?? [];

  return (
    <>
      {excecoes.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <ExcecoesBannerWms
            excecoes={excecoes}
            onConfirmarCancelamento={(id) =>
              confirmarCancelamentoMut.mutate(id)
            }
            onConfirmarEquivalente={(id) =>
              confirmarEquivalenteMut.mutate(id)
            }
            onDevolver={(id) => devolverMut.mutate(id)}
            pendingId={pendingExcId}
          />
        </div>
      )}

      {fornecedores.length === 0 ? (
        <div className="wms-empty-block">
          <h3>Nenhum item para comprar</h3>
          <p>Quando pedidos precisarem de compra, os fornecedores aparecem aqui.</p>
        </div>
      ) : (
        fornecedores.map((f) => {
          const isExpanded = expanded.has(f.fornecedor);
          const agCls = agingClass(f.aging_dias);
          return (
            <article key={f.fornecedor} className={`wms-frc ${agCls}`}>
              <div
                className="wms-frc-h"
                onClick={() => toggleExpand(f.fornecedor)}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="wms-frc-name">{f.fornecedor}</div>
                  <div
                    className="wms-frc-meta"
                    style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}
                  >
                    {f.galpao_sugerido_nome ? (
                      <span className="wms-pcard-chip is-galpao">
                        {f.galpao_sugerido_nome}
                      </span>
                    ) : null}
                    <span>·</span>
                    <span>{f.skus_count} SKUs</span>
                    <span>·</span>
                    <span>
                      {f.pedidos_bloqueados} pedido
                      {f.pedidos_bloqueados === 1 ? "" : "s"} bloqueado
                      {f.pedidos_bloqueados === 1 ? "" : "s"}
                    </span>
                    <span>·</span>
                    <span className={`wms-aging-chip ${agCls}`}>
                      {f.aging_dias}d
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Icon name={isExpanded ? "chevron-d" : "chevron-r"} />
                </div>
              </div>
              {isExpanded && (
                <div className="wms-frc-body">
                  {f.itens.map((item, idx) => {
                    const checked = selected.has(item.sku);
                    const qty =
                      qtyOverrides.get(item.sku) ?? item.quantidade_necessaria;
                    const itemAg = agingClass(item.aging_dias);
                    return (
                      <div
                        key={item.sku}
                        className="wms-frc-row"
                        onClick={(e) => {
                          // ignora clique vindo de botões/inputs internos
                          const target = e.target as HTMLElement;
                          if (
                            target.closest("input") ||
                            target.closest("button")
                          )
                            return;
                          toggleCheckbox(
                            f.fornecedor,
                            item.sku,
                            idx,
                            e.shiftKey,
                            f.itens,
                          );
                        }}
                        style={{ cursor: "pointer" }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {}}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCheckbox(
                              f.fornecedor,
                              item.sku,
                              idx,
                              (e as unknown as React.MouseEvent).shiftKey,
                              f.itens,
                            );
                          }}
                        />
                        {item.imagem_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.imagem_url}
                            alt=""
                            loading="lazy"
                            className="wms-thumb wms-thumb-sm"
                          />
                        ) : (
                          <div />
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div
                            className="wms-mono"
                            style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}
                          >
                            {item.sku}
                            <button
                              className="wms-btn-icon"
                              onClick={(e) => {
                                e.stopPropagation();
                                onTrocarSku(item);
                              }}
                              title="Trocar SKU"
                              type="button"
                            >
                              <Icon name="edit" size={10} />
                            </button>
                            <span
                              className={`wms-aging-chip ${itemAg}`}
                              style={{ marginLeft: 4 }}
                            >
                              {item.aging_dias}d
                            </span>
                          </div>
                          <div className="wms-pcard-item-desc">
                            {item.descricao}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: 8,
                              alignItems: "center",
                              fontSize: 11,
                              marginTop: 3,
                            }}
                          >
                            <span style={{ fontWeight: 600 }}>
                              precisa {item.quantidade_necessaria}
                            </span>
                            <span className="wms-td-mute">
                              demanda {item.demanda_aberta} · livre {item.estoque_livre} · a
                              caminho {item.em_transito}
                            </span>
                            {item.giro_diario > 0 ? (
                              <span
                                style={{ color: coberturaLabel(item.status_cobertura).color }}
                              >
                                gira {item.giro_diario.toFixed(1)}/d
                                {item.dias_cobertura != null
                                  ? ` · ${item.dias_cobertura}d cob`
                                  : ""}{" "}
                                · {coberturaLabel(item.status_cobertura).txt}
                              </span>
                            ) : (
                              <span className="wms-td-mute">sem giro</span>
                            )}
                          </div>
                          <div
                            className="wms-td-mute"
                            style={{ fontSize: 10.5, marginTop: 2 }}
                          >
                            {item.pedidos.length} pedido
                            {item.pedidos.length === 1 ? "" : "s"}:{" "}
                            {item.pedidos
                              .slice(0, 3)
                              .map((p) => `#${p.numero}`)
                              .join(", ")}
                            {item.pedidos.length > 3 ? "…" : ""}
                          </div>
                        </div>
                        <div
                          className="wms-tar wms-mono"
                          style={{ fontWeight: 600 }}
                        >
                          {fmtNum(item.quantidade_necessaria)}
                        </div>
                        <input
                          className="wms-input wms-mono wms-tar"
                          type="number"
                          min={0}
                          max={item.quantidade_necessaria}
                          value={qty}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            setQtyOverride(item.sku, Number(e.target.value))
                          }
                          style={{ width: 80 }}
                        />
                        <ItemKebab
                          onIndisponivel={() => onIndisponivel(item)}
                          onPropostaCancelamento={() =>
                            onPropostaCancelamento(item)
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </article>
          );
        })
      )}

      {selected.size > 0 && (
        <div
          style={{
            position: "sticky",
            bottom: 0,
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
            borderTop: "1px solid var(--wms-c-border)",
            padding: "10px 14px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 16,
            borderRadius: "var(--wms-r-3)",
            boxShadow: "var(--wms-shadow-sm)",
          }}
        >
          <span className="wms-td-mute">
            {selected.size} ite{selected.size === 1 ? "m" : "ns"} selecionado
            {selected.size === 1 ? "" : "s"}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="wms-btn wms-btn-ghost"
              onClick={() => {
                setSelected(new Set());
                setQtyOverrides(new Map());
              }}
              type="button"
            >
              Limpar
            </button>
            <button
              className="wms-btn wms-btn-primary"
              disabled={comprarMut.isPending || !podeExecutar}
              title={!podeExecutar ? "Sem permissão pra marcar compras" : ""}
              onClick={onMarcarComprados}
              type="button"
            >
              <Icon name="check" size={11} />
              {comprarMut.isPending
                ? "Marcando…"
                : "Marcar como comprados"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// Mini popover do kebab (sem dialog elaborado — usa <details>)
function ItemKebab({
  onIndisponivel,
  onPropostaCancelamento,
}: {
  onIndisponivel: () => void;
  onPropostaCancelamento: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
      <button
        className="wms-btn-icon"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Mais ações"
        type="button"
      >
        <Icon name="alert" size={11} />
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 30,
            }}
          />
          <div
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 4px)",
              background: "var(--wms-c-panel)",
              border: "1px solid var(--wms-c-border)",
              borderRadius: "var(--wms-r-2)",
              boxShadow: "var(--wms-shadow-sm)",
              minWidth: 200,
              zIndex: 31,
              padding: 4,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <button
              className="wms-btn wms-btn-ghost wms-btn-sm"
              style={{ justifyContent: "flex-start" }}
              onClick={() => {
                setOpen(false);
                onIndisponivel();
              }}
              type="button"
            >
              <Icon name="x" size={11} />
              Marcar indisponível
            </button>
            <button
              className="wms-btn wms-btn-ghost wms-btn-sm"
              style={{ justifyContent: "flex-start" }}
              onClick={() => {
                setOpen(false);
                onPropostaCancelamento();
              }}
              type="button"
            >
              <Icon name="alert" size={11} />
              Propor cancelamento
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Tab Receber ─────────────────────────────────────────────────────

function TabReceber({
  query,
  onMutated,
  podeExecutar,
}: {
  query: ReturnType<typeof useQuery<ReceberResponse>>;
  onMutated: () => void;
  podeExecutar: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [receberOverrides, setReceberOverrides] = useState<
    Map<string, Map<string, number>>
  >(new Map());

  const data = query.data;

  const toggleExpand = useCallback((fornecedor: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(fornecedor)) next.delete(fornecedor);
      else next.add(fornecedor);
      return next;
    });
  }, []);

  const setOverride = useCallback(
    (fornecedor: string, sku: string, value: number) => {
      setReceberOverrides((prev) => {
        const next = new Map(prev);
        const inner = new Map(next.get(fornecedor) ?? new Map());
        if (Number.isFinite(value)) inner.set(sku, value);
        else inner.delete(sku);
        next.set(fornecedor, inner);
        return next;
      });
    },
    [],
  );

  const receberMut = useMutation({
    mutationFn: async (itens: { sku: string; quantidade_recebida: number }[]) => {
      const r = await sisoFetch("/api/wms/compras/receber", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itens }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: (_d, vars) => {
      toast.success(
        `${vars.length} ite${vars.length === 1 ? "m" : "ns"} recebido${
          vars.length === 1 ? "" : "s"
        } — reservado${vars.length === 1 ? "" : "s"} ao pedido vinculado`,
      );
      setReceberOverrides(new Map());
      onMutated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const receberTodos = useCallback(
    (f: ReceberFornecedor) => {
      setReceberOverrides((prev) => {
        const next = new Map(prev);
        const inner = new Map<string, number>();
        for (const it of f.itens) inner.set(it.sku, it.quantidade_pendente);
        next.set(f.fornecedor, inner);
        return next;
      });
    },
    [],
  );

  const confirmarRecebimento = useCallback(
    (f: ReceberFornecedor) => {
      const overrides = receberOverrides.get(f.fornecedor);
      const itens: { sku: string; quantidade_recebida: number }[] = [];
      for (const it of f.itens) {
        const qty = overrides?.get(it.sku) ?? it.quantidade_pendente;
        if (qty > 0) itens.push({ sku: it.sku, quantidade_recebida: qty });
      }
      if (itens.length === 0) {
        toast.error("Nenhuma quantidade pra receber");
        return;
      }
      receberMut.mutate(itens);
    },
    [receberOverrides, receberMut],
  );

  if (query.isLoading) {
    return <div className="wms-loading-pane">Carregando…</div>;
  }
  if (query.isError) {
    return (
      <div className="wms-empty-block">
        <h3>Erro ao carregar</h3>
        <p>{(query.error as Error).message}</p>
      </div>
    );
  }
  if (!data) return null;

  const fornecedores = data.fornecedores ?? [];

  if (fornecedores.length === 0) {
    return (
      <div className="wms-empty-block">
        <h3>Nada para receber</h3>
        <p>Quando itens forem marcados como comprados, eles aparecem aqui aguardando recebimento.</p>
      </div>
    );
  }

  return (
    <>
      {fornecedores.map((f) => {
        const isExpanded = expanded.has(f.fornecedor);
        const agCls = agingClass(f.aging_dias);
        const overrides = receberOverrides.get(f.fornecedor);
        return (
          <article key={f.fornecedor} className={`wms-frc ${agCls}`}>
            <div
              className="wms-frc-h"
              onClick={() => toggleExpand(f.fornecedor)}
            >
              <div style={{ minWidth: 0 }}>
                <div className="wms-frc-name">{f.fornecedor}</div>
                <div
                  className="wms-frc-meta"
                  style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}
                >
                  {f.galpao_sugerido_nome ? (
                    <span className="wms-pcard-chip is-galpao">
                      {f.galpao_sugerido_nome}
                    </span>
                  ) : null}
                  <span>·</span>
                  <span>{f.skus_count} SKUs</span>
                  <span>·</span>
                  <span>
                    {f.pendente_count} pendente
                    {f.pendente_count === 1 ? "" : "s"}
                  </span>
                  <span>·</span>
                  <span className={`wms-aging-chip ${agCls}`}>
                    {f.aging_dias}d
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Icon name={isExpanded ? "chevron-d" : "chevron-r"} />
              </div>
            </div>
            {isExpanded && (
              <>
                <div className="wms-frc-body">
                  {f.itens.map((item) => {
                    const qty =
                      overrides?.get(item.sku) ?? item.quantidade_pendente;
                    return (
                      <div
                        key={item.sku}
                        className="wms-frc-row"
                        style={{ cursor: "default" }}
                      >
                        <div />
                        {item.imagem_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.imagem_url}
                            alt=""
                            loading="lazy"
                            className="wms-thumb wms-thumb-sm"
                          />
                        ) : (
                          <div />
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div className="wms-mono" style={{ fontWeight: 600 }}>
                            {item.sku}
                          </div>
                          <div className="wms-pcard-item-desc">
                            {item.descricao}
                          </div>
                          <div
                            className="wms-td-mute"
                            style={{ fontSize: 10.5, marginTop: 2 }}
                          >
                            {item.comprado_em
                              ? `Comprado ${fmtRelative(item.comprado_em)}`
                              : "Comprado recentemente"}
                          </div>
                        </div>
                        <div
                          className="wms-tar wms-mono"
                          style={{ fontWeight: 600 }}
                        >
                          {fmtNum(item.quantidade_recebida)}/
                          {fmtNum(item.quantidade_comprada)}
                          {item.quantidade_excedente > 0 && (
                            <span
                              title="Recebimento maior que solicitado. Verifique fornecedor/contagem."
                              style={{
                                display: "inline-block",
                                marginLeft: 6,
                                padding: "1px 6px",
                                fontSize: 10,
                                fontWeight: 600,
                                borderRadius: 8,
                                background: "rgba(245, 158, 11, 0.15)",
                                color: "#b45309",
                              }}
                            >
                              ⚠ +{fmtNum(item.quantidade_excedente)}
                            </span>
                          )}
                        </div>
                        <input
                          className="wms-input wms-mono wms-tar"
                          type="number"
                          min={0}
                          max={item.quantidade_pendente}
                          value={qty}
                          onChange={(e) =>
                            setOverride(
                              f.fornecedor,
                              item.sku,
                              Number(e.target.value),
                            )
                          }
                          style={{ width: 80 }}
                        />
                        <div />
                      </div>
                    );
                  })}
                </div>
                <div
                  style={{
                    padding: "10px 14px",
                    borderTop: "1px solid var(--wms-c-border)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <button
                    className="wms-btn wms-btn-sm wms-btn-ghost"
                    onClick={() => receberTodos(f)}
                    type="button"
                  >
                    Receber todos
                  </button>
                  <button
                    className="wms-btn wms-btn-sm wms-btn-primary"
                    disabled={receberMut.isPending || !podeExecutar}
                    title={!podeExecutar ? "Sem permissão pra receber compras" : ""}
                    onClick={() => confirmarRecebimento(f)}
                    type="button"
                  >
                    <Icon name="check" size={11} />
                    {receberMut.isPending
                      ? "Recebendo…"
                      : "Confirmar recebimento"}
                  </button>
                </div>
              </>
            )}
          </article>
        );
      })}
    </>
  );
}

// ── Tab Histórico ───────────────────────────────────────────────────

function TabHistorico({
  query,
}: {
  query: ReturnType<typeof useInfiniteQuery<HistoricoResponse>>;
}) {
  if (query.isLoading) {
    return <div className="wms-loading-pane">Carregando…</div>;
  }
  if (query.isError) {
    return (
      <div className="wms-empty-block">
        <h3>Erro ao carregar</h3>
        <p>{(query.error as Error).message}</p>
      </div>
    );
  }
  // Aglutina fornecedores de todas as páginas. Como o cursor é por
  // `comprado_em` e o backend agrupa por (fornecedor, data), aglutinar lista
  // direto produz duplicação aparente de grupos do mesmo fornecedor+data
  // entre páginas. É aceitável — cada grupo carrega itens distintos e a UI
  // mostra como linhas separadas.
  const fornecedores =
    query.data?.pages?.flatMap((p) => p.fornecedores) ?? [];

  if (fornecedores.length === 0) {
    return (
      <div className="wms-empty-block">
        <h3>Sem histórico</h3>
        <p>Recebimentos confirmados aparecem aqui.</p>
      </div>
    );
  }

  return (
    <>
      <div className="wms-tbl">
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>Fornecedor</th>
              <th>SKU</th>
              <th>Produto</th>
              <th className="wms-tar">Qty</th>
            </tr>
          </thead>
          <tbody>
            {fornecedores.flatMap((f, fIdx) =>
              f.itens.map((i, idx) => (
                <tr key={`${fIdx}-${f.fornecedor}-${i.sku}-${idx}`}>
                  <td className="wms-td-mute">
                    {i.recebido_em
                      ? fmtDateTime(i.recebido_em)
                      : fmtDateTime(f.data_recebimento)}
                  </td>
                  <td>{f.fornecedor}</td>
                  <td className="wms-mono">{i.sku}</td>
                  <td>{i.descricao}</td>
                  <td className="wms-tar wms-mono">
                    {fmtNum(i.quantidade_recebida)}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      {query.hasNextPage && (
        <div style={{ display: "flex", justifyContent: "center", padding: "1rem" }}>
          <button
            type="button"
            className="wms-btn"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
          </button>
        </div>
      )}
    </>
  );
}
