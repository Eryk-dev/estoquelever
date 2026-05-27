"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { sisoFetch, useAuth, usePermissoes } from "@/lib/auth-context";
import { usePedidosEstoqueRealtime } from "@/hooks/use-pedidos-estoque-realtime";
import {
  PageHeader,
  Icon,
  Pagination,
  StatusBadge,
} from "@/components/wms/ui/wms-ui";
import { PedidoCardWms } from "@/components/wms/vendas/pedido-card-wms";
import {
  PedidoCardConcluidoWms,
  type PedidoConcluidoData,
} from "@/components/wms/vendas/pedido-card-concluido-wms";
import { DecisaoLabel } from "@/components/wms/vendas/estoque-por-galpao-bar";
import {
  getEcommerceAbbr,
  getMarketplaceName,
  formatRelativeTime,
} from "@/lib/domain-helpers";
import type { Pedido, Decisao } from "@/types";

// ── Tipos ───────────────────────────────────────────────────────────

type Tab = "pendente" | "concluidos" | "auto" | "expedidos";

interface TrackingPedido {
  id: string;
  numero: string;
  id_pedido_ecommerce: string;
  nome_ecommerce: string;
  cliente_nome: string;
  cliente_cpf_cnpj: string;
  data: string;
  status: string;
  status_separacao: string | null;
  sugestao: "propria" | "transferencia" | "oc";
  decisao_final: "propria" | "transferencia" | "oc" | null;
  tipo_resolucao: "auto" | "manual" | null;
  operador: string | null;
  empresa_origem_nome: string | null;
  filial_origem: string | null;
  marcadores: string[];
  separacao_tags: string[];
  etiqueta_status: string | null;
  embalagem_concluida_em: string | null;
  criado_em: string;
  erro: string | null;
  nota_fiscal_numero?: string | null;
}

interface TrackingResponse {
  pedidos: TrackingPedido[];
  total: number;
  page: number;
  totalPages: number;
}

// ── Página ──────────────────────────────────────────────────────────

