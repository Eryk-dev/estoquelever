"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { sisoFetch, useAuth } from "@/lib/auth-context";
import {
  PageHeader,
  Icon,
  Kpi,
  StatusBadge,
  fmtDateTime,
  fmtRelative,
  fmtNum,
} from "@/components/wms/ui/wms-ui";
import { TimelinePedido } from "@/components/wms/vendas/timeline-pedido";
import {
  EstoquePorGalpaoBar,
  DecisaoLabel,
  ReservaIndicator,
} from "@/components/wms/vendas/estoque-por-galpao-bar";
import {
  getEcommerceAbbr,
  getMarketplaceName,
  formatRelativeTime,
} from "@/lib/domain-helpers";
import type { Decisao } from "@/types";

// ─── Tipos ──────────────────────────────────────────────────────────────────
// Replicados da API (cf. /api/pedidos/[id]/detalhe/route.ts) — não importamos
// do legacy pra manter o módulo WMS auto-contido (sem coupling com a tela
// antiga em /pedidos/[id]).

interface DetalheEstoqueDeposito {
  id: number;
  nome: string;
  saldo: number;
  reservado: number;
  disponivel: number;
}

interface DetalheItem {
  id: string;
  produto_id: number;
  sku: string;
  descricao: string;
  quantidade: number;
  imagem_url: string | null;
  fornecedor_oc: string | null;
  compra_status: string | null;
  compra_quantidade_solicitada: number | null;
  compra_quantidade_comprada: number | null;
  compra_quantidade_recebida: number | null;
  separacao_marcado: boolean;
  bipado_completo: boolean;
  localizacao: string | null;
  estoques: Record<
    string,
    {
      deposito: DetalheEstoqueDeposito;
      atende: boolean;
      localizacao?: string;
    }
  >;
}

interface HistoricoEvento {
  id: string;
  evento: string;
  usuario_id: string | null;
  usuario_nome: string | null;
  detalhes: Record<string, unknown> | null;
  criado_em: string;
}

interface Observacao {
  id: string;
  usuario_id: string | null;
  usuario_nome: string | null;
  texto: string;
  criado_em: string;
}

type StatusSeparacao =
  | "aguardando_compra"
  | "aguardando_nf"
  | "validacao_oc"
  | "aguardando_separacao"
  | "em_separacao"
  | "separado"
  | "embalado"
  | "expedido";

interface PedidoDetalhe {
  id: string;
  numero: string;
  id_pedido_ecommerce: string;
  nome_ecommerce: string;
  cliente_nome: string;
  cliente_cpf_cnpj: string;
  data: string;
  status: "pendente" | "executando" | "concluido" | "cancelado" | "erro";
  status_separacao: StatusSeparacao | null;
  sugestao: string;
  decisao_final: string | null;
  tipo_resolucao: string | null;
  operador: string | null;
  empresa_origem_id: string | null;
  empresa_origem_nome: string | null;
  filial_origem: string | null;
  forma_envio: string | null;
  encaminhado_de: string | null;
  processado_em: string | null;
  separacao_iniciada_em: string | null;
  separacao_concluida_em: string | null;
  embalagem_concluida_em: string | null;
  etiqueta_status: string | null;
  etiqueta_url: string | null;
  agrupamento_expedicao_id: string | null;
  compra_estoque_lancado_alerta: boolean | null;
  marcadores: string[];
  separacao_tags: string[];
  erro: string | null;
  criado_em: string;
  itens: DetalheItem[];
  historico: HistoricoEvento[];
  observacoes: Observacao[];
}

// ─── Labels auxiliares ─────────────────────────────────────────────────────

const STATUS_SEPARACAO_LABELS: Record<string, string> = {
  aguardando_compra: "Ag. Compra",
  aguardando_nf: "Ag. NF",
  validacao_oc: "Validação OC",
  aguardando_separacao: "Ag. Separação",
  em_separacao: "Em separação",
  separado: "Separado",
  embalado: "Embalado",
  expedido: "Expedido",
};

