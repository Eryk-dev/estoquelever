"use client";

// Tela WMS de Separação — wrappeada pelo `WmsShell` via `app/wms/layout.tsx`.
// Paridade funcional total com /separacao legado:
//   - 6 tabs por status_separacao (validacao_oc agrupado em aguardando_separacao)
//   - Multi-select com Shift-range
//   - Ações em lote SEMPRE visíveis quando há pedidos na tab (operam em selection
//     ou em todos os pedidos da tab quando não há selection)
//   - Sistema de tags (modal add/remove + quick-add com tags existentes)
//   - "Embalar com etiqueta" no separado (botão diferenciado quando há mix)
//   - Aviso amber "X sem etiqueta" no separado
//   - Encaminhar pra outro galpão (dropdown inline por linha, admin only)
//   - Forçar pendente (admin only, tab aguardando_nf)
//   - Mover etapa (admin) — dropdown "Voltar para / Avançar para"
//   - Realtime via useRealtimeSeparacao()
//
// Decisões em vigor:
//   D3 — filtro global de galpão aplica server-side via header X-Galpao-Id
//   D4 — empresa NÃO é exposta no toolbar nem nos cards
//   D6 — usa <DecisaoLabel> pra mostrar a decisão final por pedido

import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { sisoFetch, useAuth, usePermissoes } from "@/lib/auth-context";
import { useRealtimeSeparacao } from "@/hooks/use-realtime-separacao";
import { useTrackPresencaWms } from "@/hooks/use-presenca-wms";
import { FotoProdutoZoom } from "@/components/wms/produto-lightbox";
import {
  Icon,
  PageHeader,
  StatusBadge,
  fmtNum,
  fmtRelative,
} from "@/components/wms/ui/wms-ui";
import {
  TabsStatusSeparacao,
  type TabIdStatusSeparacao,
} from "@/components/wms/vendas/tabs-status-separacao";
import { DecisaoLabel } from "@/components/wms/vendas/estoque-por-galpao-bar";

// ─── Types ────────────────────────────────────────────────────────────────

type Tab = TabIdStatusSeparacao;
type StatusServer =
  | "aguardando_compra"
  | "aguardando_nf"
  | "validacao_oc"
  | "aguardando_separacao"
  | "em_separacao"
  | "separado"
  | "embalado"
  | "conferido"
  | "pendente_realocacao";

interface CompraStatsItem {
  sku: string;
  descricao: string | null;
  quantidade: number;
  compra_status: string | null;
  fornecedor_oc: string | null;
  imagem_url: string | null;
}

interface CompraStats {
  total: number;
  aguardando: number;
  comprado: number;
  recebido: number;
  indisponivel: number;
  equivalente_pendente: number;
  cancelamento_pendente: number;
  oc_pendente: number;
  itens: CompraStatsItem[];
}

interface SeparacaoPedido {
  id: string;
  numero_nf: string | null;
  numero_ec: string | null;
  numero_pedido: string | null;
  cliente: string | null;
  nome_ecommerce: string | null;
  uf: string | null;
  cidade: string | null;
  forma_envio: string | null;
  data_pedido: string | null;
  prazo_envio: string | null;
  embalagem_concluida_em: string | null;
  empresa_origem_nome: string | null; // ignorado (D4)
  filial_origem: string | null;
  decisao_final: "propria" | "transferencia" | "oc" | null;
  status_separacao: StatusServer;
  marcadores: string[];
  total_itens: number;
  itens_marcados: number;
  itens_bipados: number;
  galpao_id: string | null;
  compra_stats: CompraStats | null;
  etiqueta_status: string | null;
  etiqueta_pronta: boolean;
  nf_emitida: boolean;
  agrupamento_criado: boolean;
  separacao_tags: string[];
  encaminhado_de: string | null;
}

interface SeparacaoResponse {
  counts: Record<StatusServer, number>;
  pedidos: SeparacaoPedido[];
  empresas: { id: string; nome: string }[]; // usado no filtro de empresa
  galpoes: { id: string; nome: string }[];
}

// ─── Constants ────────────────────────────────────────────────────────────

const TAB_TO_STATUS: Record<Tab, StatusServer[]> = {
  aguardando_compra: ["aguardando_compra"],
  aguardando_nf: ["aguardando_nf"],
  aguardando_separacao: ["aguardando_separacao", "validacao_oc"],
  em_separacao: ["em_separacao"],
  separado: ["separado"],
  embalado: ["embalado"],
  conferido: ["conferido"],
  pendente_realocacao: ["pendente_realocacao"],
};

const TAB_EMPTY: Record<Tab, { title: string; body: string }> = {
  aguardando_compra: {
    title: "Nenhum pedido aguardando OC",
    body: "Pedidos sem estoque que dependem de compras aparecem aqui.",
  },
  aguardando_nf: {
    title: "Nenhum pedido aguardando NF",
    body: "Pedidos que ainda dependem de emissão de nota fiscal aparecem aqui.",
  },
  aguardando_separacao: {
    title: "Fila vazia",
    body: "Pedidos prontos pra começar a separação aparecem aqui.",
  },
  em_separacao: {
    title: "Nenhum pedido em separação",
    body: "Pedidos com wave picking em andamento aparecem aqui.",
  },
  separado: {
    title: "Nenhum pedido separado",
    body: "Pedidos prontos pra embalagem aparecem aqui.",
  },
  embalado: {
    title: "Nenhum pedido embalado",
    body: "Pedidos embalados e prontos pra expedição aparecem aqui.",
  },
  conferido: {
    title: "Nenhum pedido conferido",
    body: "Pedidos com a embalagem conferida (bip da etiqueta de envio) aparecem aqui.",
  },
  pendente_realocacao: {
    title: "Nenhum pedido aguardando realocação",
    body: "Pedidos com itens a realocar para outro galpão aparecem aqui.",
  },
};

const MARKETPLACE_OPTS = [
  { value: "", label: "Todos marketplaces" },
  { value: "Mercado Livre", label: "Mercado Livre" },
  { value: "Shopee", label: "Shopee" },
];

const SORT_OPTS = [
  { value: "data_pedido", label: "Ordenar: data" },
  { value: "localizacao", label: "Ordenar: localização" },
  { value: "sku", label: "Ordenar: SKU" },
];

const PRAZO_OPTS = [
  { value: "", label: "Prazo envio: todos" },
  { value: "atrasado", label: "Atrasados" },
  { value: "hoje", label: "Vence hoje" },
  { value: "amanha", label: "Vence amanhã" },
  { value: "7dias", label: "Próx. 7 dias" },
  { value: "sem", label: "Sem prazo" },
];

// Move targets (admin) — espelha o STATUS_ORDER da API (voltar-etapa).
// SEP-08: `aguardando_compra` fica FORA (como tab de origem e como target) —
// a API não tem esse status no STATUS_ORDER e rejeitava com 400 sempre.
// A tab aguardando_compra não tem entry → botão "Mover…" não renderiza.
const MOVE_TARGETS: Partial<
  Record<
    Tab,
    {
      back: { value: StatusServer; label: string }[];
      forward: { value: StatusServer; label: string }[];
    }
  >
> = {
  aguardando_nf: {
    back: [],
    forward: [
      { value: "aguardando_separacao", label: "Aguard. separação" },
      { value: "em_separacao", label: "Em separação" },
      { value: "separado", label: "Separado" },
      { value: "embalado", label: "Embalado" },
    ],
  },
  aguardando_separacao: {
    back: [{ value: "aguardando_nf", label: "Aguard. NF" }],
    forward: [
      { value: "em_separacao", label: "Em separação" },
      { value: "separado", label: "Separado" },
      { value: "embalado", label: "Embalado" },
    ],
  },
  em_separacao: {
    back: [{ value: "aguardando_separacao", label: "Aguard. separação" }],
    forward: [
      { value: "separado", label: "Separado" },
      { value: "embalado", label: "Embalado" },
    ],
  },
  separado: {
    back: [
      { value: "em_separacao", label: "Em separação" },
      { value: "aguardando_separacao", label: "Aguard. separação" },
    ],
    forward: [{ value: "embalado", label: "Embalado" }],
  },
  embalado: {
    back: [
      { value: "separado", label: "Separado" },
      { value: "aguardando_separacao", label: "Aguard. separação" },
    ],
    forward: [{ value: "conferido", label: "Conferido" }],
  },
  conferido: {
    back: [
      { value: "embalado", label: "Embalado" },
      { value: "separado", label: "Separado" },
    ],
    forward: [],
  },
};