export default function WmsPedidosPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, activeGalpaoId, activeGalpaoNome } = useAuth();
  const { can } = usePermissoes();
  const podeAprovar = can("pedidos.aprovar");
  const queryClient = useQueryClient();

  const cargos = useMemo(
    () => user?.cargos ?? (user?.cargo ? [user.cargo] : []),
    [user],
  );
  const hideAuto = cargos.length === 1 && cargos[0] === "comprador";

  // Push-based refresh: invalida ["wms-pedidos"] quando siso_estoque
  // ou siso_movimentacoes mudam (debounced 800ms). Mantém polling 30s
  // como fallback caso o websocket caia.
  usePedidosEstoqueRealtime();

  const tab = ((searchParams?.get("tab") as Tab) ?? "pendente") as Tab;
  const buscaParam = searchParams?.get("busca") ?? "";
  const page = Math.max(1, Number(searchParams?.get("page") ?? "1") || 1);

  // Busca local com debounce → query param
  const [buscaInput, setBuscaInput] = useState(buscaParam);
  useEffect(() => {
    setBuscaInput(buscaParam);
  }, [buscaParam]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (buscaInput === buscaParam) return;
      const params = new URLSearchParams(
        Array.from(searchParams?.entries() ?? []),
      );
      if (buscaInput) {
        params.set("busca", buscaInput);
      } else {
        params.delete("busca");
      }
      params.delete("page"); // reset paginação na nova busca
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscaInput]);

  const setTab = useCallback(
    (next: Tab) => {
      const params = new URLSearchParams(
        Array.from(searchParams?.entries() ?? []),
      );
      params.set("tab", next);
      params.delete("page");
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const setPage = useCallback(
    (next: number) => {
      const params = new URLSearchParams(
        Array.from(searchParams?.entries() ?? []),
      );
      params.set("page", String(next));
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  // ── Query: pedidos base (pendente/concluidos/auto) ──────────────
  const pedidosQuery = useQuery({
    queryKey: ["wms-pedidos"],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/pedidos`);
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      return (await r.json()) as Pedido[];
    },
    refetchInterval: 30_000,
    enabled: tab !== "expedidos",
  });

  // ── Query: tracking (expedidos) ─────────────────────────────────
  const trackingQuery = useQuery({
    queryKey: ["wms-pedidos-tracking", "expedidos", page, buscaParam],
    queryFn: async () => {
      const qs = new URLSearchParams({
        tab: "expedidos",
        page: String(page),
        limit: "50",
      });
      if (buscaParam) qs.set("busca", buscaParam);
      const r = await sisoFetch(`/api/wms/pedidos/tracking?${qs.toString()}`);
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      return (await r.json()) as TrackingResponse;
    },
    refetchInterval: 30_000,
    enabled: tab === "expedidos",
  });

  // ── Derivações ──────────────────────────────────────────────────
  const allPedidos = pedidosQuery.data ?? [];

  // Filtro galpão global
  const filteredByGalpao = useMemo(() => {
    if (!activeGalpaoNome) return allPedidos;
    return allPedidos.filter((p) => p.filialOrigem === activeGalpaoNome);
  }, [allPedidos, activeGalpaoNome]);

  // Busca client-side
  const ql = buscaParam.trim().toLowerCase();
  const buscaMatch = useCallback(
    (p: Pedido) => {
      if (!ql) return true;
      if (p.numero?.toLowerCase().includes(ql)) return true;
      if (p.idPedidoEcommerce?.toLowerCase().includes(ql)) return true;
      if (p.cliente?.nome?.toLowerCase().includes(ql)) return true;
      if (
        p.itens?.some(
          (i) =>
            i.sku?.toLowerCase().includes(ql) ||
            i.descricao?.toLowerCase().includes(ql),
        )
      )
        return true;
      return false;
    },
    [ql],
  );

  const pendentes = useMemo(() => {
    return filteredByGalpao
      .filter(
        (p) =>
          p.status === "pendente" ||
          p.status_separacao === "pendente_realocacao",
      )
      .filter(buscaMatch)
      .sort(
        (a, b) =>
          new Date(b.criadoEm).getTime() - new Date(a.criadoEm).getTime(),
      );
  }, [filteredByGalpao, buscaMatch]);

  const concluidos = useMemo(() => {
    return filteredByGalpao
      .filter((p) => p.status === "concluido")
      .filter(buscaMatch)
      .sort((a, b) => {
        const ta = new Date(a.processadoEm ?? a.criadoEm).getTime();
        const tb = new Date(b.processadoEm ?? b.criadoEm).getTime();
        return tb - ta;
      });
  }, [filteredByGalpao, buscaMatch]);

  const autoResolvidos = useMemo(() => {
    return concluidos.filter((p) => p.tipoResolucao === "auto");
  }, [concluidos]);

  const expedidos = useMemo(() => {
    const list = trackingQuery.data?.pedidos ?? [];
    if (!activeGalpaoNome) return list;
    return list.filter((p) => p.filial_origem === activeGalpaoNome);
  }, [trackingQuery.data, activeGalpaoNome]);

  // ── Counts (sempre derivados das suas próprias fontes) ──────────
  const countPendente = pendentes.length;
  const countConcluidos = concluidos.length;
  const countAuto = autoResolvidos.length;
  // expedidos: o número total não-filtrado pelo galpão vem do servidor;
  // como o filtro é client-side, usamos o tamanho da lista filtrada
  // somado a "+" quando há mais páginas — exibimos só o número da página
  // atual filtrada (visualmente "X" pedidos visíveis).
  const countExpedidos = expedidos.length;

  // ── Refresh handler ─────────────────────────────────────────────
  const handleRefresh = useCallback(() => {
    if (tab === "expedidos") {
      queryClient.invalidateQueries({ queryKey: ["wms-pedidos-tracking"] });
    } else {
      queryClient.invalidateQueries({ queryKey: ["wms-pedidos"] });
    }
  }, [queryClient, tab]);

  // ── Aprovar pedido (pendente tab) — operador escolhe a decisão ────
  const aprovarPedido = useCallback(
    async (p: Pedido, decisao: Decisao) => {
      if (!user) {
        toast.error("Sessão inválida");
        return;
      }
      try {
        const r = await sisoFetch(`/api/wms/pedidos/aprovar`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pedidoId: p.id,
            decisao,
            operadorId: user.id,
            operadorNome: user.nome,
          }),
        });
        if (!r.ok) {
          const b = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error || `HTTP ${r.status}`);
        }
        toast.success(`Pedido #${p.numero} aprovado → ${decisao}`);
        queryClient.invalidateQueries({ queryKey: ["wms-pedidos"] });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Erro ao aprovar");
      }
    },
    [queryClient, user],
  );

  // ── Reimprimir etiqueta (expedidos tab) ─────────────────────────
  const reimprimirEtiqueta = useCallback(async (pedidoId: string) => {
    try {
      const r = await sisoFetch(`/api/wms/separacao/reimprimir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_id: pedidoId }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      toast.success("Etiqueta enviada pra impressora");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao reimprimir");
    }
  }, []);

  // ── Mappers: Pedido → props dos cards ───────────────────────────
  const mapItens = useCallback((p: Pedido) => {
    return (p.itens ?? []).map((it) => ({
      itemId: it.itemId,
      produtoId: it.produtoId,
      sku: it.sku,
      descricao: it.descricao,
      quantidadePedida: it.quantidadePedida,
      imagemUrl: it.imagemUrl,
      fornecedorOC: it.fornecedorOC,
      estoques: Object.fromEntries(
        Object.entries(it.estoques ?? {}).map(([galpao, ge]) => [
          galpao,
          {
            saldo: ge.deposito.saldo,
            reservado: ge.deposito.reservado,
            disponivel: ge.deposito.disponivel,
            localizacao: ge.localizacao,
          },
        ]),
      ),
    }));
  }, []);

  const toCardPedido = useCallback(
    (p: Pedido): Parameters<typeof PedidoCardWms>[0]["pedido"] => ({
      id: p.id,
      numero: p.numero,
      idPedidoEcommerce: p.idPedidoEcommerce,
      nomeEcommerce: p.nomeEcommerce,
      cliente: { nome: p.cliente.nome, cpfCnpj: p.cliente.cpfCnpj },
      filialOrigem: p.filialOrigem,
      filialFulfillment: null,
      sugestao: p.sugestao,
      decisaoFinal: p.decisaoFinal,
      compraEstoqueLancadoAlerta: p.compra_estoque_lancado_alerta,
      encaminhadoDe: p.encaminhado_de ?? null,
      empresaOrigemNome: p.empresaOrigemNome ?? null,
      criadoEm: p.criadoEm,
      itens: mapItens(p),
    }),
    [mapItens],
  );

  const toCardConcluido = useCallback(
    (p: Pedido): PedidoConcluidoData => ({
      id: p.id,
      numero: p.numero,
      idPedidoEcommerce: p.idPedidoEcommerce,
      nomeEcommerce: p.nomeEcommerce,
      cliente: { nome: p.cliente.nome },
      filialOrigem: p.filialOrigem,
      filialFulfillment: null,
      sugestao: p.sugestao,
      decisaoFinal: p.decisaoFinal ?? null,
      tipoResolucao: p.tipoResolucao ?? null,
      operador: p.operador ?? null,
      processadoEm: p.processadoEm ?? null,
      criadoEm: p.criadoEm,
      marcadores: p.marcadores,
      erro: p.erro,
      empresaOrigemNome: p.empresaOrigemNome ?? null,
      encaminhadoDe: p.encaminhado_de ?? null,
      sugestaoMotivo: p.sugestaoMotivo ?? null,
      itens: mapItens(p),
    }),
    [mapItens],
  );

  // ── Loading/erro consolidado ────────────────────────────────────
  const currentLoading =
    tab === "expedidos" ? trackingQuery.isLoading : pedidosQuery.isLoading;
  const currentError =
    tab === "expedidos" ? trackingQuery.error : pedidosQuery.error;

  // ── Render ──────────────────────────────────────────────────────
  return (
    <>
      <PageHeader
        title="Pedidos"
        subtitle="Aprovação, acompanhamento e rastreamento de pedidos"
      >
        <button className="wms-btn wms-btn-ghost" onClick={handleRefresh}>
          <Icon name="rotate" size={12} />
          Atualizar
        </button>
      </PageHeader>

      <div className="wms-toolbar">
        <div className="wms-search-wrap">
          <Icon name="search" size={13} />
          <input
            value={buscaInput}
            onChange={(e) => setBuscaInput(e.target.value)}
            placeholder="Buscar #pedido, EC, cliente, SKU ou descrição…"
          />
          {buscaInput && (
            <button
              className="wms-search-clear"
              onClick={() => setBuscaInput("")}
              aria-label="Limpar busca"
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
      </div>

      <div className="wms-vtab" style={{ marginBottom: 16 }}>
        <button
          className={`wms-vtab-btn ${tab === "pendente" ? "is-active" : ""}`}
          onClick={() => setTab("pendente")}
        >
          Pendentes <span className="wms-vtab-n">{countPendente}</span>
        </button>
        <button
          className={`wms-vtab-btn ${tab === "concluidos" ? "is-active" : ""}`}
          onClick={() => setTab("concluidos")}
        >
          Concluídos <span className="wms-vtab-n">{countConcluidos}</span>
        </button>
        {!hideAuto && (
          <button
            className={`wms-vtab-btn ${tab === "auto" ? "is-active" : ""}`}
            onClick={() => setTab("auto")}
          >
            Auto <span className="wms-vtab-n">{countAuto}</span>
          </button>
        )}
        <button
          className={`wms-vtab-btn ${tab === "expedidos" ? "is-active" : ""}`}
          onClick={() => setTab("expedidos")}
        >
          Expedidos <span className="wms-vtab-n">{countExpedidos}</span>
        </button>
      </div>

      {currentLoading && (
        <div className="wms-loading-pane">Carregando pedidos…</div>
      )}

      {currentError && !currentLoading && (
        <div
          className="wms-td-danger"
          style={{
            padding: 12,
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-2)",
            background: "var(--wms-c-panel-2)",
            fontSize: 13,
          }}
        >
          Erro: {(currentError as Error).message}
        </div>
      )}

      {!currentLoading && !currentError && (
        <>
          {tab === "pendente" && (
            <TabPendente
              pedidos={pendentes}
              toCardPedido={toCardPedido}
              onAprovar={aprovarPedido}
              onClickPedido={(id) => router.push(`/wms/pedidos/${id}`)}
              podeAprovar={podeAprovar}
            />
          )}

          {tab === "concluidos" && (
            <TabConcluidos
              pedidos={concluidos}
              toCardConcluido={toCardConcluido}
              onClickPedido={(id) => router.push(`/wms/pedidos/${id}`)}
            />
          )}

          {tab === "auto" && (
            <TabConcluidos
              pedidos={autoResolvidos}
              toCardConcluido={toCardConcluido}
              onClickPedido={(id) => router.push(`/wms/pedidos/${id}`)}
              ocultarOperador
            />
          )}

          {tab === "expedidos" && (
            <TabExpedidos
              pedidos={expedidos}
              totalServidor={trackingQuery.data?.total ?? 0}
              page={page}
              onPageChange={setPage}
              onClickPedido={(id) => router.push(`/wms/pedidos/${id}`)}
              onReimprimir={reimprimirEtiqueta}
            />
          )}
        </>
      )}
    </>
  );
}

// ── Tab: Pendente ──────────────────────────────────────────────────

function TabPendente({
  pedidos,
  toCardPedido,
  onAprovar,
  onClickPedido,
  podeAprovar,
}: {
  pedidos: Pedido[];
  toCardPedido: (p: Pedido) => Parameters<typeof PedidoCardWms>[0]["pedido"];
  onAprovar: (p: Pedido, decisao: Decisao) => Promise<void> | void;
  onClickPedido: (id: string) => void;
  podeAprovar: boolean;
}) {
  // Estado local de loading por pedido (impede aprovações duplas)
  const [loadingId, setLoadingId] = useState<string | null>(null);

  if (pedidos.length === 0) {
    return (
      <div className="wms-empty-block">
        <h3>Nenhum pedido pendente</h3>
        <p>
          Quando um pedido chegar pelo webhook do Tiny e exigir aprovação manual,
          ele aparece aqui.
        </p>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {pedidos.map((p) => (
        <div key={p.id}>
          {p.status_separacao === "pendente_realocacao" && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 4,
              }}
            >
              <StatusBadge status="pendente_realocacao" />
              <span
                style={{
                  fontSize: 11,
                  color: "var(--wms-c-warn)",
                  fontWeight: 500,
                }}
              >
                Aguardando realocação manual — separação interrompida por short
                pick sem cobertura
              </span>
            </div>
          )}
          <PedidoCardWms
            pedido={toCardPedido(p)}
            onClick={() => onClickPedido(p.id)}
            interactive={
              podeAprovar
                ? {
                    loading: loadingId === p.id,
                    onApprove: async (decisao) => {
                      if (
                        !window.confirm(
                          `Aprovar pedido #${p.numero} com a decisão "${decisao}"?`,
                        )
                      )
                        return;
                      setLoadingId(p.id);
                      try {
                        await onAprovar(p, decisao);
                      } finally {
                        setLoadingId(null);
                      }
                    },
                  }
                : undefined
            }
          />
        </div>
      ))}
    </div>
  );
}