const COMPRA_STATUS_LABELS: Record<string, string> = {
  oc_pendente: "OC pendente",
  aguardando_compra: "Ag. compra",
  comprado: "Comprado",
  recebido: "Recebido",
  indisponivel: "Indisponível",
  equivalente_pendente: "Equiv. pendente",
  cancelamento_pendente: "Cancel. pendente",
  cancelado: "Cancelado",
};

const COMPRA_STATUS_TONE: Record<string, string> = {
  oc_pendente: "warn",
  aguardando_compra: "warn",
  comprado: "info",
  recebido: "ok",
  indisponivel: "danger",
  equivalente_pendente: "info",
  cancelamento_pendente: "warn",
  cancelado: "mute",
};

type TabKey = "itens" | "timeline" | "obs" | "admin";

// ─── Página ─────────────────────────────────────────────────────────────────

export default function WmsPedidoDetalhePage() {
  const params = useParams();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const id = (params?.id as string) ?? "";
  const isAdmin =
    (user?.cargos ?? []).includes("admin") || user?.cargo === "admin";

  const [tab, setTab] = useState<TabKey>("itens");

  const query = useQuery({
    queryKey: ["wms-pedido-detalhe", id],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/pedidos/${id}/detalhe`);
      if (r.status === 404) {
        const err = new Error("not_found");
        (err as Error & { status?: number }).status = 404;
        throw err;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<PedidoDetalhe>;
    },
    enabled: !!id,
    refetchOnWindowFocus: false,
  });

  // ─── Mutations ────────────────────────────────────────────────────────────

  const reimprimir = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch("/api/wms/separacao/reimprimir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_id: id }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok)
        throw new Error(
          (body as { error?: string }).error ?? "Erro ao reimprimir etiqueta",
        );
      if ((body as { status?: string }).status === "falhou") {
        throw new Error(
          (body as { error?: string }).error ?? "Falha na impressão",
        );
      }
      return body as { status: "impresso" | "falhou"; error?: string };
    },
    onSuccess: () => {
      toast.success("Etiqueta enviada pra impressão");
      queryClient.invalidateQueries({
        queryKey: ["wms-pedido-detalhe", id],
      });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const reprocessar = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch("/api/wms/webhook/reprocessar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedidoId: id }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok)
        throw new Error(
          (body as { error?: string }).error ?? "Erro ao reprocessar pedido",
        );
      return body as { ok: boolean };
    },
    onSuccess: () => {
      toast.success("Pedido reenfileirado para reprocessamento");
      queryClient.invalidateQueries({
        queryKey: ["wms-pedido-detalhe", id],
      });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const forcarPendente = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch(`/api/wms/separacao/${id}/forcar-pendente`, {
        method: "PATCH",
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok)
        throw new Error(
          (body as { error?: string }).error ?? "Erro ao forçar pendente",
        );
      return body as { ok: boolean };
    },
    onSuccess: () => {
      toast.success("Pedido devolvido pro estado pendente");
      queryClient.invalidateQueries({
        queryKey: ["wms-pedido-detalhe", id],
      });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const copiarLink = useCallback(() => {
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}/wms/pedidos/${id}`;
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success("Link copiado"))
      .catch(() => toast.error("Não consegui copiar o link"));
  }, [id]);

  // Reserva agregada — calculada antes dos early returns pra respeitar
  // Rules of Hooks. Usa `query.data` opcional; retorna 0 enquanto carrega.
  const galpaoOrigem = query.data?.filial_origem ?? "";
  const totalReservadoOrigem = useMemo(() => {
    if (!query.data || !galpaoOrigem) return 0;
    let total = 0;
    for (const item of query.data.itens) {
      const e = item.estoques[galpaoOrigem];
      if (e?.deposito) total += Number(e.deposito.reservado ?? 0);
    }
    return total;
  }, [query.data, galpaoOrigem]);

  // ─── Estados de carregamento/erro ─────────────────────────────────────────

  if (query.isLoading) {
    return <div className="wms-loading-pane">Carregando pedido…</div>;
  }

  if (query.isError) {
    const err = query.error as Error & { status?: number };
    const notFound = err?.status === 404 || err?.message === "not_found";
    return (
      <div
        className="wms-card"
        style={{
          margin: "32px auto",
          maxWidth: 520,
          padding: 24,
          textAlign: "center",
          borderColor: notFound
            ? "var(--wms-c-border)"
            : "var(--wms-c-danger-bd)",
          background: notFound
            ? "var(--wms-c-panel)"
            : "var(--wms-c-danger-bg)",
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: notFound ? "var(--wms-c-fg)" : "var(--wms-c-danger)",
            marginBottom: 6,
          }}
        >
          {notFound ? "Pedido não encontrado" : "Erro ao carregar pedido"}
        </div>
        {!notFound && (
          <div
            style={{
              fontSize: 12,
              color: "var(--wms-c-mute)",
              marginBottom: 16,
            }}
          >
            {err.message}
          </div>
        )}
        <button
          className="wms-btn wms-btn-ghost"
          onClick={() => router.push("/wms/pedidos")}
        >
          <Icon name="chevron-l" size={11} />
          Voltar para lista
        </button>
      </div>
    );
  }

  const p = query.data!;

  // ─── Helpers de subtítulo + KPIs ──────────────────────────────────────────

  const ecAbbr = getEcommerceAbbr(p.nome_ecommerce ?? "");
  const ecName = getMarketplaceName(p.nome_ecommerce ?? "");
  const subtitleParts = [
    p.nome_ecommerce ? `${ecName} (${ecAbbr})` : null,
    p.id_pedido_ecommerce ? `EC ${p.id_pedido_ecommerce}` : null,
    p.cliente_nome,
    p.filial_origem,
  ].filter(Boolean) as string[];

  const decisao = (p.decisao_final ?? p.sugestao) as Decisao | string;

  // ─── Ações condicionais (botões no PageHeader) ───────────────────────────

  const podeReimprimir = !!p.etiqueta_status;
  const podeReprocessar = isAdmin && p.status === "erro";

  return (
    <>
      <PageHeader
        title={`Pedido #${p.numero}`}
        subtitle={subtitleParts.join(" · ")}
        backHref="/wms/pedidos"
        backLabel="Voltar"
      >
        <button
          className="wms-btn wms-btn-ghost"
          onClick={copiarLink}
          title="Copiar link compartilhável"
        >
          <Icon name="tag" size={12} />
          Copiar link
        </button>
        {podeReimprimir && (
          <button
            className="wms-btn wms-btn-ghost"
            onClick={() => reimprimir.mutate()}
            disabled={reimprimir.isPending}
          >
            <Icon name="download" size={12} />
            {reimprimir.isPending ? "Imprimindo…" : "Reimprimir etiqueta"}
          </button>
        )}
        {podeReprocessar && (
          <button
            className="wms-btn wms-btn-primary"
            onClick={() => reprocessar.mutate()}
            disabled={reprocessar.isPending}
          >
            <Icon name="rotate" size={12} />
            {reprocessar.isPending ? "Reprocessando…" : "Reprocessar"}
          </button>
        )}
      </PageHeader>

      {/* ─── Banner D10 ────────────────────────────────────────────────── */}
      {p.compra_estoque_lancado_alerta && (
        <BannerEstornoManual
          isAdmin={isAdmin}
          onEstornar={() => {
            // TODO: endpoint de estorno manual ainda não existe.
            // Quando existir, chamar e invalidar a query.
            toast.error(
              "Endpoint de estorno manual ainda não implementado — abrir ticket pro admin.",
            );
          }}
        />
      )}

      {/* ─── KPIs ──────────────────────────────────────────────────────── */}
      <div className="wms-kpis" style={{ marginTop: 14 }}>
        <Kpi
          label="Status"
          value={
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              <StatusBadge status={p.status} size="lg" />
              {p.status_separacao && (
                <span
                  className="wms-badge wms-badge-info"
                  title={`Etapa atual: ${
                    STATUS_SEPARACAO_LABELS[p.status_separacao] ??
                    p.status_separacao
                  }`}
                >
                  {STATUS_SEPARACAO_LABELS[p.status_separacao] ??
                    p.status_separacao}
                </span>
              )}
            </span>
          }
          sub={
            p.processado_em
              ? `Processado ${formatRelativeTime(p.processado_em)}`
              : `Criado ${formatRelativeTime(p.criado_em)}`
          }
        />
        <Kpi
          label="Decisão"
          value={
            <DecisaoLabel
              decisao={(decisao as Decisao) ?? "propria"}
              galpaoOrigem={galpaoOrigem || "?"}
              galpaoFulfillment={p.filial_origem ?? null}
              compact
            />
          }
          sub={p.tipo_resolucao ? p.tipo_resolucao : undefined}
        />
        <Kpi
          label="Itens"
          value={fmtNum(p.itens.length)}
          sub={`${fmtNum(
            p.itens.reduce((s, i) => s + Number(i.quantidade ?? 0), 0),
          )} unidades`}
        />
        <Kpi
          label="Operador"
          value={p.operador ?? "—"}
          sub={p.separacao_iniciada_em ? "iniciada" : undefined}
        />
        <Kpi
          label="Galpão"
          value={p.filial_origem ?? "—"}
          sub={
            p.encaminhado_de
              ? `encaminhado de ${p.encaminhado_de}`
              : undefined
          }
        />
        {totalReservadoOrigem > 0 && (
          <Kpi
            label="Reserva"
            value={
              <ReservaIndicator reservado={totalReservadoOrigem} size="md" />
            }
            sub="em pedidos abertos"
          />
        )}
      </div>

      {/* ─── Sub-nav (tabs) ────────────────────────────────────────────── */}
      <div className="wms-toolbar" style={{ marginTop: 16 }}>
        <div className="wms-vtab">
          <button
            className={`wms-vtab-btn ${tab === "itens" ? "is-active" : ""}`}
            onClick={() => setTab("itens")}
          >
            <Icon name="box" size={12} />
            Itens & estoque
            <span className="wms-vtab-n">{p.itens.length}</span>
          </button>
          <button
            className={`wms-vtab-btn ${tab === "timeline" ? "is-active" : ""}`}
            onClick={() => setTab("timeline")}
          >
            <Icon name="history" size={12} />
            Timeline
            <span className="wms-vtab-n">{p.historico.length}</span>
          </button>
          <button
            className={`wms-vtab-btn ${tab === "obs" ? "is-active" : ""}`}
            onClick={() => setTab("obs")}
          >
            <Icon name="clipboard" size={12} />
            Observações
            <span className="wms-vtab-n">{p.observacoes.length}</span>
          </button>
          {isAdmin && (
            <button
              className={`wms-vtab-btn ${tab === "admin" ? "is-active" : ""}`}
              onClick={() => setTab("admin")}
            >
              <Icon name="sliders" size={12} />
              Ações admin
            </button>
          )}
        </div>
      </div>

      {/* ─── Conteúdo por tab ──────────────────────────────────────────── */}
      <div style={{ marginTop: 12 }}>
        {tab === "itens" && (
          <TabItens
            pedido={p}
            galpaoOrigem={galpaoOrigem}
            mostrarColunaCompra={p.itens.some((i) => i.compra_status != null)}
            mostrarColunaSeparacao={p.status_separacao != null}
          />
        )}
        {tab === "timeline" && (
          <div
            className="wms-card"
            style={{ padding: "18px 20px", borderRadius: 8 }}
          >
            <TimelinePedido eventos={p.historico} />
          </div>
        )}
        {tab === "obs" && <TabObservacoes pedidoId={p.id} observacoes={p.observacoes} />}
        {tab === "admin" && isAdmin && (
          <TabAdmin
            pedido={p}
            podeReimprimir={podeReimprimir}
            reimprimir={() => reimprimir.mutate()}
            reimprimirPending={reimprimir.isPending}
            reprocessar={() => reprocessar.mutate()}
            reprocessarPending={reprocessar.isPending}
            forcarPendente={() => forcarPendente.mutate()}
            forcarPendentePending={forcarPendente.isPending}
          />
        )}
      </div>
    </>
  );
}

