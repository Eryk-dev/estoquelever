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
  Field,
  Icon,
  Modal,
  fmtBRL,
  fmtNum,
} from "@/components/wms/ui/wms-ui";
import { useGalpoes } from "@/components/wms/ui/modals";
import { EquivalentesCompra } from "@/components/wms/compras/equivalentes-compra";
import {
  flattenItensPorSku,
  agruparCompra,
  filtrarOrdenarLinhas,
  agruparPorUrgencia,
  type CompraSelecionada,
  type LinhaCompra,
  type UrgenciaBucket,
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
  vendas_7d: number;
  vendas_30d: number;
  vendas_60d: number;
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

interface ExcecaoItem {
  id: string;
  sku: string;
  descricao: string;
  compra_status: "indisponivel" | "equivalente_pendente" | "cancelamento_pendente";
  numero_pedido: string;
  compra_equivalente_sku: string | null;
  compra_equivalente_descricao: string | null;
  compra_cancelamento_motivo: string | null;
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
  /** prévia legível dos SKUs pendentes (ex.: "FRM012, LIM017 +5"). */
  skus_preview?: string;
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

/** Pill de status da peça: esgotado vence o status de cobertura. */
function statusMeta(it: {
  estoque_livre: number;
  status_cobertura: StatusCobertura;
}): { txt: string; cls: string } {
  if (it.estoque_livre <= 0) return { txt: "Esgotado", cls: "is-esgotado" };
  switch (it.status_cobertura) {
    case "critico":
      return { txt: "Crítico", cls: "is-critico" };
    case "atencao":
    case "lead_time_risco":
      return { txt: "Atenção", cls: "is-atencao" };
    default:
      return { txt: "Saudável", cls: "is-ok" };
  }
}

/** Razão curta ao lado do SKU (cobertura). Vazio quando esgotado/sem giro. */
function reasonText(it: ComprarItem): string {
  if (it.estoque_livre <= 0 || it.dias_cobertura == null) return "";
  if (it.status_cobertura === "critico")
    return `acaba em ${it.dias_cobertura} ${it.dias_cobertura === 1 ? "dia" : "dias"}`;
  if (it.status_cobertura === "atencao" || it.status_cobertura === "lead_time_risco")
    return `cobertura ${it.dias_cobertura} dias`;
  return `cobertura ${it.dias_cobertura}+ dias`;
}

function reasonTitle(it: ComprarItem): string {
  const base =
    it.estoque_livre <= 0 ? "estoque zerado" : `${fmtNum(it.estoque_livre)} em estoque`;
  return `${base} · gira ${it.giro_diario.toFixed(1).replace(".", ",")}/dia · lead ${
    it.lead_time_medio ?? "?"
  } dias · ${fmtNum(it.em_transito)} a caminho`;
}

const BUCKET_META: Record<
  UrgenciaBucket,
  { label: string; hint: string; cls: string }
> = {
  esgotado: {
    label: "Esgotado — pedidos parados",
    hint: "ruptura: estoque zerado, comprar e enviar agora",
    cls: "is-esgotado",
  },
  critico: {
    label: "Crítico — comprar hoje",
    hint: "cobertura abaixo do lead time",
    cls: "is-critico",
  },
  atencao: {
    label: "Atenção — programe",
    hint: "cobertura curta, ainda dá tempo",
    cls: "is-atencao",
  },
  ok: { label: "Sem pressa", hint: "estoque confortável", cls: "is-ok" },
};

function fmtDia(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmtHora(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Título/detalhe/ação de cada exceção pro banner (réplica do design). */
function excecaoDisplay(e: ExcecaoItem): {
  titulo: string;
  detalhe: string;
  acaoLabel: string | null;
  tipo: "cancelamento" | "equivalente" | "indisponivel";
} {
  if (e.compra_status === "equivalente_pendente") {
    const eq = [e.compra_equivalente_sku, e.compra_equivalente_descricao]
      .filter(Boolean)
      .join(" ");
    return {
      titulo: `Equivalente sugerido — ${e.sku}`,
      detalhe: eq || `Pedido #${e.numero_pedido}`,
      acaoLabel: "Usar equivalente",
      tipo: "equivalente",
    };
  }
  if (e.compra_status === "cancelamento_pendente") {
    return {
      titulo: `Cancelamento proposto — ${e.sku}`,
      detalhe: e.compra_cancelamento_motivo
        ? `Pedido #${e.numero_pedido} · ${e.compra_cancelamento_motivo}`
        : `Pedido #${e.numero_pedido}`,
      acaoLabel: "Confirmar cancelamento",
      tipo: "cancelamento",
    };
  }
  return {
    titulo: `Indisponível — ${e.sku}`,
    detalhe: `Pedido #${e.numero_pedido}`,
    acaoLabel: null,
    tipo: "indisponivel",
  };
}

/** Classe de cor do galpão (pílula/chip) por nome — CWB/SP/BSB têm paleta própria. */
function galpaoCls(nome: string | null | undefined): string {
  const n = (nome ?? "").trim().toUpperCase();
  if (n === "CWB") return "is-cwb";
  if (n === "SP") return "is-sp";
  if (n === "BSB") return "is-bsb";
  return "";
}

// SVGs inline pros poucos ícones fora do set do design system.
const StarIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="m12 2 2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5.9 20.4l1.4-6.8L2.2 9l6.9-.7z" />
  </svg>
);
const ClockIcon = () => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--wms-c-mute)"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

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

  const tabBtn = (id: Tab, label: string, n: number | undefined, badge?: number) => (
    <button
      className={`wms-cmp-tab ${tab === id ? "is-active" : ""}`}
      onClick={() => setTab(id)}
      type="button"
    >
      {label} <span className="wms-cmp-tab-n">{n ?? "–"}</span>
      {badge && badge > 0 ? (
        <span className="wms-cmp-tab-badge" title="Exceções aguardando sua decisão">
          {badge}
        </span>
      ) : null}
    </button>
  );

  return (
    <>
      {/* Header */}
      <div className="wms-cmp-head">
        <div style={{ minWidth: 0 }}>
          <button
            className="wms-cmp-back"
            type="button"
            onClick={() => router.push("/wms")}
          >
            <Icon name="chevron-l" size={13} />
            Voltar ao WMS
          </button>
          <h1 className="wms-cmp-title">Compras</h1>
          <p className="wms-cmp-sub">
            O que comprar, o que receber e o que já entrou — consolidado por fornecedor.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="wms-btn wms-btn-ghost" onClick={refresh} type="button">
            <Icon name="rotate" size={13} />
            Atualizar
          </button>
          {podeExecutar && (
            <button
              className="wms-btn wms-btn-dark"
              onClick={() => router.push("/wms/compras/nova")}
              type="button"
            >
              <Icon name="plus" size={13} />
              Nova compra manual
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="wms-cmp-tabs">
        {tabBtn("comprar", "Comprar", counts?.comprar, counts?.excecoes)}
        {tabBtn("receber", "Receber", counts?.receber)}
        {tabBtn("historico", "Histórico", counts?.historico)}
      </div>

      {tab === "comprar" && (
        <TabComprar
          query={comprarQuery}
          onMutated={invalidateAll}
          podeExecutar={podeExecutar}
        />
      )}
      {tab === "receber" && <TabReceber query={receberQuery} />}
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
  const { data: galpoes = [] } = useGalpoes();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qtyOverrides, setQtyOverrides] = useState<Map<string, number>>(new Map());
  // Escolha de fornecedor por SKU (nome). Trocar o fornecedor reseta preço/galpão.
  const [fornecedorOverrides, setFornecedorOverrides] = useState<Map<string, string>>(
    new Map(),
  );
  // Preço por SKU (override do custo de catálogo) + galpão de entrega por SKU.
  const [precoOverrides, setPrecoOverrides] = useState<Map<string, number>>(new Map());
  const [galpaoOverrides, setGalpaoOverrides] = useState<Map<string, string>>(new Map());
  // Toolbar
  const [busca, setBusca] = useState("");
  const [filtroFornecedor, setFiltroFornecedor] = useState("");
  const [filtroGalpao, setFiltroGalpao] = useState("");
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

  const galpaoNomeById = useMemo(
    () => new Map(galpoes.map((g) => [g.id, g.nome] as const)),
    [galpoes],
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

  const setQty = useCallback((sku: string, value: number) => {
    setQtyOverrides((prev) => new Map(prev).set(sku, Math.max(0, value)));
  }, []);

  // Trocar fornecedor zera preço/galpão override do SKU (re-defaultam pro novo).
  const setFornecedorOverride = useCallback((sku: string, nome: string) => {
    setFornecedorOverrides((prev) => new Map(prev).set(sku, nome));
    setPrecoOverrides((prev) => {
      const next = new Map(prev);
      next.delete(sku);
      return next;
    });
    setGalpaoOverrides((prev) => {
      const next = new Map(prev);
      next.delete(sku);
      return next;
    });
  }, []);

  const setPrecoOverride = useCallback((sku: string, raw: string) => {
    const v = parseFloat(raw.replace(",", "."));
    setPrecoOverrides((prev) => {
      const next = new Map(prev);
      if (Number.isNaN(v)) next.delete(sku);
      else next.set(sku, Math.max(0, v));
      return next;
    });
  }, []);

  const setGalpaoOverride = useCallback((sku: string, id: string) => {
    setGalpaoOverrides((prev) => new Map(prev).set(sku, id));
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

  // ── Linhas resolvidas (fornecedor/galpão/preço escolhidos) ──
  type LinhaItem = LinhaCompra & {
    item: ComprarItem;
    opcao: FornecedorOpcao | null;
    price: number | null;
    catalogo: number | null;
    reajustado: boolean;
    reajusteUp: boolean;
  };
  const linhas = useMemo<LinhaItem[]>(
    () =>
      itens.map((it) => {
        const opc = getFornecedorOpcao(it);
        const galpaoId = galpaoOverrides.get(it.sku) ?? opc?.galpao_id ?? null;
        const galpaoNome = galpaoId
          ? (galpaoNomeById.get(galpaoId) ?? opc?.galpao_nome ?? galpaoId)
          : null;
        const catalogo = opc?.custo_unitario ?? null;
        const ov = precoOverrides.get(it.sku);
        const price = ov !== undefined ? ov : catalogo;
        const reajustado =
          catalogo != null && price != null && Math.abs(price - catalogo) > 0.001;
        return {
          sku: it.sku,
          descricao: it.descricao,
          fornecedorNome: opc?.nome ?? "Sem fornecedor",
          galpaoId,
          galpaoNome,
          quantidade: getQty(it),
          aging_dias: it.aging_dias,
          item: it,
          opcao: opc,
          price,
          catalogo,
          reajustado,
          reajusteUp: reajustado && price! > catalogo!,
        };
      }),
    [itens, getFornecedorOpcao, getQty, galpaoOverrides, precoOverrides, galpaoNomeById],
  );

  const fornecedorOpcoesFiltro = useMemo(
    () =>
      [...new Set(linhas.map((l) => l.fornecedorNome))].sort((a, b) =>
        a.localeCompare(b, "pt-BR"),
      ),
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
      }),
    [linhas, busca, filtroFornecedor, filtroGalpao],
  );

  const buckets = useMemo(
    () => agruparPorUrgencia(linhasVisiveis, (l) => l.item),
    [linhasVisiveis],
  );

  // ── KPIs (sobre o que está visível) ──
  const stats = useMemo(() => {
    const esgotadas = linhasVisiveis.filter((l) => l.item.estoque_livre <= 0);
    return {
      pecas: linhasVisiveis.length,
      esgotadas: esgotadas.length,
      pedidos: esgotadas.reduce((a, l) => a + l.item.pedidos.length, 0),
      valor: linhasVisiveis.reduce(
        (a, l) => a + (l.price != null ? l.price * l.quantidade : 0),
        0,
      ),
    };
  }, [linhasVisiveis]);

  // ── Seleção (apenas o que está visível) ──
  const selLines = useMemo(
    () => linhasVisiveis.filter((l) => selected.has(l.sku)),
    [linhasVisiveis, selected],
  );
  const selQty = selLines.reduce((a, l) => a + l.quantidade, 0);
  const selValor = selLines.reduce(
    (a, l) => a + (l.price != null ? l.price * l.quantidade : 0),
    0,
  );
  const allChecked = linhasVisiveis.length > 0 && selLines.length === linhasVisiveis.length;
  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (linhasVisiveis.every((l) => next.has(l.sku))) {
        linhasVisiveis.forEach((l) => next.delete(l.sku));
      } else {
        linhasVisiveis.forEach((l) => next.add(l.sku));
      }
      return next;
    });
  }, [linhasVisiveis]);

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
              ...(s.custoUnitario != null && s.custoUnitario > 0
                ? { preco_unitario: s.custoUnitario }
                : {}),
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
    for (const l of selLines) {
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
        custoUnitario: l.price != null && l.price > 0 ? l.price : null,
        pedidosCobertos: l.item.pedidos.map((p) => ({ numero: p.numero })),
      });
    }
    if (semGalpao.length > 0) {
      toast.error(`Sem galpão de entrega: ${semGalpao.join(", ")}. Escolha o galpão na linha.`);
      return;
    }
    if (sel.length === 0) {
      toast.error("Nenhum item válido selecionado");
      return;
    }
    setConfirmSel(sel);
  }, [selLines]);

  const onMarcarIndisponivelBulk = useCallback(() => {
    const itemIds: string[] = [];
    for (const l of selLines) {
      for (const p of l.item.pedidos) if (p.item_id) itemIds.push(p.item_id);
    }
    if (itemIds.length === 0) {
      toast.error("Nenhum item selecionado");
      return;
    }
    setIndispItemIds(itemIds);
  }, [selLines]);

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

  return (
    <>
      {excecoes.length > 0 && (
        <div className="wms-cmp-exc">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--wms-c-warn)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flex: "none", marginTop: 1 }}
            aria-hidden
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <path d="M12 9v4M12 17h.01" />
          </svg>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="wms-cmp-exc-h">
              {excecoes.length} exceç{excecoes.length === 1 ? "ão" : "ões"} aguardando sua decisão
            </div>
            {excecoes.map((e) => {
              const d = excecaoDisplay(e);
              const pend = pendingExcId === e.id;
              return (
                <div key={e.id} className="wms-cmp-exc-row">
                  <div style={{ minWidth: 0 }}>
                    <span style={{ fontWeight: 600, fontSize: 12.5 }}>{d.titulo}</span>
                    <span style={{ color: "var(--wms-c-mute)", fontSize: 12 }}> — {d.detalhe}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, flex: "none" }}>
                    {d.acaoLabel && (
                      <button
                        className="wms-cmp-exc-go"
                        type="button"
                        disabled={pend}
                        onClick={() =>
                          d.tipo === "equivalente"
                            ? confirmarEquivalenteMut.mutate(e.id)
                            : confirmarCancelamentoMut.mutate(e.id)
                        }
                      >
                        {d.acaoLabel}
                      </button>
                    )}
                    <button
                      className="wms-cmp-exc-back"
                      type="button"
                      disabled={pend}
                      onClick={() => devolverMut.mutate(e.id)}
                    >
                      Devolver à fila
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* KPIs */}
      <div className="wms-cmp-kpis">
        <div className="wms-cmp-kpi">
          <div className="wms-cmp-kpi-n">{fmtNum(stats.pecas)}</div>
          <div className="wms-cmp-kpi-l">peças na fila de compra</div>
        </div>
        <div className="wms-cmp-kpi is-danger">
          <div className="wms-cmp-kpi-n">{fmtNum(stats.esgotadas)}</div>
          <div className="wms-cmp-kpi-l">esgotadas — sem estoque</div>
        </div>
        <div className="wms-cmp-kpi">
          <div className="wms-cmp-kpi-n">{fmtNum(stats.pedidos)}</div>
          <div className="wms-cmp-kpi-l">pedidos parados na ruptura</div>
        </div>
        <div className="wms-cmp-kpi">
          <div className="wms-cmp-kpi-n">{fmtBRL(stats.valor)}</div>
          <div className="wms-cmp-kpi-l">custo estimado da fila</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="wms-cmp-toolbar">
        <div className="wms-cmp-search">
          <span>
            <Icon name="search" size={14} />
          </span>
          <input
            className="wms-cmp-searchin"
            placeholder="Buscar peça, SKU ou fornecedor…"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
        </div>
        <select
          className="wms-cmp-select"
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
          className="wms-cmp-select"
          value={filtroGalpao}
          onChange={(e) => setFiltroGalpao(e.target.value)}
          title="Filtrar por galpão de entrega"
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
            className="wms-cmp-clear"
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
          <h3>Nenhuma peça na fila de compra</h3>
          <p>Quando pedidos precisarem de compra, as peças aparecem aqui, da mais urgente para a menos.</p>
        </div>
      ) : buckets.length === 0 ? (
        <div className="wms-empty-block">
          <h3>Nenhuma peça com esses filtros</h3>
          <p>Ajuste a busca ou os filtros acima.</p>
        </div>
      ) : (
        <div className="wms-cmp-list">
          {/* Cabeçalho de colunas */}
          <div className="wms-cmp-colhead">
            <label style={{ display: "flex", alignItems: "center", cursor: "pointer" }}>
              <input
                type="checkbox"
                className="wms-cmp-check"
                checked={allChecked}
                onChange={toggleAll}
              />
            </label>
            <span />
            <span>Peça e urgência</span>
            <span style={{ textAlign: "center" }}>Comprar</span>
            <span>De quem</span>
            <span>Entrega</span>
            <span />
          </div>

          {buckets.map((b) => {
            const meta = BUCKET_META[b.bucket];
            return (
              <div key={b.bucket}>
                <div className={`wms-cmp-bucket ${meta.cls}`}>
                  <span className="wms-cmp-bucket-dot" />
                  <span className="wms-cmp-bucket-l">{meta.label}</span>
                  <span className="wms-cmp-bucket-n">{b.linhas.length}</span>
                  <span className="wms-cmp-bucket-hint">{meta.hint}</span>
                </div>
                {b.linhas.map((l) => (
                  <CompraRow
                    key={l.sku}
                    l={l}
                    galpoes={galpoes}
                    checked={selected.has(l.sku)}
                    expanded={expanded.has(l.sku)}
                    onToggleCheck={() => toggleCheckbox(l.sku)}
                    onToggleExpand={() => toggleExpand(l.sku)}
                    onQty={(v) => setQty(l.sku, v)}
                    onSupplier={(nome) => setFornecedorOverride(l.sku, nome)}
                    onPrice={(raw) => setPrecoOverride(l.sku, raw)}
                    onGalpao={(id) => setGalpaoOverride(l.sku, id)}
                    onTrocarSku={() => {
                      setTrocaSkuAlvo(l.item);
                      setTrocaSkuNovo(l.item.sku);
                      setTrocaSkuErro(null);
                    }}
                    onTrocarFornecedor={() => {
                      setTrocaFornAlvo(l.item);
                      setTrocaFornNome("");
                    }}
                    onIndisponivel={() => {
                      const ids = l.item.pedidos.map((p) => p.item_id).filter(Boolean);
                      if (ids.length) setIndispItemIds(ids);
                    }}
                    onPropostaCancelamento={() => {
                      setCancelAlvo(l.item);
                      setCancelMotivo("");
                    }}
                    onEquivAplicado={() =>
                      queryClient.invalidateQueries({ queryKey: ["wms-compras"] })
                    }
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* Barra de ação (navy + cyan) */}
      {selLines.length > 0 && (
        <div className="wms-cmp-actionbar-wrap">
          <div className="wms-cmp-actionbar">
            <div className="wms-cmp-ab-info">
              <span>
                <b style={{ fontSize: 15 }}>{selLines.length}</b>{" "}
                {selLines.length === 1 ? "peça selecionada" : "peças selecionadas"}
              </span>
              <span className="wms-cmp-ab-sep" />
              <span className="wms-cmp-ab-dim">
                {fmtNum(selQty)} un · <b style={{ color: "#fff" }}>{fmtBRL(selValor)}</b>
              </span>
            </div>
            <div className="wms-cmp-ab-btns">
              <button
                className="wms-cmp-ab-ghost"
                type="button"
                onClick={() => {
                  setSelected(new Set());
                  setQtyOverrides(new Map());
                }}
              >
                Limpar
              </button>
              <button
                className="wms-cmp-ab-ghost"
                type="button"
                disabled={indisponivelMut.isPending || !podeExecutar}
                onClick={onMarcarIndisponivelBulk}
              >
                Marcar indisponível
              </button>
              <button
                className="wms-cmp-ab-go"
                type="button"
                disabled={comprarMut.isPending || !podeExecutar}
                title={!podeExecutar ? "Sem permissão pra comprar" : ""}
                onClick={onGerar}
              >
                {comprarMut.isPending ? "Gerando…" : "Gerar compra"}
                <Icon name="arrow-right" size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de confirmação */}
      {confirmSel && (
        <Modal
          title={`Confirmar ${confirmPreview.length} compra${confirmPreview.length === 1 ? "" : "s"}`}
          subtitle="Agrupadas por fornecedor e galpão automaticamente — você não agrupa na mão."
          onClose={() => setConfirmSel(null)}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {confirmPreview.map((g) => (
              <div
                key={`${g.fornecedorNome}::${g.galpaoId}`}
                style={{
                  border: "1px solid var(--wms-c-border)",
                  borderRadius: "var(--wms-r-3)",
                  padding: "13px 15px",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "center",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5, display: "flex", alignItems: "center", gap: 7 }}>
                    {g.fornecedorNome} <span style={{ color: "var(--wms-c-mute-2)" }}>→</span>{" "}
                    <span className={`wms-cmp-gchip ${galpaoCls(g.galpaoNome)}`}>{g.galpaoNome}</span>
                  </div>
                  <div className="wms-td-mute" style={{ fontSize: 12, marginTop: 4 }}>
                    {g.itens.map((i) => i.sku).join(", ")}
                  </div>
                  {g.pedidosCobertos.length > 0 && (
                    <div style={{ fontSize: 11.5, color: "var(--wms-c-ok)", marginTop: 4, fontWeight: 500 }}>
                      destrava {g.pedidosCobertos.map((n) => `#${n}`).join(" ")}
                    </div>
                  )}
                </div>
                <span
                  className="wms-mono"
                  style={{
                    fontWeight: 600,
                    fontSize: 12.5,
                    background: "var(--wms-c-info-bg)",
                    color: "var(--wms-c-info)",
                    padding: "5px 11px",
                    borderRadius: "var(--wms-r-2)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {fmtNum(g.qtyTotal)} un{g.custoTotal != null ? ` · ${fmtBRL(g.custoTotal)}` : ""}
                </span>
              </div>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              marginTop: 16,
            }}
          >
            <span className="wms-td-mute" style={{ fontSize: 12.5 }}>
              Total estimado{" "}
              <b className="wms-mono" style={{ color: "var(--wms-c-fg)" }}>
                {fmtBRL(confirmPreview.reduce((a, g) => a + (g.custoTotal ?? 0), 0))}
              </b>
            </span>
            <div style={{ display: "flex", gap: 8 }}>
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
          </div>
        </Modal>
      )}

      {/* Trocar fornecedor (lista completa, persiste) */}
      {trocaFornAlvo && (
        <Modal title={`Trocar fornecedor — ${trocaFornAlvo.sku}`} onClose={() => setTrocaFornAlvo(null)}>
          <Field label="Novo fornecedor">
            <select
              className="wms-cmp-select"
              style={{ width: "100%" }}
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

// ── Linha de compra ─────────────────────────────────────────────────

type LinhaCompraRow = LinhaCompra & {
  item: ComprarItem;
  opcao: FornecedorOpcao | null;
  price: number | null;
  catalogo: number | null;
  reajustado: boolean;
  reajusteUp: boolean;
};

function CompraRow({
  l,
  galpoes,
  checked,
  expanded,
  onToggleCheck,
  onToggleExpand,
  onQty,
  onSupplier,
  onPrice,
  onGalpao,
  onTrocarSku,
  onTrocarFornecedor,
  onIndisponivel,
  onPropostaCancelamento,
  onEquivAplicado,
}: {
  l: LinhaCompraRow;
  galpoes: { id: string; nome: string }[];
  checked: boolean;
  expanded: boolean;
  onToggleCheck: () => void;
  onToggleExpand: () => void;
  onQty: (v: number) => void;
  onSupplier: (nome: string) => void;
  onPrice: (raw: string) => void;
  onGalpao: (id: string) => void;
  onTrocarSku: () => void;
  onTrocarFornecedor: () => void;
  onIndisponivel: () => void;
  onPropostaCancelamento: () => void;
  onEquivAplicado: () => void;
}) {
  const item = l.item;
  const meta = statusMeta(item);
  const qty = l.quantidade;
  const reason = reasonText(item);
  const cobreCompra =
    item.giro_diario > 0
      ? qty <= 0
        ? "0 dias"
        : `~${Math.round(qty / item.giro_diario)} dias`
      : "—";

  return (
    <div className="wms-cmp-rowwrap">
      <div className={`wms-cmp-row ${checked ? "is-checked" : ""}`}>
        <label style={{ display: "flex", alignItems: "center", cursor: "pointer", height: 42 }}>
          <input type="checkbox" className="wms-cmp-check" checked={checked} onChange={onToggleCheck} />
        </label>

        {/* Thumb */}
        <div className="wms-cmp-thumb">
          {item.imagem_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.imagem_url} alt="" loading="lazy" />
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--wms-c-mute-2)" strokeWidth="1.6" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-5-5L5 21" />
            </svg>
          )}
        </div>

        {/* Peça e urgência */}
        <div className="wms-cmp-peca">
          <div className="wms-cmp-desc" title={item.descricao}>
            {item.descricao}
          </div>
          <div className="wms-cmp-meta">
            <span className="wms-cmp-sku">{item.sku}</span>
            <span className={`wms-cmp-pill ${meta.cls}`}>{meta.txt}</span>
            {reason && (
              <span className="wms-cmp-reason" title={reasonTitle(item)}>
                · {reason}
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div className="wms-cmp-vchip" title="Quantidade vendida no período">
              <span className="wms-cmp-vcell">
                <span className="wms-cmp-vk">7d</span>
                <span className="wms-cmp-vv">{fmtNum(item.vendas_7d)}</span>
              </span>
              <span className="wms-cmp-vcell">
                <span className="wms-cmp-vk">30d</span>
                <span className="wms-cmp-vv">{fmtNum(item.vendas_30d)}</span>
              </span>
              <span className="wms-cmp-vcell">
                <span className="wms-cmp-vk">60d</span>
                <span className="wms-cmp-vv">{fmtNum(item.vendas_60d)}</span>
              </span>
            </div>
            {item.pedidos.length > 0 && (
              <button type="button" className="wms-cmp-expand" onClick={onToggleExpand}>
                <span className={`wms-cmp-caret ${expanded ? "is-open" : ""}`}>▸</span>{" "}
                {item.pedidos.length} pedido{item.pedidos.length === 1 ? " vinculado" : "s vinculados"}
              </button>
            )}
          </div>
        </div>

        {/* Comprar (stepper) */}
        <div className="wms-cmp-buy">
          <div className="wms-cmp-step">
            <button type="button" className="wms-cmp-step-btn" onClick={() => onQty(Math.max(0, qty - 1))}>
              <Icon name="minus" size={13} />
            </button>
            <input
              type="number"
              min={0}
              className="wms-cmp-step-in"
              value={qty}
              onChange={(e) => onQty(parseInt(e.target.value || "0", 10) || 0)}
            />
            <button type="button" className="wms-cmp-step-btn" onClick={() => onQty(qty + 1)}>
              <Icon name="plus" size={13} />
            </button>
          </div>
          <span className="wms-cmp-falta">necessário {fmtNum(item.quantidade_necessaria)}</span>
          <span className="wms-cmp-cover" title="Dias de venda que a quantidade comprada cobre, no ritmo atual">
            <ClockIcon /> cobre <b>{cobreCompra}</b>
          </span>
        </div>

        {/* De quem */}
        <div className="wms-cmp-forn">
          <select
            className="wms-cmp-select wms-cmp-select-sm"
            value={l.opcao?.nome ?? ""}
            onChange={(e) => onSupplier(e.target.value)}
          >
            {item.fornecedores.length === 0 && <option value="">Sem fornecedor</option>}
            {item.fornecedores.map((f) => (
              <option key={f.nome} value={f.nome}>
                {f.nome}
              </option>
            ))}
          </select>
          <div className="wms-cmp-forn-meta">
            {l.price != null && (
              <span className="wms-cmp-price" title={l.reajustado ? `Reajustado de ${fmtBRL(l.catalogo)} (catálogo)` : "Preço de catálogo"}>
                <span>R$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="wms-cmp-price-in"
                  // Uncontrolled: remonta só quando o fornecedor muda (reseta pro
                  // custo de catálogo do novo). Digitar não re-renderiza o input.
                  key={`${l.sku}::${l.fornecedorNome}`}
                  defaultValue={l.price.toFixed(2)}
                  onChange={(e) => onPrice(e.target.value)}
                />
              </span>
            )}
            {l.reajustado && (
              <span className="wms-cmp-reaj" title={`Reajustado de ${fmtBRL(l.catalogo)} (catálogo)`}>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ transform: l.reajusteUp ? "none" : "rotate(90deg)" }}
                  aria-hidden
                >
                  <path d="M7 17 17 7M9 7h8v8" />
                </svg>
                reajuste
              </span>
            )}
            {l.opcao?.lead_time_dias_medio != null && (
              <span className="wms-cmp-lead">{l.opcao.lead_time_dias_medio}d lead</span>
            )}
            {l.opcao?.preferencial && (
              <span className="wms-cmp-star" title="Fornecedor preferencial">
                <StarIcon />
              </span>
            )}
          </div>
        </div>

        {/* Entrega (galpão editável, default = galpão do fornecedor) */}
        <div>
          <select
            className={`wms-cmp-galp ${l.galpaoId ? galpaoCls(l.galpaoNome) : "is-empty"}`}
            title="Galpão de entrega"
            value={l.galpaoId ?? ""}
            onChange={(e) => onGalpao(e.target.value)}
          >
            {!l.galpaoId && <option value="">galpão?</option>}
            {galpoes.map((g) => (
              <option key={g.id} value={g.id}>
                {g.nome}
              </option>
            ))}
          </select>
        </div>

        {/* Kebab */}
        <div className="wms-cmp-kebab">
          <ItemKebab
            onTrocarFornecedor={onTrocarFornecedor}
            onTrocarSku={onTrocarSku}
            onIndisponivel={onIndisponivel}
            onPropostaCancelamento={onPropostaCancelamento}
          />
        </div>
      </div>

      {/* Expand: pedidos + equivalentes */}
      {expanded && (
        <div className="wms-cmp-ped">
          <div className="wms-cmp-ped-h">Pedidos esperando esta peça</div>
          <div className="wms-cmp-ped-list">
            {item.pedidos.map((p) => (
              <div key={p.item_id} className="wms-cmp-ped-row">
                <span className="wms-cmp-ped-num">#{p.numero}</span>
                <span
                  className="wms-td-mute"
                  style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {p.cliente_nome}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--wms-c-mute)" }}>
                  entrega em {p.galpao_nome ?? "—"}
                </span>
                <span className="wms-mono">{fmtNum(p.quantidade)} un</span>
                <span className="wms-tar wms-td-mute wms-mono" style={{ fontSize: 11 }}>
                  {p.aging_dias}d
                </span>
              </div>
            ))}
          </div>
          <EquivalentesCompra
            sku={item.sku}
            itemIds={item.pedidos.map((p) => p.item_id)}
            onAplicado={onEquivAplicado}
          />
        </div>
      )}
    </div>
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
    if (window.innerHeight - r.bottom < 200) {
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
        <Icon name="dots" size={16} />
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
                borderRadius: "var(--wms-r-3)",
                boxShadow: "var(--wms-shadow-sm)",
                minWidth: 200,
                zIndex: 1001,
                padding: 5,
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <button className="wms-btn wms-btn-ghost wms-btn-sm" style={{ justifyContent: "flex-start" }} onClick={acao(onTrocarFornecedor)} type="button">
                <Icon name="shuffle" size={11} /> Trocar fornecedor
              </button>
              <button className="wms-btn wms-btn-ghost wms-btn-sm" style={{ justifyContent: "flex-start" }} onClick={acao(onTrocarSku)} type="button">
                <Icon name="edit" size={11} /> Trocar SKU
              </button>
              <div style={{ height: 1, background: "var(--wms-c-border)", margin: "4px 6px" }} />
              <button className="wms-btn wms-btn-ghost wms-btn-sm" style={{ justifyContent: "flex-start", color: "var(--wms-c-danger)" }} onClick={acao(onIndisponivel)} type="button">
                <Icon name="x" size={11} /> Marcar indisponível
              </button>
              <button className="wms-btn wms-btn-ghost wms-btn-sm" style={{ justifyContent: "flex-start", color: "var(--wms-c-danger)" }} onClick={acao(onPropostaCancelamento)} type="button">
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
    <div>
      <p style={{ margin: "0 0 14px", color: "var(--wms-c-mute)", fontSize: 12.5 }}>
        Cada bloco é uma entrega esperada na doca. Abra para conferir e dar entrada no estoque.
      </p>
      {fornecedores.map((f) => (
        <div
          key={f.fornecedor}
          style={{
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
            borderLeft: "3px solid var(--wms-c-border-2)",
            borderRadius: "var(--wms-r-3)",
            marginBottom: 12,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              padding: "11px 15px",
              borderBottom: "1px solid var(--wms-c-border)",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600 }}>{f.fornecedor}</div>
            {f.galpao_nome && (
              <span className={`wms-cmp-gchip ${galpaoCls(f.galpao_nome)}`}>{f.galpao_nome}</span>
            )}
          </div>
          {f.documentos.map((d) => (
            <div key={`${d.origem}-${d.id}`}>
              <button className="wms-cmp-doc" onClick={() => router.push(d.href)} type="button">
                <span
                  className={`wms-cmp-doc-origem ${
                    d.origem === "manual" ? "wms-badge wms-badge-warn" : "wms-badge wms-badge-info"
                  }`}
                >
                  {d.origem === "manual" ? "Manual" : "OC"}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="wms-cmp-doc-num">
                    {d.origem === "manual" ? "Compra" : "OC"} #{d.id.slice(0, 8)}
                  </span>
                  <span className="wms-cmp-doc-skus">
                    {d.skus_preview && d.skus_preview.length > 0
                      ? d.skus_preview
                      : `${d.skus_count} SKU${d.skus_count === 1 ? "" : "s"}`}
                    {f.galpao_nome === "Vários galpões" && d.galpao_nome ? ` · ${d.galpao_nome}` : ""}
                  </span>
                </span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--wms-c-fg-2)" }}>
                  {fmtNum(d.qty_pendente)} un pend.
                </span>
                <span className="wms-mono" style={{ fontSize: 12.5, color: "var(--wms-c-fg-2)" }}>
                  {d.custo_total != null ? fmtBRL(d.custo_total) : "—"}
                </span>
                <span className="wms-td-mute wms-mono" style={{ fontSize: 11.5 }}>
                  {d.criado_em ? fmtHora(d.criado_em) : "—"}
                </span>
                <span style={{ justifySelf: "end", color: "var(--wms-c-mute-2)", display: "flex" }}>
                  <Icon name="chevron-r" size={16} />
                </span>
              </button>
              {d.pedidos_cobertos.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    alignItems: "center",
                    padding: "0 0 9px 79px",
                  }}
                >
                  <span className="wms-td-mute" style={{ fontSize: 11 }}>
                    destrava {d.pedidos_cobertos.length} pedido
                    {d.pedidos_cobertos.length === 1 ? "" : "s"}:
                  </span>
                  {d.pedidos_cobertos.slice(0, 8).map((p) => (
                    <span key={p.pedido_id} className="wms-badge wms-badge-ok wms-mono" style={{ fontSize: 10 }}>
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
      ))}
    </div>
  );
}

// ── Tab Histórico ───────────────────────────────────────────────────

interface HistLinha {
  hora: string;
  fornecedor: string;
  sku: string;
  produto: string;
  qtd: number;
  ts: string;
}

function TabHistorico({
  query,
}: {
  query: ReturnType<typeof useInfiniteQuery<HistoricoResponse>>;
}) {
  // Reagrupa todos os itens de todas as páginas por DIA (o backend agrupa por
  // fornecedor+data; aqui a UI mostra um cabeçalho de dia + linhas por item).
  const dias = useMemo(() => {
    const fornecedores = query.data?.pages?.flatMap((p) => p.fornecedores) ?? [];
    const byDia = new Map<string, HistLinha[]>();
    for (const f of fornecedores) {
      for (const i of f.itens) {
        const ts = i.comprado_em ?? f.data_recebimento;
        const dia = (ts ?? "sem-data").substring(0, 10);
        const arr = byDia.get(dia) ?? [];
        arr.push({
          hora: fmtHora(i.comprado_em),
          fornecedor: f.fornecedor,
          sku: i.sku,
          produto: i.descricao,
          qtd: i.quantidade_recebida,
          ts: ts ?? "",
        });
        byDia.set(dia, arr);
      }
    }
    return [...byDia.entries()]
      .sort((a, b) => {
        // datas reais primeiro (desc); "sem-data" sempre por último.
        if (a[0] === "sem-data") return 1;
        if (b[0] === "sem-data") return -1;
        return b[0].localeCompare(a[0]);
      })
      .map(([dia, rows]) => ({
        dia,
        label: dia === "sem-data" ? "Sem data" : fmtDia(dia),
        rows: rows.sort((a, b) => b.ts.localeCompare(a.ts)),
      }));
  }, [query.data]);

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

  if (dias.length === 0) {
    return (
      <div className="wms-empty-block">
        <h3>Sem histórico</h3>
        <p>Recebimentos confirmados aparecem aqui.</p>
      </div>
    );
  }

  return (
    <>
      <div className="wms-cmp-hist">
        <div className="wms-cmp-hist-head">
          <span>Comprado em</span>
          <span>Fornecedor</span>
          <span>SKU</span>
          <span>Produto</span>
          <span className="wms-tar">Qtd</span>
        </div>
        {dias.map((d) => (
          <div key={d.dia}>
            <div className="wms-cmp-hist-day">{d.label}</div>
            {d.rows.map((r, idx) => (
              <div key={`${d.dia}-${r.sku}-${idx}`} className="wms-cmp-hist-row">
                <span className="wms-mono wms-td-mute" style={{ fontSize: 12 }}>
                  {r.hora}
                </span>
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.fornecedor}
                </span>
                <span className="wms-mono" style={{ fontSize: 12, color: "var(--wms-c-fg-2)" }}>
                  {r.sku}
                </span>
                <span
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: "var(--wms-c-fg-2)",
                  }}
                >
                  {r.produto}
                </span>
                <span className="wms-tar wms-mono" style={{ fontWeight: 600 }}>
                  {fmtNum(r.qtd)}
                </span>
              </div>
            ))}
          </div>
        ))}
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
