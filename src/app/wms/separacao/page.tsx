"use client";

// Tela WMS de Separação — wrappeada pelo `WmsShell` via `app/wms/layout.tsx`.
// DNA: `app/wms/estoque/page.tsx` (toolbar densa + tabela) + `app/wms/transferir/page.tsx`
// (segmented + footer de ações). Reaproveita o componente `TabsStatusSeparacao`
// e `DecisaoLabel` do pacote vendas/.
//
// Decisões em vigor:
//   D3 — filtro global de galpão aplica server-side via header X-Galpao-Id
//        (já mandado por sisoFetch). Empresa NÃO é exposta no toolbar (D4).
//   D6 — usa <DecisaoLabel> pra mostrar a decisão final por pedido.
//
// Polling 10s. Realtime fica como TODO (`useRealtimeSeparacao` no legado).

import { useMemo, useRef, useState, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { sisoFetch, useAuth } from "@/lib/auth-context";
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
  | "embalado";

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
  empresas: { id: string; nome: string }[]; // ignorado (D4)
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

// Move targets (admin) — espelha o mapa do legado.
const MOVE_TARGETS: Partial<
  Record<
    Tab,
    {
      back: { value: StatusServer; label: string }[];
      forward: { value: StatusServer; label: string }[];
    }
  >
> = {
  aguardando_compra: {
    back: [],
    forward: [
      { value: "aguardando_separacao", label: "Aguard. separação" },
      { value: "em_separacao", label: "Em separação" },
    ],
  },
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
    back: [
      { value: "aguardando_compra", label: "Aguard. OC" },
      { value: "aguardando_nf", label: "Aguard. NF" },
    ],
    forward: [
      { value: "em_separacao", label: "Em separação" },
      { value: "separado", label: "Separado" },
      { value: "embalado", label: "Embalado" },
    ],
  },
  em_separacao: {
    back: [
      { value: "aguardando_compra", label: "Aguard. OC" },
      { value: "aguardando_separacao", label: "Aguard. separação" },
    ],
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

export default function WmsSeparacaoPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, activeGalpaoId } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin =
    (user?.cargos ?? []).includes("admin") || user?.cargo === "admin";

  const tab = parseTab(searchParams?.get("tab"));
  const busca = searchParams?.get("busca") ?? "";
  const marketplace = searchParams?.get("marketplace") ?? "";
  const tagFilter = searchParams?.get("tag") ?? "";
  const sort = searchParams?.get("sort") ?? "data_pedido";
  const fornecedor = searchParams?.get("fornecedor") ?? "";

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

  // Selection state — chaveada por (galpao + tab) pra resetar ao trocar contexto.
  const contextKey = `${activeGalpaoId ?? "all"}:${tab}`;
  const [selection, setSelection] = useState<{
    key: string;
    ids: Set<string>;
  }>({ key: "", ids: new Set() });
  const selectedIds: Set<string> =
    selection.key === contextKey ? selection.ids : new Set();
  const lastCheckedIdxRef = useRef<number | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);

  // ── Query principal ────────────────────────────────────────────────────
  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set("status_separacao", TAB_TO_STATUS[tab].join(","));
    if (busca) params.set("busca", busca);
    if (marketplace) params.set("marketplace", marketplace);
    if (tagFilter) params.set("tag", tagFilter);
    if (sort && sort !== "data_pedido") params.set("sort", sort);
    return params.toString();
  }, [tab, busca, marketplace, tagFilter, sort]);

  const { data, isLoading, isError, error, refetch } =
    useQuery<SeparacaoResponse>({
      queryKey: [
        "wms-separacao",
        activeGalpaoId ?? "all",
        tab,
        busca,
        marketplace,
        tagFilter,
        sort,
      ],
      queryFn: async () => {
        const r = await sisoFetch(`/api/separacao?${queryString}`);
        if (!r.ok) {
          const b = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error || `HTTP ${r.status}`);
        }
        return r.json() as Promise<SeparacaoResponse>;
      },
      refetchInterval: 10_000,
      // TODO: trocar polling por useRealtimeSeparacao() quando o WMS Layout
      // permitir hooks que dependem do session ID já hidratado.
    });

  const tagsQuery = useQuery<{ tags: string[] }>({
    queryKey: ["wms-separacao-tags"],
    queryFn: async () => {
      const r = await sisoFetch("/api/separacao/tags");
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
    }),
    [data?.counts],
  );

  const pedidosRaw = data?.pedidos ?? [];

  // Filtro client-side de fornecedor (só na tab aguardando_compra).
  const pedidos = useMemo(() => {
    if (tab !== "aguardando_compra" || !fornecedor) return pedidosRaw;
    return pedidosRaw.filter((p) =>
      p.compra_stats?.itens?.some((it) => it.fornecedor_oc === fornecedor),
    );
  }, [pedidosRaw, tab, fornecedor]);

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
      // POST /iniciar é idempotente, mas pode falhar quando todos já estão
      // em separação — nesse caso seguimos pro checklist mesmo assim.
      await sisoFetch("/api/separacao/iniciar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: ids, operador_id: user.id }),
      });
      return ids;
    },
  });

  const forcarPendenteMut = useMutation({
    mutationFn: async (ids: string[]) => {
      const r = await sisoFetch("/api/separacao/forcar-pendente", {
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
        toast.success(`${movidos} pedido(s) movido(s) pra Aguardando Separação`);
      const semNf = body.pedidos_sem_nf?.length ?? 0;
      const naoAut = body.pedidos_nf_nao_autorizada?.length ?? 0;
      if (semNf > 0) toast.warning(`${semNf} pedido(s) sem NF`);
      if (naoAut > 0) toast.warning(`${naoAut} pedido(s) com NF não autorizada`);
      clearSelection();
      refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const moverEtapaMut = useMutation({
    mutationFn: async (args: { ids: string[]; novo_status: StatusServer }) => {
      const r = await sisoFetch("/api/separacao/voltar-etapa", {
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
      const r = await sisoFetch("/api/separacao/retry-etiqueta", {
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
          const r = await sisoFetch("/api/separacao/reimprimir", {
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

  // ── Batch actions per tab ──────────────────────────────────────────────
  const selectedArr = Array.from(selectedIds);

  function batchSepararChecklist(modo?: string) {
    if (selectedArr.length === 0) return;
    iniciarMut.mutate(selectedArr, {
      onSettled: () => {
        const qs = new URLSearchParams();
        qs.set("pedidos", selectedArr.join(","));
        if (modo) qs.set("modo", modo);
        // Usa o checklist legado (não há rota WMS ainda).
        router.push(`/wms/separacao/checklist?${qs.toString()}`);
      },
    });
  }

  function batchEmbalar(modo?: string) {
    if (selectedArr.length === 0) return;
    const qs = new URLSearchParams();
    qs.set("pedidos", selectedArr.join(","));
    if (modo) qs.set("modo", modo);
    router.push(`/wms/separacao/embalagem?${qs.toString()}`);
  }

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
          updateParam("tab", next);
          clearSelection();
          lastCheckedIdxRef.current = null;
        }}
      />

      {/* Toolbar de filtros */}
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
      </div>

      {/* Lista */}
      {isLoading ? (
        <div className="wms-loading-pane">
          <Loader2 className="animate-spin" size={14} /> Carregando pedidos…
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
                <th>Pedido</th>
                <th>Cliente</th>
                <th>Mkt</th>
                <th>Galpão</th>
                <th>Decisão</th>
                <th>Status</th>
                <th>Idade</th>
                <th className="wms-tar">Itens</th>
                <th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {pedidos.map((p, idx) => {
                const isSel = selectedIds.has(p.id);
                const galpao = p.filial_origem ?? "?";
                const galpaoLower = galpao.toLowerCase();
                const progresso =
                  p.total_itens > 0
                    ? Math.round((p.itens_marcados / p.total_itens) * 100)
                    : 0;
                return (
                  <tr
                    key={p.id}
                    className={`wms-tr-clickable ${isSel ? "is-expanded" : ""}`}
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
                        {/* Badges N/A/E — sinais rápidos de NF/Agrupamento/Etiqueta */}
                        {p.nf_emitida && (
                          <span
                            title="NF emitida"
                            style={badgeFlag("info")}
                          >
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
                    </td>
                    <td className="wms-tar wms-mono">
                      {fmtNum(p.total_itens)}
                    </td>
                    <td>
                      {p.separacao_tags.length > 0 ? (
                        <span style={{ fontSize: 11 }}>
                          {p.separacao_tags.join(", ")}
                        </span>
                      ) : (
                        <span className="wms-td-mute">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer sticky de ações em lote */}
      {selectedIds.size > 0 && (
        <BatchActions
          tab={tab}
          ids={selectedArr}
          pedidos={pedidos}
          isAdmin={isAdmin}
          moveTargets={moveTargets}
          moveOpen={moveOpen}
          setMoveOpen={setMoveOpen}
          onClear={clearSelection}
          onSepararChecklist={batchSepararChecklist}
          onEmbalar={batchEmbalar}
          onForcarPendente={() => forcarPendenteMut.mutate(selectedArr)}
          onMoverEtapa={(novo) =>
            moverEtapaMut.mutate({ ids: selectedArr, novo_status: novo })
          }
          onRetryEtiqueta={() => retryEtiquetaMut.mutate(selectedArr)}
          onReimprimir={() => reimprimirMut.mutate(selectedArr)}
          loading={
            iniciarMut.isPending ||
            forcarPendenteMut.isPending ||
            moverEtapaMut.isPending ||
            retryEtiquetaMut.isPending ||
            reimprimirMut.isPending
          }
        />
      )}
    </>
  );
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

function BatchActions({
  tab,
  ids,
  pedidos,
  isAdmin,
  moveTargets,
  moveOpen,
  setMoveOpen,
  onClear,
  onSepararChecklist,
  onEmbalar,
  onForcarPendente,
  onMoverEtapa,
  onRetryEtiqueta,
  onReimprimir,
  loading,
}: {
  tab: Tab;
  ids: string[];
  pedidos: SeparacaoPedido[];
  isAdmin: boolean;
  moveTargets:
    | {
        back: { value: StatusServer; label: string }[];
        forward: { value: StatusServer; label: string }[];
      }
    | undefined;
  moveOpen: boolean;
  setMoveOpen: (v: boolean) => void;
  onClear: () => void;
  onSepararChecklist: (modo?: string) => void;
  onEmbalar: (modo?: string) => void;
  onForcarPendente: () => void;
  onMoverEtapa: (status: StatusServer) => void;
  onRetryEtiqueta: () => void;
  onReimprimir: () => void;
  loading: boolean;
}) {
  const selecionados = pedidos.filter((p) => ids.includes(p.id));
  const engatilhados = selecionados.filter(
    (p) => p.nf_emitida && p.agrupamento_criado,
  );
  const canEmbalarOC =
    tab === "aguardando_compra" &&
    engatilhados.length === selecionados.length &&
    selecionados.length > 0;

  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        marginTop: 16,
        padding: "10px 14px",
        background: "var(--wms-c-paper)",
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        flexWrap: "wrap",
        boxShadow: "0 6px 20px -10px rgba(0,0,0,.18)",
        zIndex: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 13,
        }}
      >
        <strong>{ids.length}</strong> pedido(s) selecionado(s)
        <button
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={onClear}
          type="button"
        >
          <Icon name="x" size={11} />
          Limpar
        </button>
      </div>

      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {/* Mover (admin) */}
        {isAdmin && moveTargets && (
          <div style={{ position: "relative" }}>
            <button
              className="wms-btn wms-btn-ghost wms-btn-sm"
              type="button"
              onClick={() => setMoveOpen(!moveOpen)}
              disabled={loading}
            >
              <Icon name="arrow-right" size={11} />
              Mover…
            </button>
            {moveOpen && (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  bottom: "100%",
                  marginBottom: 6,
                  minWidth: 200,
                  background: "var(--wms-c-paper)",
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
                        onClick={() => onMoverEtapa(t.value)}
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
                        onClick={() => onMoverEtapa(t.value)}
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

        {/* Ações específicas por tab */}
        {tab === "aguardando_compra" && (
          <>
            <button
              className="wms-btn wms-btn-primary wms-btn-sm"
              onClick={() => onSepararChecklist("pick-oc")}
              disabled={loading}
              type="button"
            >
              <Icon name="arrow-right" size={11} />
              Separar (pick-OC) · {ids.length}
            </button>
            {canEmbalarOC && (
              <button
                className="wms-btn wms-btn-primary wms-btn-sm"
                onClick={() => onEmbalar("embalagem-oc")}
                disabled={loading}
                type="button"
                title="Todos os selecionados têm NF + agrupamento prontos"
              >
                <Icon name="check" size={11} />
                Embalar engatilhados · {engatilhados.length}
              </button>
            )}
          </>
        )}

        {tab === "aguardando_nf" && isAdmin && (
          <button
            className="wms-btn wms-btn-ghost wms-btn-sm"
            onClick={onForcarPendente}
            disabled={loading}
            type="button"
            title="Pula a NF e move pra Aguardando Separação"
          >
            <Icon name="alert" size={11} />
            Forçar pendente · {ids.length}
          </button>
        )}

        {tab === "aguardando_separacao" && (
          <button
            className="wms-btn wms-btn-primary wms-btn-sm"
            onClick={() => onSepararChecklist()}
            disabled={loading}
            type="button"
          >
            <Icon name="arrow-right" size={11} />
            Iniciar separação · {ids.length}
          </button>
        )}

        {tab === "em_separacao" && (
          <button
            className="wms-btn wms-btn-primary wms-btn-sm"
            onClick={() => onSepararChecklist()}
            disabled={loading}
            type="button"
          >
            <Icon name="arrow-right" size={11} />
            Retomar · {ids.length}
          </button>
        )}

        {tab === "separado" && (
          <>
            <button
              className="wms-btn wms-btn-ghost wms-btn-sm"
              onClick={onRetryEtiqueta}
              disabled={loading}
              type="button"
            >
              <Icon name="rotate" size={11} />
              Gerar etiqueta · {ids.length}
            </button>
            <button
              className="wms-btn wms-btn-primary wms-btn-sm"
              onClick={() => onEmbalar()}
              disabled={loading}
              type="button"
            >
              <Icon name="check" size={11} />
              Embalar · {ids.length}
            </button>
          </>
        )}

        {tab === "embalado" && (
          <>
            <button
              className="wms-btn wms-btn-ghost wms-btn-sm"
              onClick={onRetryEtiqueta}
              disabled={loading}
              type="button"
            >
              <Icon name="rotate" size={11} />
              Retry etiqueta · {ids.length}
            </button>
            <button
              className="wms-btn wms-btn-primary wms-btn-sm"
              onClick={onReimprimir}
              disabled={loading}
              type="button"
            >
              <Icon name="download" size={11} />
              Imprimir · {ids.length}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

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