function parseTab(value: string | null | undefined): Tab {
  const valid: Tab[] = [
    "aguardando_compra",
    "aguardando_nf",
    "aguardando_separacao",
    "em_separacao",
    "separado",
    "embalado",
    "conferido",
    "pendente_realocacao",
  ];
  return valid.includes(value as Tab)
    ? (value as Tab)
    : "aguardando_separacao";
}

function getEcommerceAbbr(nome: string | null | undefined): string {
  if (!nome) return "—";
  const n = nome.toLowerCase();
  if (n.includes("mercado") || n === "ml") return "ML";
  if (n.includes("shopee")) return "SH";
  if (n.includes("amazon")) return "AM";
  if (n.includes("magalu") || n.includes("magazine")) return "MA";
  if (n.includes("americanas") || n.includes("b2w")) return "B2W";
  return nome.slice(0, 3).toUpperCase();
}

// ─── Page ─────────────────────────────────────────────────────────────────

/** dd/mm HH:MM:SS — timestamp com segundos (fmtDateTime corta no minuto). */
function fmtHoraSeg(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${mi}:${ss}`;
}

/** Prazo de despacho (data envio do ML) → "dd/mm HH:mm". */
function fmtPrazo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${mi}`;
}

/** Filtro client-side por prazo de envio. Presets operacionais de SLA. */
function matchPrazo(iso: string | null | undefined, filtro: string): boolean {
  if (!filtro) return true;
  if (filtro === "sem") return !iso;
  if (!iso) return false;
  const prazo = new Date(iso);
  if (isNaN(prazo.getTime())) return false;
  const now = new Date();
  const hoje0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const amanha0 = new Date(hoje0); amanha0.setDate(amanha0.getDate() + 1);
  const depois0 = new Date(hoje0); depois0.setDate(depois0.getDate() + 2);
  const seteDias = new Date(hoje0); seteDias.setDate(seteDias.getDate() + 7);
  switch (filtro) {
    case "atrasado": return prazo < now;                              // deadline já passou
    case "hoje": return prazo >= hoje0 && prazo < amanha0;
    case "amanha": return prazo >= amanha0 && prazo < depois0;
    case "7dias": return prazo >= hoje0 && prazo < seteDias;
    default: return true;
  }
}

