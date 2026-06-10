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
import { sisoFetch, usePermissoes } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import {
  ExcecoesBannerWms,
  type ExcecaoItem,
} from "@/components/wms/vendas/excecoes-banner-wms";
import {
  Field,
  Icon,
  Modal,
  PageHeader,
  fmtBRL,
  fmtDateTime,
  fmtNum,
} from "@/components/wms/ui/wms-ui";

// ── Tipos ────────────────────────────────────────────────────────────

type Tab = "comprar" | "receber" | "historico";

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

type OrigemDoc = "oc" | "manual";

interface ReceberDoc {
  origem: OrigemDoc;
  id: string;
  qty_pendente: number;
  criado_em: string | null;
  custo_total: number | null;
  skus_count: number;
  href: string;
}

interface ReceberFornecedorGrupo {
  fornecedor: string;
  galpao_nome: string | null;
  documentos: ReceberDoc[];
}

interface ReceberResponse {
  counts: Counts;
  fornecedores: ReceberFornecedorGrupo[];
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
      return { txt: "crítico", color: "var(--wms-c-danger)" };
    case "lead_time_risco":
      return { txt: "risco lead time", color: "var(--wms-c-warn)" };
    case "atencao":
      return { txt: "atenção", color: "var(--wms-c-warn)" };
    case "ok":
      return { txt: "ok", color: "var(--wms-c-ok)" };
    default:
      return { txt: "sem giro", color: "var(--wms-c-mute)" };
  }
}

// ── Página ──────────────────────────────────────────────────────────

