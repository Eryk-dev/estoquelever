"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { EquivalentesCompra } from "@/components/wms/compras/equivalentes-compra";
import {
  flattenItensPorSku,
  agruparCompra,
  filtrarOrdenarLinhas,
  type CompraSelecionada,
  type LinhaCompra,
  type SortKey,
  type SortDir,
} from "@/lib/compras-ui";

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
  galpao_id: string | null;
  galpao_nome: string | null;
}

interface FornecedorOpcao {
  fornecedorId: string | null;
  nome: string;
  custo_unitario: number | null;
  lead_time_dias_medio: number | null;
  qty_minima_pedido: number;
  multiplo_compra: number;
  preferencial: boolean;
  /** Galpão de recebimento fixo do fornecedor (cadastro ou fallback prefix). */
  galpao_id: string | null;
  galpao_nome: string | null;
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
  fornecedores: FornecedorOpcao[];
  fornecedor_escolhido: FornecedorOpcao | null;
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
  galpao_nome: string | null;
  skus_count: number;
  href: string;
  /** pedidos que o documento destrava ao receber (só OC; manual vem vazio). */
  pedidos_cobertos: { pedido_id: string; numero: string }[];
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
  // P3-02: a coluna recebido_em nunca é populada no recebimento de OC; o único
  // timestamp real é comprado_em. Exibido como "Comprado em".
  comprado_em: string | null;
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
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qtyOverrides, setQtyOverrides] = useState<Map<string, number>>(new Map());
  // Escolha de fornecedor por SKU (nome). O galpão segue o fornecedor (fixo).
  const [fornecedorOverrides, setFornecedorOverrides] = useState<Map<string, string>>(
    new Map(),
  );
  // Toolbar
  const [busca, setBusca] = useState("");
  const [filtroFornecedor, setFiltroFornecedor] = useState("");
  const [filtroGalpao, setFiltroGalpao] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("urgencia");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  // Modais
  const [pendingExcId, setPendingExcId] = useState<string | null>(null);
  const [confirmSel, setConfirmSel] = useState<CompraSelecionada[] | null>(null);
  const [trocaSkuAlvo, setTrocaSkuAlvo] = useState<ComprarItem | null>(null);
  const [trocaSkuNovo, setTrocaSkuNovo] = useState("");
  const [trocaSkuErro, setTrocaSkuErro] = useState<string | null>(null);
  const [trocaSkuValidando, setTrocaSkuValidando] = useState(false);
  const [trocaFornAlvo, setTrocaFornAlvo] = useState<ComprarItem | null>(null);
  const [trocaFornNome, setTrocaFornNome] = useState("");
  const [cancelAlvo, setCancelAlvo] = useState<ComprarItem | null>(null);
  const [cancelMotivo, setCancelMotivo] = useState("");
  const [indispItemIds, setIndispItemIds] = useState<string[] | null>(null);

  // Lista completa de fornecedores (pro modal "Trocar fornecedor" — pode escolher
  // qualquer fornecedor, não só os cadastrados pro SKU).
  const fornecedoresQuery = useQuery<{ rows: { id: string; nome: string }[] }>({
    queryKey: ["compras-manuais-fornecedores"],
    queryFn: () => wmsApi<{ rows: { id: string; nome: string }[] }>("/api/wms/fornecedores"),
    staleTime: 5 * 60_000,
  });

  const data = query.data;

  // Lista plana 1-linha-por-SKU (a API ainda devolve agrupado por fornecedor).
  const itens = useMemo<ComprarItem[]>(
    () => flattenItensPorSku<ComprarItem>(data?.fornecedores ?? []),
    [data],
  );

  const toggleExpand = useCallback((sku: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }, []);

  const toggleCheckbox = useCallback((sku: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }, []);

  const setQtyOverride = useCallback((sku: string, value: number) => {
    setQtyOverrides((prev) => {
      const next = new Map(prev);
      if (Number.isFinite(value)) next.set(sku, value);
      else next.delete(sku);
      return next;
    });
  }, []);

  const setFornecedorOverride = useCallback((sku: string, nome: string) => {
    setFornecedorOverrides((prev) => new Map(prev).set(sku, nome));
  }, []);

  const getQty = useCallback(
    (it: ComprarItem) => qtyOverrides.get(it.sku) ?? it.quantidade_necessaria,
    [qtyOverrides],
  );
  const getFornecedorOpcao = useCallback(
    (it: ComprarItem): FornecedorOpcao | null => {
      const nome = fornecedorOverrides.get(it.sku);
      if (nome) return it.fornecedores.find((f) => f.nome === nome) ?? it.fornecedor_escolhido;
      return it.fornecedor_escolhido;
    },
    [fornecedorOverrides],
  );

  // ── Linhas resolvidas (fornecedor/galpão escolhidos) + filtro/ordenação ──
  type LinhaItem = LinhaCompra & { item: ComprarItem; opcao: FornecedorOpcao | null };
  const linhas = useMemo<LinhaItem[]>(
    () =>
      itens.map((it) => {
        const opc = getFornecedorOpcao(it);
        return {
          sku: it.sku,
          descricao: it.descricao,
          fornecedorNome: opc?.nome ?? "Sem fornecedor",
          galpaoId: opc?.galpao_id ?? null,
          galpaoNome: opc?.galpao_nome ?? null,
          quantidade: getQty(it),
          aging_dias: it.aging_dias,
          item: it,
          opcao: opc,
        };
      }),
    [itens, getFornecedorOpcao, getQty],
  );

  const fornecedorOpcoesFiltro = useMemo(
    () => [...new Set(linhas.map((l) => l.fornecedorNome))].sort((a, b) => a.localeCompare(b, "pt-BR")),
    [linhas],
  );
  const galpaoOpcoesFiltro = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of linhas) if (l.galpaoId) m.set(l.galpaoId, l.galpaoNome ?? l.galpaoId);
    return [...m].map(([id, nome]) => ({ id, nome }));
  }, [linhas]);

  const linhasVisiveis = useMemo(
    () =>
      filtrarOrdenarLinhas(linhas, {
        busca,
        fornecedor: filtroFornecedor || null,
        galpao: filtroGalpao || null,
        sortKey,
        sortDir,
      }),
    [linhas, busca, filtroFornecedor, filtroGalpao, sortKey, sortDir],
  );

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir(key === "urgencia" ? "desc" : "asc");
      }
    },
    [sortKey],
  );

  // ── Mutations ──
  const comprarMut = useMutation({
    mutationFn: async (sel: CompraSelecionada[]) => {
      const byForn = new Map<string, CompraSelecionada[]>();
      for (const s of sel) {
        const l = byForn.get(s.fornecedorNome) ?? [];
        l.push(s);
        byForn.set(s.fornecedorNome, l);
      }
      for (const [fornecedor, lista] of byForn) {
        const r = await sisoFetch("/api/wms/compras/comprar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fornecedor_oc: fornecedor,
            itens: lista.map((s) => ({
              sku: s.sku,
              quantidade_comprada: s.qty,
              galpao_id: s.galpaoId,
              ...(s.custoUnitario != null ? { preco_unitario: s.custoUnitario } : {}),
            })),
          }),
        });
        if (!r.ok) {
          const b = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error || `HTTP ${r.status}`);
        }
      }
    },
    onMutate: async (sel) => {
      await queryClient.cancelQueries({ queryKey: ["wms-compras"] });
      const snapshot = queryClient.getQueryData<ComprarResponse>([
        "wms-compras",
        "comprar",
      ]);
      const skus = new Set(sel.map((s) => s.sku));
      queryClient.setQueryData<ComprarResponse>(["wms-compras", "comprar"], (old) =>
        old
          ? {
              ...old,
              fornecedores: old.fornecedores
                .map((f) => {
                  const fitens = f.itens.filter((it) => !skus.has(it.sku));
                  return { ...f, itens: fitens, skus_count: fitens.length };
                })
                .filter((f) => f.itens.length > 0),
            }
          : old,
      );
      setSelected(new Set());
      setQtyOverrides(new Map());
      setConfirmSel(null);
      return { snapshot };
    },
    onSuccess: (_d, sel) => {
      const n = new Set(sel.map((s) => s.sku)).size;
      toast.success(`${n} ite${n === 1 ? "m" : "ns"} comprado${n === 1 ? "" : "s"}`);
    },
    onError: (e: Error, _vars, ctx) => {
      if (ctx?.snapshot)
        queryClient.setQueryData(["wms-compras", "comprar"], ctx.snapshot);
      toast.error(e.message);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["wms-compras"] });
    },
  });

  const trocarSkuMut = useMutation({
    mutationFn: async (vars: { item_ids: string[]; novo_sku: string }) => {
      const r = await sisoFetch("/api/wms/compras/trocar-sku", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      const b = (await r.json().catch(() => ({}))) as {
        error?: string;
        itens_nao_trocados?: Array<{ item_id: string; motivo: string }>;
      };
      if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
      return b;
    },
    onSuccess: (d) => {
      const falhas = d.itens_nao_trocados?.length ?? 0;
      if (falhas > 0) {
        toast.warning(
          `SKU trocado, mas ${falhas} ite${falhas === 1 ? "m ficou" : "ns ficaram"} sem troca (empresa sem mapeamento Tiny do SKU novo)`,
        );
      } else {
        toast.success("SKU trocado");
      }
      setTrocaSkuAlvo(null);
      onMutated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

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

  const cancelamentoMut = useMutation({
    mutationFn: async (vars: { itemIds: string[]; motivo: string }) => {
      const [first, ...rest] = vars.itemIds;
      const r = await sisoFetch(`/api/wms/compras/itens/${first}/cancelamento`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: vars.motivo, item_ids: rest }),
      });
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

  const indisponivelMut = useMutation({
    mutationFn: async (itemIds: string[]) => {
      const [first, ...rest] = itemIds;
      const r = await sisoFetch(`/api/wms/compras/itens/${first}/indisponivel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_ids: rest }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onMutate: async (itemIds) => {
      await queryClient.cancelQueries({ queryKey: ["wms-compras"] });
      const snapshot = queryClient.getQueryData<ComprarResponse>([
        "wms-compras",
        "comprar",
      ]);
      const ids = new Set(itemIds);
      queryClient.setQueryData<ComprarResponse>(["wms-compras", "comprar"], (old) =>
        old
          ? {
              ...old,
              fornecedores: old.fornecedores
                .map((f) => {
                  const fitens = f.itens.filter(
                    (it) => !it.pedidos.some((p) => ids.has(p.item_id)),
                  );
                  return { ...f, itens: fitens, skus_count: fitens.length };
                })
                .filter((f) => f.itens.length > 0),
            }
          : old,
      );
      setSelected(new Set());
      setIndispItemIds(null);
      return { snapshot };
    },
    onSuccess: () => toast.success("Itens marcados como indisponível"),
    onError: (e: Error, _vars, ctx) => {
      if (ctx?.snapshot)
        queryClient.setQueryData(["wms-compras", "comprar"], ctx.snapshot);
      toast.error(e.message);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["wms-compras"] });
    },
  });

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
      const r = await sisoFetch(`/api/wms/compras/itens/${itemId}/devolver`, {
        method: "POST",
      });
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

  // ── Ações ──
  const onGerar = useCallback(() => {
    const sel: CompraSelecionada[] = [];
    const semGalpao: string[] = [];
    for (const l of linhas) {
      if (!selected.has(l.sku)) continue;
      if (l.quantidade <= 0) continue;
      if (!l.galpaoId) {
        semGalpao.push(l.sku);
        continue;
      }
      sel.push({
        sku: l.sku,
        descricao: l.descricao,
        qty: l.quantidade,
        fornecedorNome: l.fornecedorNome,
        galpaoId: l.galpaoId,
        galpaoNome: l.galpaoNome ?? "—",
        custoUnitario: l.opcao?.custo_unitario ?? null,
        pedidosCobertos: l.item.pedidos.map((p) => ({ numero: p.numero })),
      });
    }
    if (semGalpao.length > 0) {
      toast.error(
        `Sem galpão configurado: ${semGalpao.join(", ")}. Defina o galpão do fornecedor em Fornecedores.`,
      );
      return;
    }
    if (sel.length === 0) {
      toast.error("Nenhum item válido selecionado");
      return;
    }
    setConfirmSel(sel);
  }, [linhas, selected]);

  const onMarcarIndisponivelBulk = useCallback(() => {
    const itemIds: string[] = [];
    for (const it of itens) {
      if (!selected.has(it.sku)) continue;
      for (const p of it.pedidos) if (p.item_id) itemIds.push(p.item_id);
    }
    if (itemIds.length === 0) {
      toast.error("Nenhum item selecionado");
      return;
    }
    setIndispItemIds(itemIds);
  }, [itens, selected]);

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

  const confirmPreview = useMemo(
    () => (confirmSel ? agruparCompra(confirmSel) : []),
    [confirmSel],
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

  const excecoes = data.excecoes ?? [];
  const GRID =
    "20px minmax(0,1.6fr) 92px minmax(0,1.35fr) 84px minmax(0,0.85fr) 30px";
  const sortArrow = (k: SortKey) => (sortKey === k ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  return (
    <>
      {excecoes.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <ExcecoesBannerWms
            excecoes={excecoes}
            onConfirmarCancelamento={(id) => confirmarCancelamentoMut.mutate(id)}
            onConfirmarEquivalente={(id) => confirmarEquivalenteMut.mutate(id)}
            onDevolver={(id) => devolverMut.mutate(id)}
            pendingId={pendingExcId}
          />
        </div>
      )}

      {/* Toolbar: busca + filtros */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <div style={{ position: "relative", flex: 1, minWidth: 220 }}>
          <input
            className="wms-input"
            placeholder="Buscar peça, SKU ou fornecedor…"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            style={{ width: "100%", paddingLeft: 30 }}
          />
          <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--wms-c-mute)" }}>
            <Icon name="search" size={13} />
          </span>
        </div>
        <select
          className="wms-select"
          value={filtroFornecedor}
          onChange={(e) => setFiltroFornecedor(e.target.value)}
          title="Filtrar por fornecedor"
        >
          <option value="">Todos fornecedores</option>
          {fornecedorOpcoesFiltro.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <select
          className="wms-select"
          value={filtroGalpao}
          onChange={(e) => setFiltroGalpao(e.target.value)}
          title="Filtrar por galpão de recebimento"
        >
          <option value="">Todos galpões</option>
          {galpaoOpcoesFiltro.map((g) => (
            <option key={g.id} value={g.id}>
              {g.nome}
            </option>
          ))}
        </select>
        {(busca || filtroFornecedor || filtroGalpao) && (
          <button
            type="button"
            className="wms-btn wms-btn-ghost wms-btn-sm"
            onClick={() => {
              setBusca("");
              setFiltroFornecedor("");
              setFiltroGalpao("");
            }}
          >
            Limpar filtros
          </button>
        )}
      </div>

      {itens.length === 0 ? (
        <div className="wms-empty-block">
          <h3>Nenhum item para comprar</h3>
          <p>Quando pedidos precisarem de compra, as peças aparecem aqui.</p>
        </div>
      ) : (
        <div className="wms-frc" style={{ borderLeftColor: "var(--wms-c-border-2)" }}>
          {/* Cabeçalho da lista (ordenável) */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: GRID,
              gap: 10,
              alignItems: "center",
              padding: "8px 14px",
              borderBottom: "1px solid var(--wms-c-border)",
              fontSize: 10.5,
              textTransform: "uppercase",
              letterSpacing: ".05em",
              color: "var(--wms-c-mute)",
              fontWeight: 600,
            }}
          >
            <span />
            <button type="button" className="wms-sort-h" onClick={() => toggleSort("sku")}>
              Peça{sortArrow("sku")}
            </button>
            <button type="button" className="wms-sort-h" onClick={() => toggleSort("quanto")}>
              Quanto{sortArrow("quanto")}
            </button>
            <button type="button" className="wms-sort-h" onClick={() => toggleSort("fornecedor")}>
              De quem{sortArrow("fornecedor")}
            </button>
            <span>Entregar em</span>
            <button type="button" className="wms-sort-h" onClick={() => toggleSort("urgencia")}>
              Urgência{sortArrow("urgencia")}
            </button>
            <span />
          </div>

          {linhasVisiveis.length === 0 ? (
            <div className="wms-td-mute" style={{ padding: "18px 14px", fontSize: 13 }}>
              Nenhuma peça com esses filtros.
            </div>
          ) : (
            linhasVisiveis.map((l) => {
              const item = l.item;
              const checked = selected.has(item.sku);
              const isExpanded = expanded.has(item.sku);
              const qty = l.quantidade;
              const opc = l.opcao;
              const itemAg = agingClass(item.aging_dias);
              const cob = coberturaLabel(item.status_cobertura);
              return (
                <div key={item.sku} style={{ borderBottom: "1px solid var(--wms-c-border)" }}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: GRID,
                      gap: 10,
                      alignItems: "center",
                      padding: "12px 14px",
                      background: checked ? "var(--wms-c-info-bg)" : undefined,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCheckbox(item.sku)}
                    />

                    {/* Peça */}
                    <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                      {item.imagem_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.imagem_url}
                          alt=""
                          loading="lazy"
                          className="wms-thumb wms-thumb-sm"
                        />
                      ) : (
                        <div className="wms-thumb wms-thumb-sm" />
                      )}
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: 14,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {item.descricao}
                        </div>
                        <div className="wms-mono wms-td-mute" style={{ fontSize: 11 }}>
                          {item.sku}
                        </div>
                      </div>
                    </div>

                    {/* Quanto comprar */}
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                      <input
                        className="wms-input wms-mono"
                        type="number"
                        min={0}
                        value={qty}
                        onChange={(e) => setQtyOverride(item.sku, Number(e.target.value))}
                        style={{ width: 64, textAlign: "center", fontWeight: 700, fontSize: 16 }}
                      />
                      <span className="wms-td-mute" style={{ fontSize: 10, marginTop: 2 }}>
                        falta {fmtNum(item.quantidade_necessaria)}
                      </span>
                    </div>

                    {/* De quem comprar */}
                    <div style={{ minWidth: 0 }}>
                      <select
                        className="wms-select"
                        value={opc?.nome ?? ""}
                        onChange={(e) => setFornecedorOverride(item.sku, e.target.value)}
                        style={{ width: "100%" }}
                      >
                        {item.fornecedores.length === 0 && <option value="">Sem fornecedor</option>}
                        {item.fornecedores.map((f) => (
                          <option key={f.nome} value={f.nome}>
                            {f.nome}
                            {f.custo_unitario != null ? ` — ${fmtBRL(f.custo_unitario)}` : ""}
                            {f.lead_time_dias_medio != null ? ` · ${f.lead_time_dias_medio}d` : ""}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Entregar em — fixo do fornecedor (read-only) */}
                    <div>
                      {l.galpaoNome ? (
                        <span className="wms-pcard-chip is-galpao">{l.galpaoNome}</span>
                      ) : (
                        <span
                          className="wms-aging-chip is-overdue"
                          title="Fornecedor sem galpão configurado — defina em Fornecedores"
                        >
                          sem galpão
                        </span>
                      )}
                    </div>

                    {/* Urgência + expand */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                      {item.giro_diario > 0 ? (
                        <span
                          className="wms-aging-chip"
                          style={{ color: cob.color, borderColor: cob.color }}
                          title={
                            item.dias_cobertura != null
                              ? `cobertura ${item.dias_cobertura}d · gira ${item.giro_diario.toFixed(1)}/d`
                              : `gira ${item.giro_diario.toFixed(1)}/d`
                          }
                        >
                          {cob.txt}
                          {item.dias_cobertura != null ? ` · ${item.dias_cobertura}d` : ""}
                        </span>
                      ) : (
                        <span className={`wms-aging-chip ${itemAg}`}>{item.aging_dias}d</span>
                      )}
                      {item.pedidos.length > 0 && (
                        <button
                          type="button"
                          onClick={() => toggleExpand(item.sku)}
                          style={{
                            background: "none",
                            border: 0,
                            padding: 0,
                            cursor: "pointer",
                            color: "var(--wms-c-info)",
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {isExpanded ? "▾" : "▸"} {item.pedidos.length} pedido
                          {item.pedidos.length === 1 ? "" : "s"}
                        </button>
                      )}
                    </div>

                    {/* Kebab de ações por item */}
                    <ItemKebab
                      onTrocarSku={() => {
                        setTrocaSkuAlvo(item);
                        setTrocaSkuNovo(item.sku);
                        setTrocaSkuErro(null);
                      }}
                      onTrocarFornecedor={() => {
                        setTrocaFornAlvo(item);
                        setTrocaFornNome("");
                      }}
                      onIndisponivel={() => {
                        const ids = item.pedidos.map((p) => p.item_id).filter(Boolean);
                        if (ids.length) setIndispItemIds(ids);
                      }}
                      onPropostaCancelamento={() => {
                        setCancelAlvo(item);
                        setCancelMotivo("");
                      }}
                    />
                  </div>

                  {/* Expand: pedidos atrás + equivalentes */}
                  {isExpanded && (
                    <div style={{ padding: "0 14px 14px 44px" }}>
                      <div className="wms-td-mute" style={{ fontSize: 11, fontWeight: 600, margin: "2px 0 8px" }}>
                        Pedidos esperando esta peça
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 1,
                          background: "var(--wms-c-border)",
                          borderRadius: "var(--wms-r-2)",
                          overflow: "hidden",
                        }}
                      >
                        {item.pedidos.map((p) => (
                          <div
                            key={p.item_id}
                            style={{
                              display: "grid",
                              gridTemplateColumns: "88px 1fr 120px 56px 48px",
                              gap: 10,
                              alignItems: "center",
                              background: "var(--wms-c-panel)",
                              padding: "8px 12px",
                              fontSize: 12.5,
                            }}
                          >
                            <span className="wms-mono" style={{ fontWeight: 600, color: "var(--wms-c-info)" }}>
                              #{p.numero}
                            </span>
                            <span className="wms-td-mute">{p.cliente_nome}</span>
                            <span style={{ fontSize: 11.5 }}>
                              em <span style={{ fontWeight: 600 }}>{p.galpao_nome ?? "—"}</span>
                            </span>
                            <span>{fmtNum(p.quantidade)} un</span>
                            <span className="wms-tar wms-td-mute" style={{ fontSize: 11 }}>
                              {p.aging_dias}d
                            </span>
                          </div>
                        ))}
                      </div>
                      <EquivalentesCompra
                        sku={item.sku}
                        itemIds={item.pedidos.map((p) => p.item_id)}
                        onAplicado={() =>
                          queryClient.invalidateQueries({ queryKey: ["wms-compras"] })
                        }
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Barra de ação */}
      {selected.size > 0 && (
        <div
          style={{
            position: "sticky",
            bottom: 0,
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
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
            <b style={{ color: "var(--wms-c-fg)" }}>{selected.size}</b> peça
            {selected.size === 1 ? "" : "s"} selecionada{selected.size === 1 ? "" : "s"}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="wms-btn wms-btn-ghost"
              type="button"
              onClick={() => {
                setSelected(new Set());
                setQtyOverrides(new Map());
              }}
            >
              Limpar
            </button>
            <button
              className="wms-btn wms-btn-ghost"
              type="button"
              disabled={indisponivelMut.isPending || !podeExecutar}
              onClick={onMarcarIndisponivelBulk}
            >
              Marcar indisponível
            </button>
            <button
              className="wms-btn wms-btn-primary"
              type="button"
              disabled={comprarMut.isPending || !podeExecutar}
              title={!podeExecutar ? "Sem permissão pra comprar" : ""}
              onClick={onGerar}
            >
              <Icon name="check" size={11} />
              {comprarMut.isPending ? "Gerando…" : "Gerar compra →"}
            </button>
          </div>
        </div>
      )}

      {/* Modal de confirmação */}
      {confirmSel && (
        <Modal
          title={`Confirmar — ${confirmPreview.length} compra${confirmPreview.length === 1 ? "" : "s"}`}
          subtitle="Agrupadas por fornecedor + galpão. Você não agrupa na mão."
          onClose={() => setConfirmSel(null)}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {confirmPreview.map((g) => (
              <div
                key={`${g.fornecedorNome}::${g.galpaoId}`}
                style={{
                  border: "1px solid var(--wms-c-border)",
                  borderRadius: "var(--wms-r-2)",
                  padding: "12px 14px",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "center",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {g.fornecedorNome} → {g.galpaoNome}
                  </div>
                  <div className="wms-td-mute" style={{ fontSize: 12, marginTop: 2 }}>
                    {g.itens.map((i) => i.sku).join(", ")}
                    {g.pedidosCobertos.length > 0
                      ? ` · destrava ${g.pedidosCobertos.map((n) => `#${n}`).join(" ")}`
                      : ""}
                  </div>
                </div>
                <span
                  className="wms-mono"
                  style={{
                    fontWeight: 600,
                    background: "var(--wms-c-info-bg)",
                    color: "var(--wms-c-info)",
                    padding: "4px 11px",
                    borderRadius: "var(--wms-r-2)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {fmtNum(g.qtyTotal)} un
                  {g.custoTotal != null ? ` · ${fmtBRL(g.custoTotal)}` : ""}
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
            <button className="wms-btn wms-btn-ghost" type="button" onClick={() => setConfirmSel(null)}>
              Voltar
            </button>
            <button
              className="wms-btn wms-btn-primary"
              type="button"
              disabled={comprarMut.isPending}
              onClick={() => comprarMut.mutate(confirmSel)}
            >
              <Icon name="check" size={11} />
              {comprarMut.isPending
                ? "Confirmando…"
                : `Confirmar ${confirmPreview.length} compra${confirmPreview.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </Modal>
      )}

      {/* Trocar fornecedor (lista completa, persiste) */}
      {trocaFornAlvo && (
        <Modal title={`Trocar fornecedor — ${trocaFornAlvo.sku}`} onClose={() => setTrocaFornAlvo(null)}>
          <Field label="Novo fornecedor">
            <select
              className="wms-select"
              value={trocaFornNome}
              onChange={(e) => setTrocaFornNome(e.target.value)}
              autoFocus
            >
              <option value="">Escolha um fornecedor…</option>
              {(fornecedoresQuery.data?.rows ?? []).map((f) => (
                <option key={f.id} value={f.nome}>
                  {f.nome}
                </option>
              ))}
            </select>
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <button className="wms-btn wms-btn-ghost" type="button" onClick={() => setTrocaFornAlvo(null)}>
              Cancelar
            </button>
            <button
              className="wms-btn wms-btn-primary"
              type="button"
              disabled={!trocaFornNome || trocarFornecedorMut.isPending}
              onClick={() => {
                const itemIds = trocaFornAlvo.pedidos.map((p) => p.item_id);
                if (itemIds.length === 0) return;
                trocarFornecedorMut.mutate({ itemIds, fornecedor_oc: trocaFornNome });
              }}
            >
              {trocarFornecedorMut.isPending ? "Salvando…" : "Trocar"}
            </button>
          </div>
        </Modal>
      )}

      {/* Trocar SKU */}
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
            <p style={{ color: "var(--wms-c-danger)", fontSize: 12, marginTop: 6 }}>{trocaSkuErro}</p>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <button className="wms-btn wms-btn-ghost" type="button" onClick={() => setTrocaSkuAlvo(null)}>
              Cancelar
            </button>
            <button
              className="wms-btn wms-btn-primary"
              type="button"
              disabled={
                !trocaSkuNovo.trim() ||
                trocaSkuNovo.trim() === trocaSkuAlvo.sku ||
                trocaSkuValidando ||
                trocarSkuMut.isPending
              }
              onClick={submitTrocarSku}
            >
              {trocaSkuValidando || trocarSkuMut.isPending ? "Trocando…" : "Trocar"}
            </button>
          </div>
        </Modal>
      )}

      {/* Propor cancelamento */}
      {cancelAlvo && (
        <Modal
          title={`Propor cancelamento — ${cancelAlvo.sku}`}
          subtitle={
            cancelAlvo.pedidos.length === 1
              ? `Pedido #${cancelAlvo.pedidos[0]?.numero}`
              : `${cancelAlvo.pedidos.length} pedidos vinculados`
          }
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
            <button className="wms-btn wms-btn-ghost" type="button" onClick={() => setCancelAlvo(null)}>
              Cancelar
            </button>
            <button
              className="wms-btn wms-btn-danger"
              type="button"
              disabled={!cancelMotivo.trim() || cancelamentoMut.isPending}
              onClick={() => {
                const itemIds = cancelAlvo.pedidos
                  .map((p) => p.item_id)
                  .filter((id): id is string => !!id);
                if (itemIds.length === 0) return;
                cancelamentoMut.mutate({ itemIds, motivo: cancelMotivo.trim() });
              }}
            >
              {cancelamentoMut.isPending ? "Enviando…" : "Propor cancelamento"}
            </button>
          </div>
        </Modal>
      )}

      {/* Marcar indisponível */}
      {indispItemIds && (
        <Modal title="Marcar indisponível" onClose={() => setIndispItemIds(null)}>
          <p style={{ fontSize: 13 }}>
            Marcar {indispItemIds.length} ite{indispItemIds.length === 1 ? "m" : "ns"} como
            indisponível?
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <button className="wms-btn wms-btn-ghost" type="button" onClick={() => setIndispItemIds(null)}>
              Cancelar
            </button>
            <button
              className="wms-btn wms-btn-danger"
              type="button"
              disabled={indisponivelMut.isPending}
              onClick={() => indisponivelMut.mutate(indispItemIds)}
            >
              {indisponivelMut.isPending ? "Marcando…" : "Marcar indisponível"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// Kebab de ações por item — menu via portal no document.body (o card tem
// overflow:hidden e recortaria um dropdown absoluto interno).
function ItemKebab({
  onTrocarSku,
  onTrocarFornecedor,
  onIndisponivel,
  onPropostaCancelamento,
}: {
  onTrocarSku: () => void;
  onTrocarFornecedor: () => void;
  onIndisponivel: () => void;
  onPropostaCancelamento: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [coords, setCoords] = useState<{ top?: number; bottom?: number; right: number } | null>(null);

  const abrir = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const right = window.innerWidth - r.right;
    if (window.innerHeight - r.bottom < 180) {
      setCoords({ bottom: window.innerHeight - r.top + 4, right });
    } else {
      setCoords({ top: r.bottom + 4, right });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const fechar = () => setOpen(false);
    window.addEventListener("scroll", fechar, true);
    window.addEventListener("resize", fechar);
    return () => {
      window.removeEventListener("scroll", fechar, true);
      window.removeEventListener("resize", fechar);
    };
  }, [open]);

  const acao = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btnRef}
        className="wms-btn-icon"
        onClick={() => (open ? setOpen(false) : abrir())}
        title="Mais ações"
        type="button"
      >
        <Icon name="dots" size={12} />
      </button>
      {open &&
        coords &&
        createPortal(
          <div className="wms-root" style={{ display: "contents" }}>
            <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 1000 }} />
            <div
              style={{
                position: "fixed",
                top: coords.top,
                bottom: coords.bottom,
                right: coords.right,
                background: "var(--wms-c-panel)",
                border: "1px solid var(--wms-c-border)",
                borderRadius: "var(--wms-r-2)",
                boxShadow: "var(--wms-shadow-sm)",
                minWidth: 210,
                zIndex: 1001,
                padding: 4,
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <button className="wms-btn wms-btn-ghost wms-btn-sm" style={{ justifyContent: "flex-start" }} onClick={acao(onTrocarSku)} type="button">
                <Icon name="edit" size={11} /> Trocar SKU
              </button>
              <button className="wms-btn wms-btn-ghost wms-btn-sm" style={{ justifyContent: "flex-start" }} onClick={acao(onTrocarFornecedor)} type="button">
                <Icon name="edit" size={11} /> Trocar fornecedor
              </button>
              <button className="wms-btn wms-btn-ghost wms-btn-sm" style={{ justifyContent: "flex-start" }} onClick={acao(onIndisponivel)} type="button">
                <Icon name="x" size={11} /> Marcar indisponível
              </button>
              <button className="wms-btn wms-btn-ghost wms-btn-sm" style={{ justifyContent: "flex-start" }} onClick={acao(onPropostaCancelamento)} type="button">
                <Icon name="alert" size={11} /> Propor cancelamento
              </button>
            </div>
          </div>,
          document.body,
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
            {f.documentos.map((d, idx) => (
              <div
                key={`${d.origem}-${d.id}`}
                style={{
                  borderBottom:
                    idx < f.documentos.length - 1
                      ? "1px solid var(--wms-c-border)"
                      : undefined,
                }}
              >
                <button
                  className="wms-frc-row-doc"
                  style={{
                    cursor: "pointer",
                    width: "100%",
                    textAlign: "left",
                    borderBottom: 0,
                  }}
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
                    {f.galpao_nome === "Vários galpões" && d.galpao_nome ? (
                      <span
                        className="wms-pcard-chip is-galpao"
                        style={{ marginLeft: 6 }}
                      >
                        {d.galpao_nome}
                      </span>
                    ) : null}
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
                {d.pedidos_cobertos.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                      alignItems: "center",
                      padding: "0 0 9px 60px",
                    }}
                  >
                    <span className="wms-td-mute" style={{ fontSize: 11 }}>
                      destrava {d.pedidos_cobertos.length} pedido
                      {d.pedidos_cobertos.length === 1 ? "" : "s"}:
                    </span>
                    {d.pedidos_cobertos.slice(0, 8).map((p) => (
                      <span
                        key={p.pedido_id}
                        className="wms-badge wms-badge-ok wms-mono"
                        style={{ fontSize: 10 }}
                      >
                        #{p.numero}
                      </span>
                    ))}
                    {d.pedidos_cobertos.length > 8 && (
                      <span className="wms-td-mute" style={{ fontSize: 11 }}>
                        +{d.pedidos_cobertos.length - 8}
                      </span>
                    )}
                  </div>
                )}
              </div>
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
              <th>Comprado em</th>
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
                    {i.comprado_em
                      ? fmtDateTime(i.comprado_em)
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