/** Dropdown com checkboxes pra filtrar por múltiplas empresas. */
function EmpresaMultiSelect({
  empresas,
  selected,
  onChange,
}: {
  empresas: { id: string; nome: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const selectedSet = new Set(selected);
  const label =
    selected.length === 0
      ? "Todas empresas"
      : selected.length === 1
        ? (empresas.find((e) => e.id === selected[0])?.nome ?? "1 empresa")
        : `${selected.length} empresas`;

  const toggle = (id: string) => {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="wms-select"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: 180,
          textAlign: "left",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        <Icon name="chevron-r" size={11} />
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 30,
            minWidth: 200,
            maxHeight: 300,
            overflowY: "auto",
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
            padding: 4,
          }}
        >
          <button
            type="button"
            onClick={() => onChange([])}
            style={{
              display: "flex",
              width: "100%",
              alignItems: "center",
              padding: "6px 8px",
              fontSize: 12,
              color:
                selected.length === 0
                  ? "var(--wms-c-fg)"
                  : "var(--wms-c-fg-2)",
              fontWeight: selected.length === 0 ? 600 : 400,
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            Todas empresas
          </button>
          {empresas.map((emp) => (
            <label
              key={emp.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                fontSize: 12,
                cursor: "pointer",
                borderRadius: 6,
              }}
            >
              <input
                type="checkbox"
                checked={selectedSet.has(emp.id)}
                onChange={() => toggle(emp.id)}
              />
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {emp.nome}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function WmsSeparacaoPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, activeGalpaoId } = useAuth();
  const { can } = usePermissoes();
  const queryClient = useQueryClient();
  const isAdmin =
    (user?.cargos ?? []).includes("admin") || user?.cargo === "admin";
  // Botões admin de separação (forçar pendente, voltar etapa, reimprimir, tags)
  const podeAdministrar = can("separacao.administrar");

  // Anuncia presença no card "Separação" do quadro de tarefas (/wms) enquanto
  // esta aba estiver aberta.
  useTrackPresencaWms("separacao");

  const tab = parseTab(searchParams?.get("tab"));
  const busca = searchParams?.get("busca") ?? "";
  const marketplace = searchParams?.get("marketplace") ?? "";
  const tagFilter = searchParams?.get("tag") ?? "";
  const sort = searchParams?.get("sort") ?? "data_pedido";
  const fornecedor = searchParams?.get("fornecedor") ?? "";
  const empresaFilter = searchParams?.get("empresa") ?? "";
  const prazoFilter = searchParams?.get("prazo") ?? "";
  // Multi-select de empresa: `empresa` é lista separada por vírgula.
  const selectedEmpresaIds = empresaFilter
    ? empresaFilter.split(",").filter(Boolean)
    : [];

  // Realtime: auto-refresh quando outros operadores mudam status (paridade legado)
  useRealtimeSeparacao();

  // Aquece as rotas quentes do fluxo de separação (só código, sem dados —
  // os dados mudam com o status no server e ficariam stale).
  useEffect(() => {
    router.prefetch("/wms/separacao/checklist");
    router.prefetch("/wms/separacao/embalagem");
  }, [router]);

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(
        Array.from(searchParams?.entries() ?? []),
      );
      if (value) params.set(key, value);
      else params.delete(key);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  // Atualiza múltiplos params numa única chamada — evita o bug de race
  // condition do React quando 2 updateParam consecutivos são chamados
  // no mesmo handler (segundo lê searchParams stale e reverte o primeiro).
  // Sintoma desse bug: clicar em tab com count=0 não mudava de tab.
  const updateParams = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(
        Array.from(searchParams?.entries() ?? []),
      );
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  // Selection state — chaveada por (galpao + tab) pra resetar ao trocar contexto.
  const contextKey = `${activeGalpaoId ?? "all"}:${tab}`;
  const [selection, setSelection] = useState<{
    key: string;
    ids: Set<string>;
  }>({ key: "", ids: new Set() });
  const selectedIds: Set<string> =
    selection.key === contextKey ? selection.ids : new Set();
  // Expansão de linha — independente da selection. Reseta ao trocar contexto.
  const [expansion, setExpansion] = useState<{
    key: string;
    ids: Set<string>;
  }>({ key: "", ids: new Set() });
  const expandedIds: Set<string> =
    expansion.key === contextKey ? expansion.ids : new Set();
  const lastCheckedIdxRef = useRef<number | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [tagModalOpen, setTagModalOpen] = useState(false);
  const [encaminharOpenId, setEncaminharOpenId] = useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpansion((prev) => {
      const base = prev.key === contextKey ? prev.ids : new Set<string>();
      const next = new Set(base);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { key: contextKey, ids: next };
    });
  };

  // ── Query principal ────────────────────────────────────────────────────
  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set("status_separacao", TAB_TO_STATUS[tab].join(","));
    if (busca) params.set("busca", busca);
    if (marketplace) params.set("marketplace", marketplace);
    if (tagFilter) params.set("tag", tagFilter);
    if (empresaFilter) params.set("empresa_origem_id", empresaFilter);
    if (sort && sort !== "data_pedido") params.set("sort", sort);
    return params.toString();
  }, [tab, busca, marketplace, tagFilter, empresaFilter, sort]);

  const { data, isLoading, isError, error, refetch } =
    useQuery<SeparacaoResponse>({
      queryKey: [
        "wms-separacao",
        activeGalpaoId ?? "all",
        tab,
        busca,
        marketplace,
        tagFilter,
        empresaFilter,
        sort,
      ],
      queryFn: async () => {
        const r = await sisoFetch(`/api/wms/separacao?${queryString}`);
        if (!r.ok) {
          const b = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error || `HTTP ${r.status}`);
        }
        return r.json() as Promise<SeparacaoResponse>;
      },
      // Backstop — useRealtimeSeparacao() invalida em qualquer mudança de
      // siso_pedidos (debounce 500ms); o poll só cobre queda do websocket.
      refetchInterval: 30_000,
      // Troca de tab/filtro/galpão muda a queryKey — sem placeholder a lista
      // some pra um loading a cada mudança. Mantém os dados anteriores na
      // tela enquanto a nova chave busca.
      placeholderData: keepPreviousData,
    });

  const tagsQuery = useQuery<{ tags: string[] }>({
    queryKey: ["wms-separacao-tags"],
    queryFn: async () => {
      const r = await sisoFetch("/api/wms/separacao/tags");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 30_000,
  });

  const allTags = tagsQuery.data?.tags ?? [];
  const counts = useMemo(
    () => ({
      aguardando_compra: data?.counts.aguardando_compra ?? 0,
      aguardando_nf: data?.counts.aguardando_nf ?? 0,
      aguardando_separacao:
        (data?.counts.aguardando_separacao ?? 0) +
        (data?.counts.validacao_oc ?? 0),
      em_separacao: data?.counts.em_separacao ?? 0,
      separado: data?.counts.separado ?? 0,
      embalado: data?.counts.embalado ?? 0,
      conferido: data?.counts.conferido ?? 0,
      pendente_realocacao: data?.counts.pendente_realocacao ?? 0,
    }),
    [data?.counts],
  );

  const pedidosRaw = data?.pedidos ?? [];
  const galpoesAll = data?.galpoes ?? [];
  const empresasAll = data?.empresas ?? [];

  // Filtros client-side: prazo de envio (todas as tabs) + fornecedor
  // (só aguardando_compra). A lista não é paginada, então filtrar aqui
  // mantém contador/seleção/ações coerentes com o que aparece.
  const pedidos = useMemo(() => {
    let out = pedidosRaw;
    if (prazoFilter) out = out.filter((p) => matchPrazo(p.prazo_envio, prazoFilter));
    if (tab === "aguardando_compra" && fornecedor) {
      out = out.filter((p) =>
        p.compra_stats?.itens?.some((it) => it.fornecedor_oc === fornecedor),
      );
    }
    return out;
  }, [pedidosRaw, tab, fornecedor, prazoFilter]);

  const fornecedorOpts = useMemo(() => {
    if (tab !== "aguardando_compra") return [] as string[];
    const set = new Set<string>();
    for (const p of pedidosRaw) {
      for (const it of p.compra_stats?.itens ?? []) {
        if (it.fornecedor_oc) set.add(it.fornecedor_oc);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [pedidosRaw, tab]);

  const moveTargets = MOVE_TARGETS[tab];

  // ── Selection helpers ──────────────────────────────────────────────────
  const toggleSelect = (id: string, shift: boolean, idx: number) => {
    if (shift && lastCheckedIdxRef.current !== null) {
      const start = Math.min(lastCheckedIdxRef.current, idx);
      const end = Math.max(lastCheckedIdxRef.current, idx);
      setSelection((prev) => {
        const base = prev.key === contextKey ? prev.ids : new Set<string>();
        const next = new Set(base);
        for (let i = start; i <= end; i++) {
          if (pedidos[i]) next.add(pedidos[i].id);
        }
        return { key: contextKey, ids: next };
      });
      lastCheckedIdxRef.current = idx;
      return;
    }
    lastCheckedIdxRef.current = idx;
    setSelection((prev) => {
      const base = prev.key === contextKey ? prev.ids : new Set<string>();
      const next = new Set(base);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { key: contextKey, ids: next };
    });
  };

  const clearSelection = () =>
    setSelection({ key: contextKey, ids: new Set() });

  const toggleAll = () => {
    if (selectedIds.size === pedidos.length) {
      clearSelection();
    } else {
      setSelection({
        key: contextKey,
        ids: new Set(pedidos.map((p) => p.id)),
      });
    }
  };

  // ── Mutations ──────────────────────────────────────────────────────────
  const iniciarMut = useMutation({
    mutationFn: async (ids: string[]) => {
      if (!user) throw new Error("Sessão expirada");
      await sisoFetch("/api/wms/separacao/iniciar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: ids, operador_id: user.id }),
      });
      return ids;
    },
  });

  const forcarPendenteMut = useMutation({
    mutationFn: async (ids: string[]) => {
      const r = await sisoFetch("/api/wms/separacao/forcar-pendente", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: ids }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return body as {
        total: number;
        pedidos_sem_nf?: string[];
        pedidos_nf_nao_autorizada?: string[];
      };
    },
    onSuccess: (body) => {
      const movidos = body.total ?? 0;
      if (movidos > 0)
        toast.success(
          `${movidos} pedido(s) movido(s) pra Aguardando Separação`,
        );
      const semNf = body.pedidos_sem_nf?.length ?? 0;
      const naoAut = body.pedidos_nf_nao_autorizada?.length ?? 0;
      if (semNf > 0) toast.warning(`${semNf} pedido(s) sem NF`);
      if (naoAut > 0) toast.warning(`${naoAut} pedido(s) com NF não autorizada`);
      if (movidos === 0 && semNf === 0 && naoAut === 0)
        toast.info("Nenhum pedido elegível para mover");
      clearSelection();
      refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const moverEtapaMut = useMutation({
    mutationFn: async (args: { ids: string[]; novo_status: StatusServer }) => {
      const r = await sisoFetch("/api/wms/separacao/voltar-etapa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_ids: args.ids,
          novo_status: args.novo_status,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return body as { total: number };
    },
    onSuccess: (body) => {
      toast.success(`${body.total} pedido(s) movido(s)`);
      setMoveOpen(false);
      clearSelection();
      refetch();
      queryClient.invalidateQueries({ queryKey: ["wms-separacao"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const retryEtiquetaMut = useMutation({
    mutationFn: async (ids: string[]) => {
      const r = await sisoFetch("/api/wms/separacao/retry-etiqueta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: ids }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return body as {
        recuperadas: number;
        em_andamento: number;
        falhas: number;
        ja_disponiveis?: number;
      };
    },
    onSuccess: (body) => {
      const partes: string[] = [];
      if (body.recuperadas) partes.push(`${body.recuperadas} recuperada(s)`);
      if (body.em_andamento)
        partes.push(`${body.em_andamento} em processamento`);
      if (body.falhas) partes.push(`${body.falhas} falha(s)`);
      if (partes.length === 0) toast.success("Etiquetas já disponíveis");
      else toast.message(partes.join(" · "));
      refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reimprimirMut = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const r = await sisoFetch("/api/wms/separacao/reimprimir", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pedido_id: id }),
          });
          const b = await r.json().catch(() => ({}));
          return r.ok && b.status === "impresso";
        }),
      );
      let ok = 0;
      let fail = 0;
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) ok++;
        else fail++;
      }
      return { ok, fail };
    },
    onSuccess: ({ ok, fail }) => {
      if (ok > 0) toast.success(`${ok} etiqueta(s) impressa(s)`);
      if (fail > 0) toast.error(`${fail} etiqueta(s) falharam`);
    },
  });

  const addTagMut = useMutation({
    mutationFn: async (args: { ids: string[]; tag: string }) => {
      const r = await sisoFetch("/api/wms/separacao/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_ids: args.ids,
          tags: [args.tag.trim()],
          action: "add",
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return { total: body.total as number, tag: args.tag.trim() };
    },
    onSuccess: ({ total, tag }) => {
      toast.success(`Tag "${tag}" adicionada a ${total} pedido(s)`);
      refetch();
      queryClient.invalidateQueries({ queryKey: ["wms-separacao-tags"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeTagMut = useMutation({
    mutationFn: async (args: { ids: string[]; tag: string }) => {
      const r = await sisoFetch("/api/wms/separacao/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_ids: args.ids,
          tags: [args.tag],
          action: "remove",
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return args.tag;
    },
    onSuccess: (tag) => {
      toast.success(`Tag "${tag}" removida`);
      refetch();
      queryClient.invalidateQueries({ queryKey: ["wms-separacao-tags"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const encaminharMut = useMutation({
    mutationFn: async (args: { pedido_id: string; galpao_destino_id: string }) => {
      const r = await sisoFetch("/api/wms/separacao/encaminhar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_ids: [args.pedido_id],
          galpao_destino_id: args.galpao_destino_id,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return body as {
        encaminhados: string[];
        falhas: { pedido_id: string; erro: string }[];
        galpao_destino_nome: string;
      };
    },
    onSuccess: (body) => {
      setEncaminharOpenId(null);
      if (body.encaminhados?.length > 0) {
        toast.success(`Pedido encaminhado para ${body.galpao_destino_nome}`);
        refetch();
      }
      if (body.falhas?.length > 0) {
        toast.error(body.falhas[0].erro ?? "Falha ao encaminhar");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Lógica de IDs pra ações em lote ─────────────────────────────────────
  // Paridade com legado: quando NÃO há selection, ações operam em todos os pedidos da tab.
  const selectedArr = Array.from(selectedIds);
  const effectiveIds =
    selectedArr.length > 0 ? selectedArr : pedidos.map((p) => p.id);
  const effectiveCount = effectiveIds.length;

  function batchSepararChecklist(modo?: string) {
    if (effectiveIds.length === 0) return;
    iniciarMut.mutate(effectiveIds, {
      onSettled: () => {
        const qs = new URLSearchParams();
        qs.set("pedidos", effectiveIds.join(","));
        if (modo) qs.set("modo", modo);
        router.push(`/wms/separacao/checklist?${qs.toString()}`);
      },
    });
  }

  function batchEmbalar(modo?: string, idsOverride?: string[]) {
    const ids = idsOverride ?? effectiveIds;
    if (ids.length === 0) return;
    const qs = new URLSearchParams();
    qs.set("pedidos", ids.join(","));
    if (modo) qs.set("modo", modo);
    router.push(`/wms/separacao/embalagem?${qs.toString()}`);
  }

  // Cálculos auxiliares pra ações da tab "separado"
  const separadoStats = useMemo(() => {
    if (tab !== "separado")
      return { comEtiqueta: 0, semEtiqueta: 0, sourceIds: [] as string[] };
    const source =
      selectedArr.length > 0
        ? pedidos.filter((p) => selectedIds.has(p.id))
        : pedidos;
    const comEtiqueta = source.filter((p) => p.etiqueta_pronta);
    const semEtiqueta = source.filter((p) => !p.etiqueta_pronta);
    return {
      comEtiqueta: comEtiqueta.length,
      semEtiqueta: semEtiqueta.length,
      sourceIds: source.map((p) => p.id),
      comEtiquetaIds: comEtiqueta.map((p) => p.id),
      semEtiquetaIds: semEtiqueta.map((p) => p.id),
    };
  }, [tab, pedidos, selectedArr, selectedIds]);

  // Cálculo de pedidos "engatilhados" na tab Aguardando OC — pedidos com itens
  // OC já comprados, NF emitida E agrupamento criado. Esses podem ser embalados
  // direto via /wms/separacao/embalagem?modo=embalagem-oc: a tela abre como se
  // os produtos já estivessem separados e o operador só bipa pra sair etiqueta.
  // Paridade visual com botão verde "Embalar X pedido(s)" do legado.
  const engatilhadoStats = useMemo(() => {
    if (tab !== "aguardando_compra")
      return { count: 0, ids: [] as string[] };
    const source =
      selectedArr.length > 0
        ? pedidos.filter((p) => selectedIds.has(p.id))
        : pedidos;
    const engatilhados = source.filter(
      (p) => p.nf_emitida && p.agrupamento_criado,
    );
    return {
      count: engatilhados.length,
      ids: engatilhados.map((p) => p.id),
    };
  }, [tab, pedidos, selectedArr, selectedIds]);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      <PageHeader
        title="Separação"
        subtitle="Wave picking, embalagem e expedição"
        backHref="/wms"
        backLabel="Voltar ao WMS"
      />

      <TabsStatusSeparacao
        active={tab}
        counts={counts}
        onChange={(next) => {
          // BATCH em uma só chamada — chamadas consecutivas de updateParam
          // levavam searchParams stale e reverter mudanças (bug das tabs zeradas).
          const updates: Record<string, string> = { tab: next };
          if (next !== "aguardando_compra") updates.fornecedor = "";
          updateParams(updates);
          clearSelection();
          lastCheckedIdxRef.current = null;
          setEncaminharOpenId(null);
        }}
      />

      {/* Toolbar — filtros à esquerda, ações primárias da tab à direita.
          Inline (sem sticky), agrupado em uma linha que faz wrap quando estreito. */}
      <div className="wms-toolbar" style={{ marginTop: 16 }}>
        <div className="wms-search-wrap">
          <Icon name="search" size={13} />
          <input
            value={busca}
            onChange={(e) => updateParam("busca", e.target.value)}
            placeholder="Buscar pedido, cliente, SKU, GTIN…"
          />
          {busca && (
            <button
              className="wms-search-clear"
              onClick={() => updateParam("busca", "")}
              type="button"
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </div>

        <select
          className="wms-select"
          value={marketplace}
          onChange={(e) => updateParam("marketplace", e.target.value)}
          style={{ width: 180 }}
        >
          {MARKETPLACE_OPTS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        {empresasAll.length > 0 && (
          <EmpresaMultiSelect
            empresas={empresasAll}
            selected={selectedEmpresaIds}
            onChange={(ids) => updateParam("empresa", ids.join(","))}
          />
        )}

        <select
          className="wms-select"
          value={prazoFilter}
          onChange={(e) => updateParam("prazo", e.target.value)}
          style={{ width: 170 }}
        >
          {PRAZO_OPTS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <select
          className="wms-select"
          value={tagFilter}
          onChange={(e) => updateParam("tag", e.target.value)}
          style={{ width: 180 }}
        >
          <option value="">Todas tags</option>
          {allTags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <select
          className="wms-select"
          value={sort}
          onChange={(e) => updateParam("sort", e.target.value)}
          style={{ width: 200 }}
        >
          {SORT_OPTS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        {tab === "aguardando_compra" && fornecedorOpts.length > 0 && (
          <select
            className="wms-select"
            value={fornecedor}
            onChange={(e) => updateParam("fornecedor", e.target.value)}
            style={{ width: 200 }}
          >
            <option value="">Todos fornecedores</option>
            {fornecedorOpts.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        )}

        {/* Ações primárias da tab — empurradas pra direita */}
        {pedidos.length > 0 && (
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: 6,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <PrimaryTabActions
              tab={tab}
              effectiveCount={effectiveCount}
              hasSelection={selectedArr.length > 0}
              selectedCount={selectedArr.length}
              totalCount={pedidos.length}
              separadoStats={separadoStats}
              engatilhadoStats={engatilhadoStats}
              loading={
                iniciarMut.isPending ||
                retryEtiquetaMut.isPending ||
                reimprimirMut.isPending
              }
              onSepararChecklist={batchSepararChecklist}
              onEmbalar={batchEmbalar}
              onRetryEtiqueta={(ids) =>
                retryEtiquetaMut.mutate(ids ?? effectiveIds)
              }
              onConferir={() => router.push("/wms/separacao/conferencia")}
            />
          </div>
        )}
      </div>

      {/* Selection bar — só visível quando há pedidos marcados.
          Contador + ações secundárias (Tag, Mover, Forçar pendente, Retry, Imprimir).
          Inline, sem sticky — fica logo abaixo da toolbar. */}
      {selectedArr.length > 0 && pedidos.length > 0 && (
        <div
          style={{
            marginTop: 10,
            padding: "8px 12px",
            background: "var(--wms-c-info-bg)",
            border: "1px solid var(--wms-c-info-bd)",
            borderRadius: "var(--wms-r-2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
            fontSize: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              color: "var(--wms-c-info)",
              fontWeight: 500,
            }}
          >
            <strong>{selectedArr.length}</strong> selecionado(s)
            <button
              className="wms-btn wms-btn-ghost wms-btn-sm"
              onClick={clearSelection}
              type="button"
            >
              <Icon name="x" size={11} />
              Limpar
            </button>

            {/* Tag — gerenciar tags é ação admin de separação */}
            {podeAdministrar && (
            <div style={{ position: "relative" }}>
              <button
                className="wms-btn wms-btn-ghost wms-btn-sm"
                onClick={() => setTagModalOpen(!tagModalOpen)}
                type="button"
                disabled={addTagMut.isPending || removeTagMut.isPending}
              >
                <Icon name="tag" size={11} />
                Tag · {selectedArr.length}
              </button>
              {tagModalOpen && (
                <TagPopover
                  onClose={() => setTagModalOpen(false)}
                  onAdd={(tag) => {
                    addTagMut.mutate({ ids: selectedArr, tag });
                    setTagModalOpen(false);
                  }}
                  onRemove={(tag) =>
                    removeTagMut.mutate({ ids: selectedArr, tag })
                  }
                  tagsExistentes={allTags}
                  tagsNaSelection={(() => {
                    const set = new Set<string>();
                    for (const p of pedidos) {
                      if (selectedIds.has(p.id)) {
                        for (const t of p.separacao_tags) set.add(t);
                      }
                    }
                    return Array.from(set);
                  })()}
                  pending={addTagMut.isPending || removeTagMut.isPending}
                />
              )}
            </div>
            )}

            {/* Mover etapa (admin) */}
            {podeAdministrar && moveTargets && (
              <div style={{ position: "relative" }}>
                <button
                  className="wms-btn wms-btn-ghost wms-btn-sm"
                  type="button"
                  onClick={() => setMoveOpen(!moveOpen)}
                  disabled={moverEtapaMut.isPending}
                >
                  <Icon name="arrow-right" size={11} />
                  Mover…
                </button>
                {moveOpen && (
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: "100%",
                      marginTop: 6,
                      minWidth: 200,
                      background: "var(--wms-c-panel)",
                      border: "1px solid var(--wms-c-border)",
                      borderRadius: "var(--wms-r-3)",
                      padding: 4,
                      boxShadow: "0 10px 28px -12px rgba(0,0,0,.25)",
                      zIndex: 20,
                    }}
                  >
                    {moveTargets.back.length > 0 && (
                      <>
                        <div
                          className="wms-td-mute"
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: ".06em",
                            padding: "6px 10px 2px",
                          }}
                        >
                          Voltar para
                        </div>
                        {moveTargets.back.map((t) => (
                          <button
                            key={t.value}
                            type="button"
                            onClick={() =>
                              moverEtapaMut.mutate({
                                ids: selectedArr,
                                novo_status: t.value,
                              })
                            }
                            style={moverItem()}
                          >
                            {t.label}
                          </button>
                        ))}
                      </>
                    )}
                    {moveTargets.forward.length > 0 && (
                      <>
                        <div
                          className="wms-td-mute"
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: ".06em",
                            padding: "6px 10px 2px",
                          }}
                        >
                          Avançar para
                        </div>
                        {moveTargets.forward.map((t) => (
                          <button
                            key={t.value}
                            type="button"
                            onClick={() =>
                              moverEtapaMut.mutate({
                                ids: selectedArr,
                                novo_status: t.value,
                              })
                            }
                            style={moverItem()}
                          >
                            {t.label}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {/* Ações específicas por tab que requerem selection */}
            {tab === "aguardando_nf" && podeAdministrar && (
              <button
                className="wms-btn wms-btn-ghost wms-btn-sm"
                onClick={() => forcarPendenteMut.mutate(selectedArr)}
                disabled={forcarPendenteMut.isPending}
                type="button"
              >
                <Icon name="alert" size={11} />
                Forçar pendente · {selectedArr.length}
              </button>
            )}
            {(tab === "embalado" || tab === "conferido") && (
              <>
                <button
                  className="wms-btn wms-btn-ghost wms-btn-sm"
                  onClick={() => retryEtiquetaMut.mutate(selectedArr)}
                  disabled={retryEtiquetaMut.isPending}
                  type="button"
                  style={{
                    borderColor: "var(--wms-c-warn-bd)",
                    background: "var(--wms-c-warn-bg)",
                    color: "var(--wms-c-warn)",
                  }}
                >
                  <Icon name="rotate" size={11} />
                  Retry etiqueta · {selectedArr.length}
                </button>
                <button
                  className="wms-btn wms-btn-primary wms-btn-sm"
                  onClick={() => reimprimirMut.mutate(selectedArr)}
                  disabled={reimprimirMut.isPending}
                  type="button"
                >
                  <Icon name="download" size={11} />
                  Imprimir · {selectedArr.length}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Aviso "X sem etiqueta" no separado (paridade legado) */}
      {tab === "separado" && separadoStats.semEtiqueta > 0 && (
        <div
          style={{
            marginTop: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            background: "var(--wms-c-warn-bg)",
            color: "var(--wms-c-warn)",
            border: "1px solid var(--wms-c-warn-bd)",
            borderRadius: "var(--wms-r-2)",
            fontSize: 12,
          }}
        >
          <Icon name="alert" size={12} />
          <span>
            <strong>{separadoStats.semEtiqueta}</strong> pedido(s) sem etiqueta
            pronta — impressão será mais lenta
          </span>
        </div>
      )}

      {/* Lista */}
      {isLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="wms-skel wms-skel-row" />
          ))}
        </div>
      ) : isError ? (
        <div className="wms-empty-block">
          <h3>Falha ao carregar separação</h3>
          <p>
            {error instanceof Error
              ? error.message
              : "Erro desconhecido carregando pedidos."}
          </p>
          <button
            className="wms-btn wms-btn-ghost"
            onClick={() => refetch()}
            type="button"
          >
            <Icon name="arrow-right" size={11} />
            Tentar novamente
          </button>
        </div>
      ) : pedidos.length === 0 ? (
        <div className="wms-empty-block">
          <h3>{TAB_EMPTY[tab].title}</h3>
          <p>{TAB_EMPTY[tab].body}</p>
        </div>
      ) : (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th style={{ width: 28 }}>
                  <input
                    type="checkbox"
                    checked={
                      pedidos.length > 0 &&
                      selectedIds.size === pedidos.length
                    }
                    onChange={toggleAll}
                  />
                </th>
                <th style={{ width: 28 }} aria-label="Expandir"></th>
                <th>Pedido</th>
                <th>Cliente</th>
                <th>Mkt</th>
                <th>Galpão</th>
                <th>Decisão</th>
                <th>Status</th>
                <th>Idade</th>
                <th>Data envio</th>
                <th className="wms-tar">Itens</th>
                <th>Tags</th>
                <th style={{ width: 36 }}></th>
              </tr>
            </thead>
            <tbody>
              {pedidos.map((p, idx) => {
                const isSel = selectedIds.has(p.id);
                const isExp = expandedIds.has(p.id);
                const galpao = p.filial_origem ?? "?";
                const galpaoLower = galpao.toLowerCase();
                const progresso =
                  p.total_itens > 0
                    ? Math.round((p.itens_marcados / p.total_itens) * 100)
                    : 0;
                const canEncaminhar =
                  (p.status_separacao === "aguardando_separacao" ||
                    p.status_separacao === "em_separacao") &&
                  galpoesAll.filter((g) => g.id !== p.galpao_id).length > 0;
                const podeReimprimir =
                  p.status_separacao === "embalado" ||
                  p.status_separacao === "conferido";
                const reimprimindoEste =
                  reimprimirMut.isPending &&
                  (reimprimirMut.variables as string[] | undefined)?.includes(
                    p.id,
                  );
                return (
                  <Fragment key={p.id}>
                  <tr
                    className={`wms-tr-clickable ${isExp ? "is-expanded" : ""}`}
                    onClick={(e) => toggleSelect(p.id, e.shiftKey, idx)}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={(e) =>
                          toggleSelect(
                            p.id,
                            (e.nativeEvent as MouseEvent).shiftKey,
                            idx,
                          )
                        }
                      />
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="wms-btn-icon"
                        title={isExp ? "Recolher" : "Ver itens e detalhes"}
                        aria-expanded={isExp}
                        onClick={() => toggleExpand(p.id)}
                        style={{
                          transform: isExp ? "rotate(90deg)" : "none",
                          transition: "transform 120ms",
                        }}
                      >
                        <Icon name="chevron-r" size={12} />
                      </button>
                    </td>
                    <td className="wms-mono">
                      #{p.numero_pedido || p.numero_ec || "—"}
                    </td>
                    <td>
                      <span
                        style={{
                          display: "inline-block",
                          maxWidth: 200,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          verticalAlign: "bottom",
                        }}
                        title={p.cliente ?? ""}
                      >
                        {p.cliente ?? "—"}
                      </span>
                      {p.uf && (
                        <span
                          className="wms-td-mute"
                          style={{ marginLeft: 6, fontSize: 11 }}
                        >
                          {p.uf}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="wms-pcard-chip">
                        {getEcommerceAbbr(p.nome_ecommerce)}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`wms-pcard-chip is-galpao is-${galpaoLower}`}
                      >
                        {galpao}
                      </span>
                      {p.encaminhado_de && (
                        <div
                          className="wms-td-mute"
                          style={{ fontSize: 10, marginTop: 2 }}
                        >
                          Encaminhado de {p.encaminhado_de}
                        </div>
                      )}
                    </td>
                    <td>
                      <DecisaoLabel
                        decisao={p.decisao_final ?? "propria"}
                        galpaoOrigem={galpao}
                        compact
                      />
                    </td>
                    <td>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          flexWrap: "wrap",
                        }}
                      >
                        <StatusBadge status={p.status_separacao} />
                        {p.nf_emitida && (
                          <span title="NF emitida" style={badgeFlag("info")}>
                            N
                          </span>
                        )}
                        {p.agrupamento_criado && (
                          <span
                            title="Agrupamento criado no Tiny"
                            style={badgeFlag("info")}
                          >
                            A
                          </span>
                        )}
                        {p.etiqueta_pronta && (
                          <span
                            title="Etiqueta pronta pra impressão"
                            style={badgeFlag("ok")}
                          >
                            E
                          </span>
                        )}
                      </div>
                      {p.status_separacao === "em_separacao" &&
                        p.total_itens > 0 && (
                          <div
                            style={{
                              marginTop: 4,
                              height: 4,
                              background: "var(--wms-c-faint)",
                              borderRadius: 2,
                              overflow: "hidden",
                              maxWidth: 120,
                            }}
                          >
                            <div
                              style={{
                                width: `${progresso}%`,
                                height: "100%",
                                background: "var(--wms-c-fg)",
                                transition: "width 200ms",
                              }}
                            />
                          </div>
                        )}
                    </td>
                    <td className="wms-td-mute" style={{ fontSize: 11 }}>
                      {p.data_pedido ? fmtRelative(p.data_pedido) : "—"}
                      {p.embalagem_concluida_em && (
                        <div style={{ marginTop: 2 }} title="Embalado em">
                          <span style={{ fontSize: 9.5 }}>emb </span>
                          <span
                            className="wms-mono"
                            style={{ fontSize: 10.5, color: "var(--wms-c-fg-2)" }}
                          >
                            {fmtHoraSeg(p.embalagem_concluida_em)}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="wms-mono" style={{ fontSize: 11 }}>
                      {(() => {
                        const txt = fmtPrazo(p.prazo_envio);
                        if (!txt)
                          return <span className="wms-td-mute">—</span>;
                        const atrasado =
                          new Date(p.prazo_envio as string).getTime() <
                          Date.now();
                        return (
                          <span
                            title={
                              atrasado
                                ? "Prazo de despacho vencido (ML)"
                                : "Prazo de despacho (ML)"
                            }
                            style={{
                              color: atrasado
                                ? "var(--wms-c-danger)"
                                : "var(--wms-c-fg-2)",
                              fontWeight: atrasado ? 600 : 400,
                            }}
                          >
                            {txt}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="wms-tar wms-mono">
                      {fmtNum(p.total_itens)}
                    </td>
                    <td>
                      {p.separacao_tags.length > 0 ? (
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 3,
                          }}
                        >
                          {p.separacao_tags.map((t) => (
                            <span
                              key={t}
                              style={{
                                fontSize: 10,
                                padding: "1px 5px",
                                background: "var(--wms-c-info-bg)",
                                color: "var(--wms-c-info)",
                                border: "1px solid var(--wms-c-info-bd)",
                                borderRadius: 3,
                                fontWeight: 500,
                              }}
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="wms-td-mute">—</span>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {canEncaminhar && (
                        <EncaminharDropdown
                          pedido={p}
                          galpoes={galpoesAll}
                          open={encaminharOpenId === p.id}
                          onToggle={() =>
                            setEncaminharOpenId(
                              encaminharOpenId === p.id ? null : p.id,
                            )
                          }
                          onSubmit={(galpao_destino_id) =>
                            encaminharMut.mutate({
                              pedido_id: p.id,
                              galpao_destino_id,
                            })
                          }
                          pending={encaminharMut.isPending}
                        />
                      )}
                      {podeReimprimir && (
                        <button
                          type="button"
                          className="wms-btn-icon"
                          title="Reimprimir etiqueta na sua impressora"
                          onClick={() => reimprimirMut.mutate([p.id])}
                          disabled={reimprimindoEste}
                        >
                          {reimprimindoEste ? (
                            <Loader2 className="animate-spin" size={13} />
                          ) : (
                            <Icon name="printer" size={13} />
                          )}
                        </button>
                      )}
                    </td>
                  </tr>
                  {isExp && (
                    <tr
                      className="wms-tr-expansion"
                      style={{ background: "var(--wms-c-faint)" }}
                    >
                      <td colSpan={13} style={{ padding: 0 }}>
                        <PedidoExpansaoPanel pedido={p} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

    </>
  );
}

// ─── Ações primárias inline na toolbar ───────────────────────────────────

interface PrimaryTabActionsProps {
  tab: Tab;
  effectiveCount: number;
  hasSelection: boolean;
  selectedCount: number;
  totalCount: number;
  separadoStats: SeparadoStatsShape;
  engatilhadoStats: { count: number; ids: string[] };
  loading: boolean;
  onSepararChecklist: (modo?: string) => void;
  onEmbalar: (modo?: string, idsOverride?: string[]) => void;
  onRetryEtiqueta: (ids?: string[]) => void;
  onConferir: () => void;
}

function PrimaryTabActions({
  tab,
  effectiveCount,
  hasSelection,
  selectedCount,
  totalCount,
  separadoStats,
  engatilhadoStats,
  loading,
  onSepararChecklist,
  onEmbalar,
  onRetryEtiqueta,
  onConferir,
}: PrimaryTabActionsProps) {
  // Indicador "operando em todos" vs "operando em selection" (texto consistente)
  const countLabel = hasSelection
    ? `${selectedCount} selecionado(s)`
    : `${totalCount} pedido(s)`;

  if (tab === "aguardando_compra") {
    return (
      <>
        <button
          className="wms-btn wms-btn-primary wms-btn-sm"
          onClick={() => onSepararChecklist("pick-oc")}
          disabled={loading}
          type="button"
          title={`Iniciar separação pick-OC para ${countLabel}`}
        >
          <Icon name="arrow-right" size={11} />
          {loading ? "Iniciando…" : `Separar (pick-OC) · ${effectiveCount}`}
        </button>

        {/* Embalar direto (modo=embalagem-oc) — só quando há pedidos
            engatilhados (NF emitida + agrupamento criado). Botão verde
            (--wms-c-ok) pra destacar como atalho operacional: abre a
            tela de embalagem como se os produtos já estivessem separados
            e o operador só bipa pra sair etiqueta. Paridade com legado. */}
        {engatilhadoStats.count > 0 && (
          <button
            className="wms-btn wms-btn-primary wms-btn-sm"
            onClick={() => onEmbalar("embalagem-oc", engatilhadoStats.ids)}
            disabled={loading}
            type="button"
            title="Pedidos com NF + agrupamento prontos — abre a tela de embalagem direto"
            style={{
              background: "var(--wms-c-ok)",
              borderColor: "var(--wms-c-ok)",
            }}
          >
            <Icon name="check" size={11} />
            Embalar {engatilhadoStats.count} pedido(s)
          </button>
        )}
      </>
    );
  }

  if (tab === "aguardando_separacao") {
    return (
      <button
        className="wms-btn wms-btn-primary wms-btn-sm"
        onClick={() => onSepararChecklist()}
        disabled={loading}
        type="button"
        title={`Iniciar separação para ${countLabel}`}
      >
        <Icon name="arrow-right" size={11} />
        {loading ? "Iniciando…" : `Separar · ${effectiveCount}`}
      </button>
    );
  }

  if (tab === "em_separacao") {
    return (
      <button
        className="wms-btn wms-btn-primary wms-btn-sm"
        onClick={() => onSepararChecklist()}
        disabled={loading}
        type="button"
        title={`Retomar separação para ${countLabel}`}
      >
        <Icon name="arrow-right" size={11} />
        {loading ? "Retomando…" : `Retomar · ${effectiveCount}`}
      </button>
    );
  }

  if (tab === "separado") {
    return (
      <>
        <button
          className="wms-btn wms-btn-primary wms-btn-sm"
          onClick={() => onEmbalar()}
          disabled={loading}
          type="button"
          title={`Embalar ${countLabel}`}
        >
          <Icon name="check" size={11} />
          {hasSelection
            ? `Embalar · ${selectedCount}`
            : `Embalar todos (${totalCount})`}
        </button>
        {separadoStats.semEtiqueta > 0 && separadoStats.semEtiquetaIds && (
          <button
            className="wms-btn wms-btn-ghost wms-btn-sm"
            onClick={() => onRetryEtiqueta(separadoStats.semEtiquetaIds!)}
            disabled={loading}
            type="button"
            style={{
              borderColor: "var(--wms-c-warn-bd)",
              background: "var(--wms-c-warn-bg)",
              color: "var(--wms-c-warn)",
            }}
          >
            <Icon name="rotate" size={11} />
            {loading
              ? "Tentando…"
              : `Gerar ${separadoStats.semEtiqueta} etiqueta(s)`}
          </button>
        )}
        {separadoStats.semEtiqueta > 0 &&
          separadoStats.comEtiqueta > 0 &&
          separadoStats.comEtiquetaIds && (
            <button
              className="wms-btn wms-btn-primary wms-btn-sm"
              onClick={() =>
                onEmbalar(undefined, separadoStats.comEtiquetaIds)
              }
              disabled={loading}
              type="button"
              title="Embala só os pedidos que já têm etiqueta pronta"
              style={{
                background: "var(--wms-c-ok)",
                borderColor: "var(--wms-c-ok)",
              }}
            >
              <Icon name="check" size={11} />
              Embalar {separadoStats.comEtiqueta} com etiqueta
            </button>
          )}
      </>
    );
  }

  // Embalados: bancada de conferência (scan-driven — não depende de selection).
  // Mesmo modelo do botão "Embalar" da aba separados.
  if (tab === "embalado") {
    return (
      <button
        className="wms-btn wms-btn-primary wms-btn-sm"
        onClick={() => onConferir()}
        type="button"
        title="Abrir a bancada de conferência (bipar etiqueta de envio)"
      >
        <Icon name="check" size={11} />
        Conferir
      </button>
    );
  }

  // aguardando_nf: ação principal requer selection — só aparece na
  // selection bar. Retorna nada na toolbar.
  return null;
}

// ─── Subcomponents ────────────────────────────────────────────────────────

function badgeFlag(tone: "info" | "ok" | "warn"): React.CSSProperties {
  const palette: Record<string, [string, string, string]> = {
    info: ["var(--wms-c-info-bg)", "var(--wms-c-info)", "var(--wms-c-info-bd)"],
    ok: ["var(--wms-c-ok-bg)", "var(--wms-c-ok)", "var(--wms-c-ok-bd)"],
    warn: [
      "var(--wms-c-warn-bg)",
      "var(--wms-c-warn)",
      "var(--wms-c-warn-bd)",
    ],
  };
  const [bg, fg, bd] = palette[tone];
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 16,
    height: 16,
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 3,
    background: bg,
    color: fg,
    border: `1px solid ${bd}`,
    lineHeight: 1,
  };
}

// ─── Encaminhar dropdown (inline por linha) ───────────────────────────────

function EncaminharDropdown({
  pedido,
  galpoes,
  open,
  onToggle,
  onSubmit,
  pending,
}: {
  pedido: { id: string; galpao_id: string | null };
  galpoes: { id: string; nome: string }[];
  open: boolean;
  onToggle: () => void;
  onSubmit: (galpao_destino_id: string) => void;
  pending: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onToggle();
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, onToggle]);

  const destinos = galpoes.filter((g) => g.id !== pedido.galpao_id);
  if (destinos.length === 0) return null;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="wms-btn-icon"
        title="Encaminhar para outro galpão"
        onClick={onToggle}
        disabled={pending}
      >
        <Icon name="arrows" size={12} />
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
            marginTop: 4,
            minWidth: 180,
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-3)",
            padding: 4,
            boxShadow: "0 10px 28px -12px rgba(0,0,0,.25)",
            zIndex: 20,
          }}
        >
          <div
            className="wms-td-mute"
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: ".06em",
              padding: "6px 10px 2px",
            }}
          >
            Encaminhar para
          </div>
          {destinos.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => onSubmit(g.id)}
              disabled={pending}
              style={moverItem()}
            >
              {g.nome}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tag modal (popover acima do footer) ──────────────────────────────────

function TagPopover({
  onClose,
  onAdd,
  onRemove,
  tagsExistentes,
  tagsNaSelection,
  pending,
}: {
  onClose: () => void;
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
  tagsExistentes: string[];
  tagsNaSelection: string[];
  pending: boolean;
}) {
  const [input, setInput] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        bottom: "100%",
        marginBottom: 6,
        left: 0,
        width: 320,
        background: "var(--wms-c-panel)",
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
        padding: 10,
        boxShadow: "0 10px 28px -12px rgba(0,0,0,.25)",
        zIndex: 25,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          className="wms-input"
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) {
              e.preventDefault();
              onAdd(input.trim());
              setInput("");
            }
          }}
          placeholder="Nome da tag…"
          disabled={pending}
        />
        <button
          type="button"
          className="wms-btn wms-btn-primary wms-btn-sm"
          disabled={!input.trim() || pending}
          onClick={() => {
            onAdd(input.trim());
            setInput("");
          }}
        >
          <Icon name="plus" size={11} />
          Add
        </button>
      </div>

      {tagsExistentes.length > 0 && (
        <>
          <div
            className="wms-td-mute"
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: ".06em",
              marginTop: 8,
              marginBottom: 4,
            }}
          >
            Adicionar existente
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {tagsExistentes.map((t) => (
              <button
                key={t}
                type="button"
                disabled={pending}
                onClick={() => onAdd(t)}
                style={{
                  fontSize: 10,
                  padding: "2px 7px",
                  background: "var(--wms-c-info-bg)",
                  color: "var(--wms-c-info)",
                  border: "1px solid var(--wms-c-info-bd)",
                  borderRadius: 3,
                  fontWeight: 500,
                  cursor: pending ? "not-allowed" : "pointer",
                  opacity: pending ? 0.4 : 1,
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </>
      )}

      {tagsNaSelection.length > 0 && (
        <>
          <div
            style={{
              borderTop: "1px solid var(--wms-c-border)",
              marginTop: 10,
              paddingTop: 8,
            }}
          >
            <div
              className="wms-td-mute"
              style={{
                fontSize: 10,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: ".06em",
                marginBottom: 4,
              }}
            >
              Remover da selection
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {tagsNaSelection.map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={pending}
                  onClick={() => onRemove(t)}
                  style={{
                    fontSize: 10,
                    padding: "2px 7px",
                    background: "var(--wms-c-danger-bg)",
                    color: "var(--wms-c-danger)",
                    border: "1px solid var(--wms-c-danger-bd)",
                    borderRadius: 3,
                    fontWeight: 500,
                    cursor: pending ? "not-allowed" : "pointer",
                    opacity: pending ? 0.4 : 1,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                  }}
                >
                  <Icon name="x" size={9} />
                  {t}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Shapes auxiliares ────────────────────────────────────────────────────

interface SeparadoStatsShape {
  comEtiqueta: number;
  semEtiqueta: number;
  sourceIds: string[];
  comEtiquetaIds?: string[];
  semEtiquetaIds?: string[];
}

// (BatchActions órfão removido — ações agora vivem inline na toolbar via
// <PrimaryTabActions> e na selection bar acima da tabela.)


function moverItem(): React.CSSProperties {
  return {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "6px 10px",
    fontSize: 12,
    background: "transparent",
    border: 0,
    color: "var(--wms-c-fg)",
    cursor: "pointer",
    borderRadius: 4,
  };
}

// ─── Painel expandido por pedido ─────────────────────────────────────────
// Lazy-fetch dos itens via /api/separacao/checklist-items.
// Layout: 2 colunas — itens à esquerda, infos do pedido à direita.

interface ChecklistItem {
  id: string;
  pedido_id: string;
  sku: string;
  gtin: string | null;
  descricao: string | null;
  quantidade: number;
  separacao_marcado: boolean;
  quantidade_bipada: number;
  bipado_completo: boolean;
  imagem_url: string | null;
  imagens: string[];
  compra_status: string | null;
  localizacao: string | null;
  saldo: number;
  disponivel: number;
  galpao_nome: string | null;
  quantidade_pega: number | null;
  separacao_parcial: boolean;
  parcial_motivo: string | null;
}

interface PedidoEmbalagemMeta {
  id: string;
  embalado_por_nome: string | null;
  embalado_em: string | null;
  embalado_real_por_nome: string | null;
  embalado_real_em: string | null;
  impressora_nome: string | null;
  impressora_id: number | null;
  etiqueta_impressa_em: string | null;
}

function PedidoExpansaoPanel({ pedido }: { pedido: SeparacaoPedido }) {
  // Em pedidos da tab Aguardando OC os itens "comprar" só aparecem em pick-oc mode.
  const isPickOC = pedido.status_separacao === "aguardando_compra";
  const { data, isLoading, isError, error } = useQuery<{
    items: ChecklistItem[];
    pedidos?: PedidoEmbalagemMeta[];
  }>({
    queryKey: ["wms-separacao-expansao", pedido.id, isPickOC],
    queryFn: async () => {
      const qs = new URLSearchParams({ pedidos: pedido.id });
      if (isPickOC) qs.set("modo", "pick-oc");
      const r = await sisoFetch(`/api/wms/separacao/checklist-items?${qs.toString()}`);
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    staleTime: 30_000,
  });

  const items = data?.items ?? [];
  const meta = data?.pedidos?.find((x) => x.id === pedido.id);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 280px",
        gap: 16,
        padding: "14px 16px 18px 56px",
        borderTop: "1px solid var(--wms-c-border)",
      }}
    >
      {/* Coluna 1 — itens */}
      <div>
        <div
          className="wms-td-mute"
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: ".06em",
            marginBottom: 8,
          }}
        >
          Itens do pedido
        </div>
        {isLoading ? (
          <div className="wms-td-mute" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <Loader2 className="animate-spin" size={12} /> Carregando itens…
          </div>
        ) : isError ? (
          <div style={{ fontSize: 12, color: "var(--wms-c-danger)" }}>
            {error instanceof Error ? error.message : "Erro ao carregar itens"}
          </div>
        ) : items.length === 0 ? (
          <div className="wms-td-mute" style={{ fontSize: 12 }}>
            Nenhum item visível.
          </div>
        ) : (
          <table className="wms-mini-tbl" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ fontSize: 10, color: "var(--wms-c-mute)", textTransform: "uppercase", letterSpacing: ".05em" }}>
                <th style={{ width: 36, textAlign: "left", padding: "4px 6px" }}></th>
                <th style={{ textAlign: "left", padding: "4px 6px" }}>SKU</th>
                <th style={{ textAlign: "left", padding: "4px 6px" }}>Descrição</th>
                <th style={{ textAlign: "left", padding: "4px 6px" }}>Local</th>
                <th className="wms-tar" style={{ padding: "4px 6px" }}>Qtd</th>
                <th style={{ padding: "4px 6px" }}>Estado</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const estado = itemEstado(it);
                return (
                  <tr key={it.id} style={{ borderTop: "1px solid var(--wms-c-border)" }}>
                    <td style={{ padding: "4px 6px" }}>
                      {it.imagem_url ? (
                        <FotoProdutoZoom
                          src={it.imagem_url}
                          imagens={it.imagens}
                          sku={it.sku}
                          descricao={it.descricao}
                          style={{
                            width: 28,
                            height: 28,
                            objectFit: "cover",
                            borderRadius: 3,
                            border: "1px solid var(--wms-c-border)",
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 3,
                            background: "var(--wms-c-panel-2)",
                            border: "1px solid var(--wms-c-border)",
                          }}
                        />
                      )}
                    </td>
                    <td className="wms-mono" style={{ padding: "4px 6px", fontSize: 12 }}>
                      {it.sku}
                    </td>
                    <td style={{ padding: "4px 6px", fontSize: 12 }}>
                      <span title={it.descricao ?? ""}>{it.descricao ?? "—"}</span>
                    </td>
                    <td className="wms-mono" style={{ padding: "4px 6px", fontSize: 11.5 }}>
                      {it.localizacao ?? <span className="wms-td-mute">—</span>}
                    </td>
                    <td className="wms-tar wms-mono" style={{ padding: "4px 6px", fontSize: 12 }}>
                      {it.quantidade_bipada > 0 || it.bipado_completo
                        ? `${it.quantidade_bipada}/${it.quantidade}`
                        : it.quantidade}
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      <span style={estadoBadge(estado.tone)}>{estado.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Coluna 2 — infos do pedido */}
      <div>
        <div
          className="wms-td-mute"
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: ".06em",
            marginBottom: 8,
          }}
        >
          Detalhes
        </div>
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px", fontSize: 12, margin: 0 }}>
          <DetailRow label="Cliente" value={pedido.cliente} />
          <DetailRow
            label="Cidade/UF"
            value={
              [pedido.cidade, pedido.uf].filter(Boolean).join(" / ") || null
            }
          />
          <DetailRow label="Envio" value={pedido.forma_envio} />
          <DetailRow label="Marketplace" value={pedido.nome_ecommerce} />
          <DetailRow label="Nº pedido" value={pedido.numero_pedido} mono />
          <DetailRow label="Nº ML" value={pedido.numero_ec} mono />
          <DetailRow label="Nº NF" value={pedido.numero_nf} mono />
          <DetailRow
            label="Data"
            value={pedido.data_pedido ? fmtRelative(pedido.data_pedido) : null}
          />
          {pedido.encaminhado_de && (
            <DetailRow label="Encaminhado de" value={pedido.encaminhado_de} />
          )}
          {(meta?.embalado_por_nome || meta?.embalado_real_por_nome) && (
            <DetailRow
              label="Embalado por"
              value={meta.embalado_por_nome ?? meta.embalado_real_por_nome}
            />
          )}
          {(meta?.impressora_nome || meta?.impressora_id) && (
            <DetailRow
              label="Impressora"
              value={meta.impressora_nome ?? `#${meta.impressora_id}`}
            />
          )}
        </dl>

        {/* Flags */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          <FlagPill ok={pedido.nf_emitida} label="NF emitida" />
          <FlagPill ok={pedido.agrupamento_criado} label="Agrupamento" />
          <FlagPill ok={pedido.etiqueta_pronta} label="Etiqueta" />
        </div>

        {pedido.marcadores && pedido.marcadores.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div
              className="wms-td-mute"
              style={{
                fontSize: 10,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: ".06em",
                marginBottom: 4,
              }}
            >
              Marcadores Tiny
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {pedido.marcadores.map((m) => (
                <span
                  key={m}
                  style={{
                    fontSize: 10,
                    padding: "1px 6px",
                    background: "var(--wms-c-panel-2)",
                    border: "1px solid var(--wms-c-border)",
                    borderRadius: 3,
                  }}
                >
                  {m}
                </span>
              ))}
            </div>
          </div>
        )}

        {pedido.compra_stats && pedido.compra_stats.total > 0 && (
          <div style={{ marginTop: 10 }}>
            <div
              className="wms-td-mute"
              style={{
                fontSize: 10,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: ".06em",
                marginBottom: 4,
              }}
            >
              Compras
            </div>
            <div style={{ fontSize: 11.5, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 8px" }}>
              <span>Aguardando: <strong>{pedido.compra_stats.aguardando}</strong></span>
              <span>Comprado: <strong>{pedido.compra_stats.comprado}</strong></span>
              <span>Recebido: <strong>{pedido.compra_stats.recebido}</strong></span>
              <span>Indispon.: <strong>{pedido.compra_stats.indisponivel}</strong></span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="wms-td-mute" style={{ fontSize: 11 }}>
        {label}
      </dt>
      <dd
        className={mono ? "wms-mono" : undefined}
        style={{ margin: 0, fontSize: 12, wordBreak: "break-word" }}
      >
        {value ?? <span className="wms-td-mute">—</span>}
      </dd>
    </>
  );
}

function FlagPill({ ok, label }: { ok: boolean; label: string }) {
  const tone = ok ? "ok" : "mute";
  const colors: Record<string, [string, string, string]> = {
    ok: ["var(--wms-c-ok-bg)", "var(--wms-c-ok)", "var(--wms-c-ok-bd)"],
    mute: ["var(--wms-c-panel-2)", "var(--wms-c-mute)", "var(--wms-c-border)"],
  };
  const [bg, fg, bd] = colors[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        padding: "2px 7px",
        background: bg,
        color: fg,
        border: `1px solid ${bd}`,
        borderRadius: 3,
        fontWeight: 500,
      }}
    >
      {ok ? "✓" : "○"} {label}
    </span>
  );
}

type EstadoTone = "ok" | "info" | "warn" | "mute" | "danger";

function itemEstado(it: ChecklistItem): { label: string; tone: EstadoTone } {
  if (it.compra_status === "indisponivel") return { label: "Indisponível", tone: "danger" };
  if (it.compra_status === "cancelado") return { label: "Cancelado", tone: "danger" };
  if (it.compra_status === "aguardando") return { label: "Aguardando OC", tone: "warn" };
  if (it.compra_status === "comprado") return { label: "Comprado", tone: "info" };
  if (it.compra_status === "recebido") return { label: "Recebido", tone: "ok" };
  if (it.separacao_parcial) return { label: `Parcial${it.parcial_motivo ? " · " + it.parcial_motivo : ""}`, tone: "warn" };
  if (it.bipado_completo) return { label: "Bipado", tone: "ok" };
  if (it.separacao_marcado) return { label: "Marcado", tone: "info" };
  return { label: "Pendente", tone: "mute" };
}

function estadoBadge(tone: EstadoTone): React.CSSProperties {
  const palette: Record<EstadoTone, [string, string, string]> = {
    ok: ["var(--wms-c-ok-bg)", "var(--wms-c-ok)", "var(--wms-c-ok-bd)"],
    info: ["var(--wms-c-info-bg)", "var(--wms-c-info)", "var(--wms-c-info-bd)"],
    warn: ["var(--wms-c-warn-bg)", "var(--wms-c-warn)", "var(--wms-c-warn-bd)"],
    danger: ["var(--wms-c-danger-bg)", "var(--wms-c-danger)", "var(--wms-c-danger-bd)"],
    mute: ["var(--wms-c-panel-2)", "var(--wms-c-mute)", "var(--wms-c-border)"],
  };
  const [bg, fg, bd] = palette[tone];
  return {
    display: "inline-block",
    fontSize: 10.5,
    padding: "1px 6px",
    background: bg,
    color: fg,
    border: `1px solid ${bd}`,
    borderRadius: 3,
    fontWeight: 500,
    whiteSpace: "nowrap",
  };
}