// ─── Banner D10 ─────────────────────────────────────────────────────────────

function BannerEstornoManual({
  isAdmin,
  onEstornar,
}: {
  isAdmin: boolean;
  onEstornar: () => void;
}) {
  return (
    <div
      style={{
        marginTop: 14,
        padding: "12px 16px",
        borderRadius: 8,
        background: "var(--wms-c-danger-bg)",
        border: "1px solid var(--wms-c-danger-bd)",
        color: "var(--wms-c-danger)",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
      }}
    >
      <div style={{ flexShrink: 0, marginTop: 1 }}>
        <Icon name="alert" size={16} />
      </div>
      <div style={{ flex: 1, fontSize: 13 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>
          Pedido cancelado após separação — estorno manual necessário
        </div>
        <div style={{ fontSize: 12, opacity: 0.85 }}>
          O estoque foi reservado/lançado no Tiny mas o pedido foi cancelado
          depois. É preciso estornar a quantidade manualmente pra fechar a
          posição.
        </div>
      </div>
      {isAdmin && (
        <button
          className="wms-btn wms-btn-danger"
          onClick={onEstornar}
          style={{ flexShrink: 0 }}
        >
          <Icon name="rotate" size={12} />
          Estornar agora
        </button>
      )}
    </div>
  );
}

// ─── Tab: Itens & estoque ───────────────────────────────────────────────────

function TabItens({
  pedido,
  galpaoOrigem,
  mostrarColunaCompra,
  mostrarColunaSeparacao,
}: {
  pedido: PedidoDetalhe;
  galpaoOrigem: string;
  mostrarColunaCompra: boolean;
  mostrarColunaSeparacao: boolean;
}) {
  return (
    <div className="wms-tbl">
      <table>
        <thead>
          <tr>
            <th style={{ width: 44 }}></th>
            <th>SKU</th>
            <th>Produto</th>
            <th>Galpão</th>
            <th>Localização</th>
            <th className="wms-tar">Qty</th>
            <th>Estoque por galpão</th>
            {mostrarColunaSeparacao && <th>Status sep.</th>}
            {mostrarColunaCompra && <th>Compra</th>}
          </tr>
        </thead>
        <tbody>
          {pedido.itens.length === 0 && (
            <tr>
              <td colSpan={9} className="wms-td-empty">
                Nenhum item neste pedido.
              </td>
            </tr>
          )}
          {pedido.itens.map((item) => {
            // Operador NUNCA vê empresa — só galpão. Convertemos o map
            // estoques[galpao] -> { saldo, reservado, disponivel } pro
            // contrato do EstoquePorGalpaoBar.
            const estoquesByGalpao: Record<
              string,
              {
                saldo: number;
                reservado: number;
                disponivel: number;
                localizacao?: string;
              }
            > = {};
            for (const [g, dado] of Object.entries(item.estoques)) {
              estoquesByGalpao[g] = {
                saldo: Number(dado.deposito.saldo ?? 0),
                reservado: Number(dado.deposito.reservado ?? 0),
                disponivel: Number(dado.deposito.disponivel ?? 0),
                localizacao: dado.localizacao,
              };
            }

            // "Galpão" da linha = onde o item está com saldo no galpão de
            // origem do pedido (se houver). Senão, qualquer galpão que
            // tenha localização cadastrada.
            const galpaoDaLoc =
              galpaoOrigem && item.estoques[galpaoOrigem]
                ? galpaoOrigem
                : Object.keys(item.estoques)[0] ?? null;

            return (
              <tr key={item.id}>
                <td>
                  {item.imagem_url && (
                    <img
                      src={item.imagem_url}
                      alt=""
                      loading="lazy"
                      className="wms-thumb wms-thumb-sm"
                    />
                  )}
                </td>
                <td className="wms-mono">{item.sku}</td>
                <td className="wms-td-desc" title={item.descricao}>
                  {item.descricao}
                </td>
                <td>
                  {galpaoDaLoc ? (
                    <span className="wms-chip-emp">{galpaoDaLoc}</span>
                  ) : (
                    <span className="wms-td-mute">—</span>
                  )}
                </td>
                <td className="wms-mono">{item.localizacao ?? "—"}</td>
                <td className="wms-tar wms-mono">{fmtNum(item.quantidade)}</td>
                <td>
                  <EstoquePorGalpaoBar
                    estoques={estoquesByGalpao}
                    quantidadePedida={item.quantidade}
                    galpaoOrigem={galpaoOrigem || null}
                    galpaoDecisaoFinal={
                      pedido.decisao_final === "propria"
                        ? galpaoOrigem || null
                        : null
                    }
                  />
                </td>
                {mostrarColunaSeparacao && (
                  <td>
                    {item.bipado_completo ? (
                      <span className="wms-badge wms-badge-ok">
                        <Icon name="check" size={10} /> Bipado
                      </span>
                    ) : item.separacao_marcado ? (
                      <span className="wms-badge wms-badge-info">Marcado</span>
                    ) : (
                      <span className="wms-td-mute">—</span>
                    )}
                  </td>
                )}
                {mostrarColunaCompra && (
                  <td>
                    {item.compra_status ? (
                      <span
                        className={`wms-badge wms-badge-${
                          COMPRA_STATUS_TONE[item.compra_status] ?? "mute"
                        }`}
                        title={
                          item.fornecedor_oc
                            ? `Fornec.: ${item.fornecedor_oc}`
                            : undefined
                        }
                      >
                        {COMPRA_STATUS_LABELS[item.compra_status] ??
                          item.compra_status}
                      </span>
                    ) : (
                      <span className="wms-td-mute">—</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Tab: Observações ──────────────────────────────────────────────────────

function TabObservacoes({
  pedidoId,
  observacoes,
}: {
  pedidoId: string;
  observacoes: Observacao[];
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [texto, setTexto] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [observacoes.length]);

  const mutation = useMutation({
    mutationFn: async (text: string) => {
      if (!user) throw new Error("Sessão inválida");
      const r = await sisoFetch(`/api/wms/pedidos/${pedidoId}/observacoes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usuarioId: user.id,
          usuarioNome: user.nome,
          texto: text,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok)
        throw new Error(
          (body as { error?: string }).error ?? "Erro ao salvar observação",
        );
      return body as Observacao;
    },
    onMutate: async (text: string) => {
      await queryClient.cancelQueries({
        queryKey: ["wms-pedido-detalhe", pedidoId],
      });
      const previous = queryClient.getQueryData<PedidoDetalhe>([
        "wms-pedido-detalhe",
        pedidoId,
      ]);
      if (previous && user) {
        queryClient.setQueryData<PedidoDetalhe>(
          ["wms-pedido-detalhe", pedidoId],
          {
            ...previous,
            observacoes: [
              ...previous.observacoes,
              {
                id: `temp-${Date.now()}`,
                usuario_id: user.id,
                usuario_nome: user.nome,
                texto: text,
                criado_em: new Date().toISOString(),
              },
            ],
          },
        );
      }
      setTexto("");
      return { previous };
    },
    onError: (err: Error, _text, ctx) => {
      if (ctx && (ctx as { previous?: PedidoDetalhe }).previous) {
        queryClient.setQueryData(
          ["wms-pedido-detalhe", pedidoId],
          (ctx as { previous: PedidoDetalhe }).previous,
        );
      }
      toast.error(err.message);
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ["wms-pedido-detalhe", pedidoId],
      });
    },
  });

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const trimmed = texto.trim();
    if (!trimmed || mutation.isPending || !user) return;
    mutation.mutate(trimmed);
  }

  function onKey(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    // Enter envia, Shift+Enter quebra linha (padrão chat)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div
      className="wms-card"
      style={{ padding: "18px 20px", borderRadius: 8 }}
    >
      <div
        ref={scrollRef}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          maxHeight: 360,
          overflowY: "auto",
          marginBottom: 14,
          paddingRight: 4,
        }}
      >
        {observacoes.length === 0 && (
          <div
            className="wms-td-mute"
            style={{ textAlign: "center", padding: "16px 0", fontSize: 12.5 }}
          >
            Nenhuma observação ainda.
          </div>
        )}
        {observacoes.map((obs) => (
          <div
            key={obs.id}
            style={{
              padding: "10px 12px",
              borderRadius: 6,
              background: "var(--wms-c-panel-2)",
              border: "1px solid var(--wms-c-border)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 4,
                fontSize: 12,
              }}
            >
              <strong style={{ color: "var(--wms-c-fg)" }}>
                {obs.usuario_nome ?? "—"}
              </strong>
              <span
                className="wms-td-mute"
                style={{ fontSize: 11, fontFamily: "var(--wms-font-mono)" }}
                title={fmtDateTime(obs.criado_em)}
              >
                {fmtRelative(obs.criado_em)}
              </span>
            </div>
            <div
              style={{
                fontSize: 12.5,
                whiteSpace: "pre-wrap",
                color: "var(--wms-c-fg-2)",
              }}
            >
              {obs.texto}
            </div>
          </div>
        ))}
      </div>
      <form
        onSubmit={submit}
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        <textarea
          ref={taRef}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={onKey}
          rows={3}
          placeholder="Escreva uma observação… (Enter envia, Shift+Enter quebra linha)"
          disabled={mutation.isPending || !user}
          className="wms-input"
          style={{
            width: "100%",
            resize: "vertical",
            fontFamily: "inherit",
            fontSize: 13,
            padding: 10,
            borderRadius: 6,
            border: "1px solid var(--wms-c-border)",
            background: "var(--wms-c-panel)",
            color: "var(--wms-c-fg)",
          }}
        />
        <div
          style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}
        >
          <button
            type="submit"
            className="wms-btn wms-btn-primary"
            disabled={mutation.isPending || !texto.trim() || !user}
          >
            {mutation.isPending ? "Enviando…" : "Adicionar observação"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Tab: Ações admin ──────────────────────────────────────────────────────

function TabAdmin({
  pedido,
  podeReimprimir,
  reimprimir,
  reimprimirPending,
  reprocessar,
  reprocessarPending,
  forcarPendente,
  forcarPendentePending,
}: {
  pedido: PedidoDetalhe;
  podeReimprimir: boolean;
  reimprimir: () => void;
  reimprimirPending: boolean;
  reprocessar: () => void;
  reprocessarPending: boolean;
  forcarPendente: () => void;
  forcarPendentePending: boolean;
}) {
  function confirmar(msg: string, fn: () => void) {
    if (typeof window === "undefined") return;
    if (window.confirm(msg)) fn();
  }

  const podeReprocessar = pedido.status === "erro";
  const podeForcarPendente = pedido.status_separacao != null;

  // TODO: Liberar reserva (D2 override) — implementação dependente do Plano 3
  //   Endpoint ainda não existe; quando existir, plugar aqui como mais uma
  //   ação admin (`POST /api/wms/reservas/{id}/liberar` ou similar).

  return (
    <div
      className="wms-card"
      style={{ padding: "18px 20px", borderRadius: 8 }}
    >
      <div
        style={{
          padding: "10px 12px",
          marginBottom: 16,
          borderRadius: 6,
          background: "var(--wms-c-warn-bg)",
          border: "1px solid var(--wms-c-warn-bd)",
          color: "var(--wms-c-warn)",
          fontSize: 12.5,
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
        }}
      >
        <Icon name="alert" size={14} />
        <div>
          <strong>Ações de exceção.</strong> Use só quando há motivo claro —
          logs ficam visíveis no histórico do pedido.
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 12,
        }}
      >
        <AcaoAdminRow
          icone="rotate"
          titulo="Reprocessar pedido"
          descricao="Re-executa o webhook do Tiny para este pedido. Útil quando o processamento original falhou (status=erro)."
          disponivel={podeReprocessar}
          motivoIndisponivel="Disponível apenas se status do pedido é 'erro'."
          actionLabel={reprocessarPending ? "Reprocessando…" : "Reprocessar"}
          onClick={() =>
            confirmar(
              "Reprocessar este pedido a partir do webhook do Tiny?",
              reprocessar,
            )
          }
          pending={reprocessarPending}
          tone="primary"
        />
        <AcaoAdminRow
          icone="arrow-left"
          titulo="Forçar pendente"
          descricao="Devolve o pedido pro estado 'pendente' (zera status de separação). Use quando uma separação ficou travada num estado inválido."
          disponivel={podeForcarPendente}
          motivoIndisponivel="Pedido ainda não entrou em separação."
          actionLabel={
            forcarPendentePending ? "Forçando…" : "Forçar pendente"
          }
          onClick={() =>
            confirmar(
              "Forçar este pedido de volta pro estado pendente? A separação atual será descartada.",
              forcarPendente,
            )
          }
          pending={forcarPendentePending}
          tone="danger"
        />
        <AcaoAdminRow
          icone="download"
          titulo="Reimprimir etiqueta"
          descricao="Reenvia a etiqueta de envio pra impressora PrintNode configurada. Útil se a impressão original falhou ou ficou ilegível."
          disponivel={podeReimprimir}
          motivoIndisponivel="Pedido ainda não tem etiqueta gerada."
          actionLabel={
            reimprimirPending ? "Imprimindo…" : "Reimprimir etiqueta"
          }
          onClick={() =>
            confirmar("Reimprimir a etiqueta deste pedido?", reimprimir)
          }
          pending={reimprimirPending}
          tone="ghost"
        />
      </div>
    </div>
  );
}

function AcaoAdminRow({
  icone,
  titulo,
  descricao,
  disponivel,
  motivoIndisponivel,
  actionLabel,
  onClick,
  pending,
  tone,
}: {
  icone: Parameters<typeof Icon>[0]["name"];
  titulo: string;
  descricao: string;
  disponivel: boolean;
  motivoIndisponivel: string;
  actionLabel: string;
  onClick: () => void;
  pending: boolean;
  tone: "primary" | "ghost" | "danger";
}) {
  const btnCls =
    tone === "primary"
      ? "wms-btn wms-btn-primary"
      : tone === "danger"
        ? "wms-btn wms-btn-danger"
        : "wms-btn wms-btn-ghost";
  return (
    <div
      style={{
        display: "flex",
        gap: 14,
        padding: "12px 14px",
        borderRadius: 6,
        border: "1px solid var(--wms-c-border)",
        background: "var(--wms-c-panel)",
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 6,
          background: "var(--wms-c-panel-2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--wms-c-mute)",
          flexShrink: 0,
        }}
      >
        <Icon name={icone} size={14} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{ fontSize: 13, fontWeight: 600, color: "var(--wms-c-fg)" }}
        >
          {titulo}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--wms-c-mute)",
            marginTop: 2,
            lineHeight: 1.4,
          }}
        >
          {disponivel ? descricao : motivoIndisponivel}
        </div>
      </div>
      <button
        className={btnCls}
        disabled={!disponivel || pending}
        onClick={onClick}
        style={{ flexShrink: 0 }}
      >
        {actionLabel}
      </button>
    </div>
  );
}