// ── Tab: Concluídos / Auto ─────────────────────────────────────────

function TabConcluidos({
  pedidos,
  toCardConcluido,
  onClickPedido,
  ocultarOperador = false,
}: {
  pedidos: Pedido[];
  toCardConcluido: (p: Pedido) => PedidoConcluidoData;
  onClickPedido: (id: string) => void;
  ocultarOperador?: boolean;
}) {
  if (pedidos.length === 0) {
    return (
      <div className="wms-empty-block">
        <h3>Nada por aqui</h3>
        <p>
          {ocultarOperador
            ? "Nenhum pedido auto-resolvido no período."
            : "Nenhum pedido concluído ainda."}
        </p>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {pedidos.map((p) => (
        <PedidoCardConcluidoWms
          key={p.id}
          pedido={toCardConcluido(p)}
          onClick={() => onClickPedido(p.id)}
          ocultarOperador={ocultarOperador}
        />
      ))}
    </div>
  );
}

// ── Tab: Expedidos ─────────────────────────────────────────────────

function TabExpedidos({
  pedidos,
  totalServidor,
  page,
  onPageChange,
  onClickPedido,
  onReimprimir,
}: {
  pedidos: TrackingPedido[];
  totalServidor: number;
  page: number;
  onPageChange: (p: number) => void;
  onClickPedido: (id: string) => void;
  onReimprimir: (id: string) => void;
}) {
  if (pedidos.length === 0) {
    return (
      <div className="wms-empty-block">
        <h3>Nenhum pedido expedido</h3>
        <p>
          Pedidos com etiqueta impressa e embalagem concluída aparecem aqui pra
          rastreamento.
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="wms-tbl">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Cliente</th>
              <th>Marketplace</th>
              <th>Galpão</th>
              <th>Decisão</th>
              <th>Separação</th>
              <th>Etiqueta</th>
              <th className="wms-tar">Embalado</th>
              <th style={{ width: 130 }}></th>
            </tr>
          </thead>
          <tbody>
            {pedidos.map((p) => (
              <tr
                key={p.id}
                className="wms-tr-clickable"
                onClick={() => onClickPedido(p.id)}
              >
                <td className="wms-mono">
                  <a className="wms-link-row">
                    #{p.nota_fiscal_numero ?? p.numero}
                  </a>
                </td>
                <td>{p.cliente_nome}</td>
                <td>
                  <span
                    className="wms-pcard-chip"
                    title={getMarketplaceName(p.nome_ecommerce)}
                  >
                    {getEcommerceAbbr(p.nome_ecommerce)}
                  </span>
                </td>
                <td>
                  {p.filial_origem ? (
                    <span className="wms-pcard-chip is-galpao">
                      {p.filial_origem}
                    </span>
                  ) : (
                    <span className="wms-td-mute">—</span>
                  )}
                </td>
                <td>
                  <DecisaoLabel
                    decisao={p.decisao_final ?? p.sugestao}
                    galpaoOrigem={p.filial_origem ?? ""}
                    galpaoFulfillment={null}
                    compact
                  />
                </td>
                <td>
                  {p.status_separacao ? (
                    <StatusBadge status={p.status_separacao} />
                  ) : (
                    <span className="wms-td-mute">—</span>
                  )}
                </td>
                <td>
                  {p.etiqueta_status ? (
                    <StatusBadge status={p.etiqueta_status} />
                  ) : (
                    <span className="wms-td-mute">—</span>
                  )}
                </td>
                <td className="wms-tar wms-td-mute" style={{ fontSize: 12 }}>
                  {p.embalagem_concluida_em
                    ? formatRelativeTime(p.embalagem_concluida_em)
                    : "—"}
                </td>
                <td className="wms-td-actions">
                  {p.etiqueta_status === "impresso" && (
                    <button
                      className="wms-btn wms-btn-ghost wms-btn-sm"
                      title="Reimprimir etiqueta"
                      onClick={(e) => {
                        e.stopPropagation();
                        onReimprimir(p.id);
                      }}
                    >
                      <Icon name="rotate" size={11} />
                      Etiqueta
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        total={totalServidor}
        pageSize={50}
        page={page}
        onPageChange={onPageChange}
        label="pedidos"
      />
      <div
        className="wms-td-mute"
        style={{ fontSize: 11, marginTop: 6, textAlign: "right" }}
        title="O total reflete os pedidos do servidor antes do filtro client-side por galpão."
      >
        <Icon name="alert" size={10} /> exibindo {pedidos.length} de{" "}
        {totalServidor} (filtro de galpão aplicado nesta página)
      </div>
    </>
  );
}