export default function WmsComprasPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { can } = usePermissoes();
  const podeExecutar = can("compras.executar");

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

  // Counts numa query dedicada e sempre ativa — os counts embutidos nas
  // queries de aba congelam quando a aba está desabilitada.
  const countsQuery = useQuery<{ counts: Counts }>({
    queryKey: ["wms-compras", "counts"],
    queryFn: () => wmsApi<{ counts: Counts }>("/api/wms/compras?tab=counts"),
    refetchInterval: 30_000,
  });

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

  const counts = countsQuery.data?.counts;

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
            onClick={() => router.push("/wms/compras/nova")}
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
          <span className="wms-vtab-n">{counts ? counts.comprar : "–"}</span>
          {counts && counts.excecoes > 0 ? (
            <span
              className="wms-aging-chip is-aging"
              style={{ marginLeft: 6 }}
              title="Exceções aguardando decisão"
            >
              !
            </span>
          ) : null}
        </button>
        <button
          className={`wms-vtab-btn ${tab === "receber" ? "is-active" : ""}`}
          onClick={() => setTab("receber")}
        >
          Receber{" "}
          <span className="wms-vtab-n">{counts ? counts.receber : "–"}</span>
        </button>
        <button
          className={`wms-vtab-btn ${tab === "historico" ? "is-active" : ""}`}
          onClick={() => setTab("historico")}
        >
          Histórico{" "}
          <span className="wms-vtab-n">{counts ? counts.historico : "–"}</span>
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
        />
      )}
      {tab === "historico" && <TabHistorico query={historicoQuery} />}

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
  const [trocaSkuAlvo, setTrocaSkuAlvo] = useState<ComprarItem | null>(null);
  const [trocaSkuNovo, setTrocaSkuNovo] = useState("");
  const [trocaSkuErro, setTrocaSkuErro] = useState<string | null>(null);
  const [trocaSkuValidando, setTrocaSkuValidando] = useState(false);
  const [indisponivelAlvo, setIndisponivelAlvo] = useState<ComprarItem | null>(
    null,
  );
  const [cancelAlvo, setCancelAlvo] = useState<ComprarItem | null>(null);
  const [cancelMotivo, setCancelMotivo] = useState("");
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
      setTrocaSkuAlvo(null);
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
      setIndisponivelAlvo(null);
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
      setCancelAlvo(null);
      setCancelMotivo("");
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

  // Trocar fornecedor do item
  const fornecedoresQuery = useQuery<{ rows: { id: string; nome: string }[] }>({
    queryKey: ["compras-manuais-fornecedores"],
    queryFn: () => wmsApi<{ rows: { id: string; nome: string }[] }>("/api/wms/fornecedores"),
    staleTime: 5 * 60_000,
  });

  const [trocaFornAlvo, setTrocaFornAlvo] = useState<ComprarItem | null>(null);
  const [trocaFornNome, setTrocaFornNome] = useState("");

  const trocarFornecedorMut = useMutation({
    mutationFn: async (args: { itemIds: string[]; fornecedor_oc: string }) => {
      const r = await sisoFetch("/api/wms/compras/itens/fornecedor", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_ids: args.itemIds, fornecedor_oc: args.fornecedor_oc }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Fornecedor atualizado");
      setTrocaFornAlvo(null);
      setTrocaFornNome("");
      onMutated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const onTrocarFornecedor = useCallback((item: ComprarItem) => {
    setTrocaFornAlvo(item);
    setTrocaFornNome("");
  }, []);

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

  const onTrocarSku = useCallback((item: ComprarItem) => {
    setTrocaSkuAlvo(item);
    setTrocaSkuNovo(item.sku);
    setTrocaSkuErro(null);
  }, []);

  const submitTrocarSku = useCallback(async () => {
    if (!trocaSkuAlvo) return;
    const novo = trocaSkuNovo.trim();
    if (!novo || novo === trocaSkuAlvo.sku) return;
    const itemIds = trocaSkuAlvo.pedidos.map((p) => p.item_id);
    if (itemIds.length === 0) {
      toast.error("Nenhum item vinculado pra trocar");
      return;
    }
    setTrocaSkuValidando(true);
    setTrocaSkuErro(null);
    try {
      const res = await wmsApi<{ rows: { sku: string }[] }>(
        `/api/wms/produtos?q=${encodeURIComponent(novo)}&limit=20`,
      );
      const match = (res.rows ?? []).find(
        (r) => r.sku.toLowerCase() === novo.toLowerCase(),
      );
      if (!match) {
        setTrocaSkuErro(`SKU "${novo}" não existe no catálogo`);
        return;
      }
      trocarSkuMut.mutate({ item_ids: itemIds, novo_sku: match.sku });
    } catch (e) {
      setTrocaSkuErro(e instanceof Error ? e.message : "Erro ao validar SKU");
    } finally {
      setTrocaSkuValidando(false);
    }
  }, [trocaSkuAlvo, trocaSkuNovo, trocarSkuMut]);

  const onIndisponivel = useCallback((item: ComprarItem) => {
    if (!item.pedidos[0]?.item_id) return;
    setIndisponivelAlvo(item);
  }, []);

  const onPropostaCancelamento = useCallback((item: ComprarItem) => {
    if (!item.pedidos[0]?.item_id) return;
    setCancelAlvo(item);
    setCancelMotivo("");
  }, []);

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
                  <div
                    className="wms-frc-row wms-td-mute"
                    style={{ fontSize: 10.5, padding: "4px 0" }}
                  >
                    <div />
                    <div />
                    <div />
                    <div className="wms-tar">Necessário</div>
                    <div className="wms-tar">Comprar</div>
                    <div />
                  </div>
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
                                <span title="giro médio diário de vendas (últimos 30 dias)">
                                  gira {item.giro_diario.toFixed(1)}/d
                                </span>
                                {item.dias_cobertura != null
                                  ? ` · cobertura ${item.dias_cobertura}d`
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
                          onTrocarFornecedor={() => onTrocarFornecedor(item)}
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

      {trocaFornAlvo && (
        <Modal
          title={`Trocar fornecedor — ${trocaFornAlvo.sku}`}
          onClose={() => setTrocaFornAlvo(null)}
        >
          <Field label="Novo fornecedor">
            <select
              className="wms-select"
              value={trocaFornNome}
              onChange={(e) => setTrocaFornNome(e.target.value)}
              autoFocus
            >
              <option value="">Escolha um fornecedor…</option>
              {(fornecedoresQuery.data?.rows ?? []).map((f) => (
                <option key={f.id} value={f.nome}>{f.nome}</option>
              ))}
            </select>
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <button
              className="wms-btn wms-btn-ghost"
              onClick={() => setTrocaFornAlvo(null)}
              type="button"
            >
              Cancelar
            </button>
            <button
              className="wms-btn wms-btn-primary"
              disabled={!trocaFornNome || trocarFornecedorMut.isPending}
              onClick={() => {
                const itemIds = trocaFornAlvo.pedidos.map((p) => p.item_id);
                if (itemIds.length === 0) return;
                trocarFornecedorMut.mutate({ itemIds, fornecedor_oc: trocaFornNome });
              }}
              type="button"
            >
              {trocarFornecedorMut.isPending ? "Salvando…" : "Trocar"}
            </button>
          </div>
        </Modal>
      )}

      {trocaSkuAlvo && (
        <Modal
          title={`Trocar SKU — ${trocaSkuAlvo.sku}`}
          subtitle={trocaSkuAlvo.descricao}
          onClose={() => setTrocaSkuAlvo(null)}
        >
          <Field label="Novo SKU">
            <input
              className="wms-input wms-mono"
              value={trocaSkuNovo}
              onChange={(e) => {
                setTrocaSkuNovo(e.target.value);
                setTrocaSkuErro(null);
              }}
              autoFocus
            />
          </Field>
          {trocaSkuErro && (
            <p style={{ color: "var(--wms-c-danger)", fontSize: 12, marginTop: 6 }}>
              {trocaSkuErro}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <button
              className="wms-btn wms-btn-ghost"
              onClick={() => setTrocaSkuAlvo(null)}
              type="button"
            >
              Cancelar
            </button>
            <button
              className="wms-btn wms-btn-primary"
              disabled={
                !trocaSkuNovo.trim() ||
                trocaSkuNovo.trim() === trocaSkuAlvo.sku ||
                trocaSkuValidando ||
                trocarSkuMut.isPending
              }
              onClick={submitTrocarSku}
              type="button"
            >
              {trocaSkuValidando || trocarSkuMut.isPending
                ? "Trocando…"
                : "Trocar"}
            </button>
          </div>
        </Modal>
      )}

      {indisponivelAlvo && (
        <Modal
          title="Marcar indisponível"
          onClose={() => setIndisponivelAlvo(null)}
        >
          <p style={{ fontSize: 13 }}>
            Marcar SKU{" "}
            <strong className="wms-mono">{indisponivelAlvo.sku}</strong> como
            indisponível para o pedido #{indisponivelAlvo.pedidos[0]?.numero}?
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <button
              className="wms-btn wms-btn-ghost"
              onClick={() => setIndisponivelAlvo(null)}
              type="button"
            >
              Cancelar
            </button>
            <button
              className="wms-btn wms-btn-danger"
              disabled={indisponivelMut.isPending}
              onClick={() => {
                const itemId = indisponivelAlvo.pedidos[0]?.item_id;
                if (!itemId) return;
                indisponivelMut.mutate(itemId);
              }}
              type="button"
            >
              {indisponivelMut.isPending ? "Marcando…" : "Marcar indisponível"}
            </button>
          </div>
        </Modal>
      )}

      {cancelAlvo && (
        <Modal
          title={`Propor cancelamento — ${cancelAlvo.sku}`}
          subtitle={`Pedido #${cancelAlvo.pedidos[0]?.numero}`}
          onClose={() => setCancelAlvo(null)}
        >
          <Field label="Motivo">
            <textarea
              className="wms-textarea"
              value={cancelMotivo}
              onChange={(e) => setCancelMotivo(e.target.value)}
              autoFocus
            />
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <button
              className="wms-btn wms-btn-ghost"
              onClick={() => setCancelAlvo(null)}
              type="button"
            >
              Cancelar
            </button>
            <button
              className="wms-btn wms-btn-danger"
              disabled={!cancelMotivo.trim() || cancelamentoMut.isPending}
              onClick={() => {
                const itemId = cancelAlvo.pedidos[0]?.item_id;
                if (!itemId) return;
                cancelamentoMut.mutate({ itemId, motivo: cancelMotivo.trim() });
              }}
              type="button"
            >
              {cancelamentoMut.isPending ? "Enviando…" : "Propor cancelamento"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// Mini popover do kebab (sem dialog elaborado — usa <details>)
function ItemKebab({
  onIndisponivel,
  onPropostaCancelamento,
  onTrocarFornecedor,
}: {
  onIndisponivel: () => void;
  onPropostaCancelamento: () => void;
  onTrocarFornecedor: () => void;
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
        <Icon name="dots" size={11} />
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
            <button
              className="wms-btn wms-btn-ghost wms-btn-sm"
              style={{ justifyContent: "flex-start" }}
              onClick={() => {
                setOpen(false);
                onTrocarFornecedor();
              }}
              type="button"
            >
              <Icon name="edit" size={11} />
              Trocar fornecedor
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
}: {
  query: ReturnType<typeof useQuery<ReceberResponse>>;
}) {
  const router = useRouter();
  const fornecedores = query.data?.fornecedores ?? [];

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

  if (fornecedores.length === 0) {
    return (
      <div className="wms-empty-block">
        <h3>Nada pra receber.</h3>
        <p>Documentos pendentes de recebimento aparecem aqui.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {fornecedores.map((f) => (
        <article key={f.fornecedor} className="wms-frc">
          <div className="wms-frc-h">
            <div className="wms-frc-name">{f.fornecedor}</div>
            {f.galpao_nome && (
              <span className="wms-pcard-chip is-galpao">{f.galpao_nome}</span>
            )}
          </div>
          <div className="wms-frc-body">
            {f.documentos.map((d) => (
              <button
                key={`${d.origem}-${d.id}`}
                className="wms-frc-row-doc"
                style={{ cursor: "pointer", width: "100%", textAlign: "left" }}
                onClick={() => router.push(d.href)}
                type="button"
              >
                <span
                  className={`wms-badge ${
                    d.origem === "manual" ? "wms-badge-warn" : "wms-badge-info"
                  }`}
                >
                  {d.origem === "manual" ? "Manual" : "OC"}
                </span>
                <span>
                  {d.skus_count} SKU{d.skus_count === 1 ? "" : "s"}
                </span>
                <span>
                  {fmtNum(d.qty_pendente)} un pendente
                  {d.qty_pendente === 1 ? "" : "s"}{" "}
                  <span
                    className="wms-mono wms-td-mute"
                    style={{ fontSize: 10 }}
                  >
                    {d.id.slice(0, 8)}
                  </span>
                </span>
                <span className="wms-tar wms-mono">
                  {d.custo_total != null ? fmtBRL(d.custo_total) : "—"}
                </span>
                <span className="wms-td-mute">
                  {d.criado_em ? fmtDateTime(d.criado_em) : "—"}
                </span>
                <Icon name="chevron-r" />
              </button>
            ))}
          </div>
        </article>
      ))}
    </div>
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
              <th className="wms-tar">Qtd</th>
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
