"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Suspense,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { sisoFetch, useAuth } from "@/lib/auth-context";
import {
  PageHeader,
  Icon,
  StatusBadge,
  fmtNum,
  fmtRelative,
} from "@/components/wms/ui/wms-ui";
import { HandheldScan } from "@/components/wms/vendas/handheld-scan";
import { FotoProdutoZoom } from "@/components/wms/produto-lightbox";
import { naturalLocCompare } from "@/lib/domain-helpers";
import type { SeparacaoPedido } from "@/components/wms/separacao/types";
import { useTrackPresencaWms } from "@/hooks/use-presenca-wms";
import { useRealtimeSeparacao } from "@/hooks/use-realtime-separacao";

// ─── Types ──────────────────────────────────────────────────────────────────

interface PedidoItemRealocacao {
  id: string;
  status: string;
  quantidade_pega: number | null;
}

interface PedidoItem {
  id: string;
  pedido_id: string;
  produto_id: string;
  sku: string;
  gtin: string | null;
  descricao: string;
  quantidade: number;
  quantidade_bipada: number;
  bipado_completo: boolean;
  localizacao: string | null;
  imagem_url: string | null;
  quantidade_pega: number | null;
  separacao_parcial: boolean;
  realocacoes?: PedidoItemRealocacao[];
}

interface BiparResult {
  pedido_id: string;
  quantidade_bipada: number;
  pedido_completo: boolean;
  etiqueta_status?: string | null;
  etiqueta_erro?: string | null;
}

interface ConfirmarResult {
  quantidade_bipada: number;
  bipado_completo: boolean;
  pedido_completo: boolean;
  pedido_id?: string;
  etiqueta_status?: string | null;
  etiqueta_erro?: string | null;
}

type ScanTone = "ok" | "warn" | "error" | "neutral";

// ─── Wrapper (Suspense for useSearchParams) ────────────────────────────────

export default function WmsEmbalagemPageWrapper() {
  return (
    <Suspense fallback={<div className="wms-loading-pane">Carregando…</div>}>
      <WmsEmbalagemPage />
    </Suspense>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

function WmsEmbalagemPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const queryClient = useQueryClient();
  const { activeGalpaoId } = useAuth();

  const pedidoIds = useMemo(
    () => (sp?.get("pedidos") ?? "").split(",").filter(Boolean),
    [sp],
  );
  const modo = sp?.get("modo") === "embalagem-oc" ? "embalagem-oc" : null;

  // Anuncia presença no card "Embalagem" do quadro de tarefas (/wms).
  useTrackPresencaWms("embalagem");

  // Realtime escopado: mudanças nos pedidos/itens desta tela invalidam o
  // prefixo ["wms-embalagem"] (cobre as queries de pedidos E itens abaixo).
  // Vira o gatilho primário de freshness; o poll de 15s é só backstop.
  useRealtimeSeparacao({ pedidoIds, queryKey: ["wms-embalagem"] });

  const [scanQty, setScanQty] = useState(1);
  const [scanFeedback, setScanFeedback] = useState<{
    text: string;
    tone: ScanTone;
  } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Pedidos concluídos durante esta sessão (mantém visíveis mesmo
  // após o GET parar de retorná-los, pra permitir reimprimir).
  const completedIdsRef = useRef<Set<string>>(new Set());

  // ─── Query: pedidos ─────────────────────────────────────────────
  const pedidosQueryKey = useMemo(
    () => ["wms-embalagem", "pedidos", pedidoIds.join(","), modo ?? ""],
    [pedidoIds, modo],
  );

  const pedidosQuery = useQuery<SeparacaoPedido[]>({
    queryKey: pedidosQueryKey,
    queryFn: async () => {
      const statusList =
        modo === "embalagem-oc" ? "aguardando_compra,separado" : "separado";
      const r = await sisoFetch(
        `/api/wms/separacao?status_separacao=${statusList}`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as { pedidos?: SeparacaoPedido[] };
      const list = json.pedidos ?? [];
      return list.filter((p) => pedidoIds.includes(p.id));
    },
    enabled: pedidoIds.length > 0,
    // Backstop — realtime escopado acima é o gatilho primário.
    refetchInterval: 15_000,
  });

  // ─── Query: itens ─────────────────────────────────────────────
  const itemsQueryKey = useMemo(
    () => ["wms-embalagem", "items", pedidoIds.join(","), modo ?? ""],
    [pedidoIds, modo],
  );

  const itemsQuery = useQuery<{ items: PedidoItem[] }>({
    queryKey: itemsQueryKey,
    queryFn: async () => {
      const url = `/api/wms/separacao/checklist-items?pedidos=${pedidoIds.join(
        ",",
      )}${modo ? `&modo=${modo}` : ""}`;
      const r = await sisoFetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { items: PedidoItem[] };
    },
    enabled: pedidoIds.length > 0,
    staleTime: 30_000,
  });

  const pedidos = pedidosQuery.data ?? [];
  const items = itemsQuery.data?.items ?? [];

  // Manter ordem original dos pedidoIds da URL (não da query).
  const pedidosOrdenados = useMemo(() => {
    const map = new Map(pedidos.map((p) => [p.id, p]));
    return pedidoIds
      .map((id) => map.get(id))
      .filter((p): p is SeparacaoPedido => p !== undefined);
  }, [pedidos, pedidoIds]);

  // Agrupar itens por pedido + sort por localização.
  const itemsByPedido = useMemo(() => {
    const map = new Map<string, PedidoItem[]>();
    for (const it of items) {
      const list = map.get(it.pedido_id) ?? [];
      list.push(it);
      map.set(it.pedido_id, list);
    }
    for (const [k, list] of map) {
      map.set(
        k,
        [...list].sort((a, b) =>
          naturalLocCompare(a.localizacao, b.localizacao),
        ),
      );
    }
    return map;
  }, [items]);

  // Soma quantidade_pega de realocs já picadas por item (banner qty pega real).
  const qtyPegaPorItem = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of items) {
      let total = Number(it.quantidade_pega ?? 0);
      for (const r of it.realocacoes ?? []) {
        if (r.status === "picado" || r.status === "picado_parcial") {
          total += Number(r.quantidade_pega ?? 0);
        }
      }
      map.set(it.id, total);
    }
    return map;
  }, [items]);

  // Toggle expand
  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ─── Mutations ─────────────────────────────────────────────

  const biparMut = useMutation<
    BiparResult,
    Error & {
      status?: number;
      code?: string;
      teto?: number | null;
      tentado?: number | null;
    },
    string
  >(
    {
      mutationFn: async (sku: string) => {
        const endpoint =
          modo === "embalagem-oc"
            ? "/api/wms/separacao/bipar-embalagem-oc"
            : "/api/wms/separacao/bipar-embalagem";
        const body =
          modo === "embalagem-oc"
            ? { sku, pedido_ids: pedidoIds, quantidade: scanQty }
            : {
                sku,
                galpao_id: activeGalpaoId ?? undefined,
                quantidade: scanQty,
              };
        const r = await sisoFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const err = (await r.json().catch(() => ({}))) as {
            error?: string;
            message?: string;
            teto?: number;
            tentado?: number;
          };
          const error = new Error(
            err.message || err.error || `HTTP ${r.status}`,
          ) as Error & {
            status?: number;
            code?: string;
            teto?: number | null;
            tentado?: number | null;
          };
          error.status = r.status;
          error.code = err.error;
          error.teto = err.teto ?? null;
          error.tentado = err.tentado ?? null;
          throw error;
        }
        return (await r.json()) as BiparResult;
      },
      onSuccess: (data) => {
        if (data.pedido_completo) {
          completedIdsRef.current.add(data.pedido_id);
          const etiq = data.etiqueta_status;
          if (etiq === "falhou") {
            setScanFeedback({
              text: `Pedido embalado · etiqueta FALHOU${
                data.etiqueta_erro ? ` (${data.etiqueta_erro})` : ""
              }`,
              tone: "warn",
            });
            toast.error(
              `Falha na etiqueta${
                data.etiqueta_erro ? `: ${data.etiqueta_erro}` : ""
              }. Use reimprimir.`,
            );
          } else if (etiq === "impresso") {
            setScanFeedback({
              text: `Pedido embalado · etiqueta impressa`,
              tone: "ok",
            });
            toast.success("Pedido embalado — etiqueta impressa");
          } else {
            setScanFeedback({
              text: `Pedido embalado`,
              tone: "ok",
            });
            toast.success("Pedido embalado");
          }
          // Expande automaticamente o pedido recém-concluído pra mostrar
          // o botão Reimprimir sem precisar clicar.
          setExpanded((prev) => new Set(prev).add(data.pedido_id));
        } else {
          setScanFeedback({
            text: `Bipado (${data.quantidade_bipada})`,
            tone: "neutral",
          });
        }
        queryClient.invalidateQueries({ queryKey: pedidosQueryKey });
        queryClient.invalidateQueries({ queryKey: itemsQueryKey });
      },
      onError: (err) => {
        if (err.code === "bipou_alem_do_teto") {
          const teto = err.teto ?? "?";
          setScanFeedback({
            text: `Parcial — só ${teto} unidade(s) foram pegas. Use "Fechar como parcial".`,
            tone: "warn",
          });
          toast.error(
            `Parcial — só ${teto} unidade(s) foram pegas. Use "Fechar como parcial".`,
            { duration: 6000 },
          );
        } else if (err.status === 404) {
          setScanFeedback({
            text: `SKU não encontrado em pedidos pendentes`,
            tone: "error",
          });
        } else if (err.status === 409) {
          setScanFeedback({
            text: `SKU já bipado completo`,
            tone: "warn",
          });
        } else {
          setScanFeedback({
            text: err.message || "Erro ao bipar",
            tone: "error",
          });
        }
      },
    },
  );

  const confirmarMut = useMutation<
    ConfirmarResult,
    Error,
    { item: PedidoItem; delta: number }
  >({
    mutationFn: async ({ item, delta }) => {
      const clientRequestId = crypto.randomUUID();
      const r = await sisoFetch("/api/wms/separacao/confirmar-item-embalagem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_item_id: item.id,
          quantidade: delta,
          client_request_id: clientRequestId,
        }),
      });
      if (!r.ok) {
        const err = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      return (await r.json()) as ConfirmarResult;
    },
    onMutate: async ({ item, delta }) => {
      // Optimistic update — UI responde antes da rede.
      await queryClient.cancelQueries({ queryKey: itemsQueryKey });
      const prev = queryClient.getQueryData<{ items: PedidoItem[] }>(
        itemsQueryKey,
      );
      queryClient.setQueryData<{ items: PedidoItem[] }>(
        itemsQueryKey,
        (old) => {
          if (!old) return old;
          return {
            items: old.items.map((i) => {
              if (i.id !== item.id) return i;
              const newQty = Math.max(0, i.quantidade_bipada + delta);
              return {
                ...i,
                quantidade_bipada: newQty,
                bipado_completo: newQty >= i.quantidade,
              };
            }),
          };
        },
      );
      return { prev };
    },
    onError: (e, _v, ctx) => {
      // Reverte optimistic update se a API falhar.
      const prev = (ctx as { prev?: { items: PedidoItem[] } } | undefined)
        ?.prev;
      if (prev) queryClient.setQueryData(itemsQueryKey, prev);
      toast.error(e.message);
    },
    onSuccess: (data, { item }) => {
      if (data.pedido_completo) {
        completedIdsRef.current.add(item.pedido_id);
        const etiq = data.etiqueta_status;
        if (etiq === "falhou") {
          toast.error(
            `Pedido embalado — falha na etiqueta${
              data.etiqueta_erro ? `: ${data.etiqueta_erro}` : ""
            }`,
          );
        } else if (etiq === "impresso") {
          toast.success("Pedido embalado — etiqueta impressa");
        } else {
          toast.success("Pedido embalado");
        }
        setExpanded((prev) => new Set(prev).add(item.pedido_id));
      }
      queryClient.invalidateQueries({ queryKey: pedidosQueryKey });
      queryClient.invalidateQueries({ queryKey: itemsQueryKey });
    },
  });

  // Fecha um item como parcial bipando exatamente a qty pega real.
  // Útil quando a UI mostra o banner "pega real = N" e o operador
  // quer fechar o item sem digitar.
  const fecharComoParcial = useCallback(
    (item: PedidoItem, qtyPegaTotal: number) => {
      const remaining = Math.max(0, qtyPegaTotal - (item.quantidade_bipada ?? 0));
      if (remaining <= 0) {
        toast.info("Item já bipado até o teto pega real.");
        return;
      }
      setScanQty(remaining);
      biparMut.mutate(item.sku);
    },
    [biparMut],
  );

  const reimprimirMut = useMutation<
    { status: string; error?: string },
    Error,
    string
  >({
    mutationFn: async (pedidoId) => {
      const r = await sisoFetch("/api/wms/separacao/reimprimir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_id: pedidoId }),
      });
      const json = (await r.json().catch(() => ({}))) as {
        status?: string;
        error?: string;
      };
      if (!r.ok || json.status === "falhou") {
        throw new Error(json.error || `HTTP ${r.status}`);
      }
      return { status: json.status ?? "impresso", error: json.error };
    },
    onSuccess: (data) =>
      toast.success(
        data.status === "impresso" ? "Etiqueta reenviada" : `OK (${data.status})`,
      ),
    onError: (e) => toast.error(`Falha ao reimprimir: ${e.message}`),
  });

  const reiniciarMut = useMutation<void, Error, void>({
    mutationFn: async () => {
      const activeIds = pedidoIds.filter(
        (id) => !completedIdsRef.current.has(id),
      );
      if (activeIds.length === 0) return;
      const r = await sisoFetch("/api/wms/separacao/reiniciar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_ids: activeIds,
          etapa: "embalagem",
        }),
      });
      if (!r.ok) {
        const err = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Progresso reiniciado");
      queryClient.invalidateQueries({ queryKey: pedidosQueryKey });
      queryClient.invalidateQueries({ queryKey: itemsQueryKey });
    },
    onError: (e) => toast.error(e.message),
  });

  // Limpa feedback após X segundos.
  useEffect(() => {
    if (!scanFeedback) return;
    const id = setTimeout(() => setScanFeedback(null), 4_000);
    return () => clearTimeout(id);
  }, [scanFeedback]);

  // TODO: redirecionar char prints globais pro input do HandheldScan.
  // Por ora confiamos no autoFocus + refoco no pending change do componente,
  // que é suficiente pra fluxo de pistola com cursor já posicionado.

  // ─── Render ─────────────────────────────────────────────

  if (pedidoIds.length === 0) {
    return (
      <>
        <PageHeader
          title="Embalagem"
          subtitle="Nenhum pedido selecionado"
          backHref="/wms/separacao"
        />
        <div className="wms-empty-block">
          <h3>Nenhum pedido</h3>
          <p>
            Esta tela precisa receber a lista de pedidos no parâmetro{" "}
            <code>?pedidos=…</code>.
          </p>
        </div>
      </>
    );
  }

  const activos = pedidosOrdenados.filter(
    (p) =>
      !completedIdsRef.current.has(p.id) && p.status_separacao !== "embalado",
  );
  const concluidos = pedidosOrdenados.filter(
    (p) =>
      completedIdsRef.current.has(p.id) || p.status_separacao === "embalado",
  );

  const subtitle = `${pedidoIds.length} pedido(s) · ${
    modo === "embalagem-oc" ? "Embalagem direta OC" : "Bipagem e conferência"
  }`;

  return (
    <>
      <PageHeader
        title="Embalagem"
        subtitle={subtitle}
        backHref={
          modo === "embalagem-oc"
            ? "/wms/separacao?tab=aguardando_compra"
            : "/wms/separacao"
        }
        backLabel="Voltar à separação"
      >
        <button
          type="button"
          className="wms-btn wms-btn-ghost"
          disabled={reiniciarMut.isPending || activos.length === 0}
          onClick={() => {
            if (
              window.confirm(
                "Reiniciar embalagem dos pedidos? Todas as bipagens serão zeradas.",
              )
            ) {
              reiniciarMut.mutate();
            }
          }}
        >
          <Icon name="rotate" size={12} />
          Reiniciar
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          onClick={() =>
            router.push(
              modo === "embalagem-oc"
                ? "/wms/separacao?tab=aguardando_compra"
                : "/wms/separacao",
            )
          }
        >
          <Icon name="check" size={12} />
          Salvar
        </button>
      </PageHeader>

      <HandheldScan
        label="Bipe SKU ou GTIN"
        placeholder="Bipe ou digite e Enter…"
        onSubmit={(code) => biparMut.mutate(code)}
        feedback={scanFeedback}
        pending={biparMut.isPending}
      />

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 12,
          marginTop: 4,
        }}
      >
        <label
          className="wms-td-mute"
          style={{ fontSize: 11.5 }}
          htmlFor="scan-qty"
        >
          Qty por bipe:
        </label>
        <input
          id="scan-qty"
          className="wms-input"
          type="number"
          min={1}
          value={scanQty}
          onChange={(e) =>
            setScanQty(Math.max(1, Number(e.target.value) || 1))
          }
          style={{ width: 80 }}
        />
        {biparMut.isPending && (
          <span className="wms-td-mute" style={{ fontSize: 11.5 }}>
            processando…
          </span>
        )}
      </div>

      {/* Loading / error states */}
      {pedidosQuery.isLoading && (
        <div className="wms-loading-pane">Carregando pedidos…</div>
      )}
      {pedidosQuery.isError && (
        <div className="wms-td-empty wms-td-danger">
          Erro ao carregar pedidos: {(pedidosQuery.error as Error).message}
        </div>
      )}

      {/* Pedidos ativos */}
      {activos.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {activos.map((p) => (
            <PedidoCardWms
              key={p.id}
              pedido={p}
              items={itemsByPedido.get(p.id) ?? []}
              itemsLoading={itemsQuery.isLoading}
              completed={false}
              expanded={expanded.has(p.id)}
              qtyPegaPorItem={qtyPegaPorItem}
              onToggle={() => toggleExpand(p.id)}
              onConfirm={(item, delta) =>
                confirmarMut.mutate({ item, delta })
              }
              onFecharComoParcial={fecharComoParcial}
              onReimprimir={() => reimprimirMut.mutate(p.id)}
              reimprimindo={
                reimprimirMut.isPending && reimprimirMut.variables === p.id
              }
            />
          ))}
        </div>
      )}

      {/* Pedidos concluídos nesta sessão */}
      {concluidos.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <h3 className="wms-sec-h">
            Embalados · {fmtNum(concluidos.length)}
          </h3>
          {concluidos.map((p) => (
            <PedidoCardWms
              key={p.id}
              pedido={p}
              items={itemsByPedido.get(p.id) ?? []}
              itemsLoading={itemsQuery.isLoading}
              completed
              expanded={expanded.has(p.id)}
              qtyPegaPorItem={qtyPegaPorItem}
              onToggle={() => toggleExpand(p.id)}
              onConfirm={(item, delta) =>
                confirmarMut.mutate({ item, delta })
              }
              onFecharComoParcial={fecharComoParcial}
              onReimprimir={() => reimprimirMut.mutate(p.id)}
              reimprimindo={
                reimprimirMut.isPending && reimprimirMut.variables === p.id
              }
            />
          ))}
        </div>
      )}

      {!pedidosQuery.isLoading &&
        activos.length === 0 &&
        concluidos.length === 0 && (
          <div className="wms-empty-block">
            <h3>Nada por aqui</h3>
            <p>
              Os pedidos solicitados podem já ter sido embalados ou não estão
              mais elegíveis pra embalagem.
            </p>
          </div>
        )}
    </>
  );
}

// ─── PedidoCard ─────────────────────────────────────────────

function PedidoCardWms({
  pedido,
  items,
  itemsLoading,
  completed,
  expanded,
  qtyPegaPorItem,
  onToggle,
  onConfirm,
  onFecharComoParcial,
  onReimprimir,
  reimprimindo,
}: {
  pedido: SeparacaoPedido;
  items: PedidoItem[];
  itemsLoading: boolean;
  completed: boolean;
  expanded: boolean;
  qtyPegaPorItem: Map<string, number>;
  onToggle: () => void;
  onConfirm: (item: PedidoItem, delta: number) => void;
  onFecharComoParcial: (item: PedidoItem, qtyPegaTotal: number) => void;
  onReimprimir: () => void;
  reimprimindo: boolean;
}) {
  const totalItens = pedido.total_itens || 0;
  const itensBipados = pedido.itens_bipados || 0;

  const galpaoChip = pedido.filial_origem
    ? `is-${pedido.filial_origem.toLowerCase()}`
    : "";

  return (
    <div className="wms-pcard" style={{ marginBottom: 10 }}>
      <div
        className="wms-pcard-h"
        onClick={onToggle}
        style={{ cursor: "pointer" }}
      >
        <div className="wms-pcard-h-left">
          <span className="wms-pcard-num">
            #{pedido.numero_pedido || pedido.numero_ec || pedido.id.slice(0, 6)}
          </span>
          <span className="wms-pcard-cliente" title={pedido.cliente ?? ""}>
            {pedido.cliente ?? "—"}
          </span>
          {pedido.filial_origem && (
            <span className={`wms-pcard-chip is-galpao ${galpaoChip}`}>
              {pedido.filial_origem}
            </span>
          )}
          <StatusBadge status={pedido.status_separacao} />
          {pedido.embalagem_concluida_em && (
            <span className="wms-td-mute" style={{ fontSize: 11 }}>
              {fmtRelative(pedido.embalagem_concluida_em)}
            </span>
          )}
        </div>
        <div className="wms-pcard-actions">
          <span
            className="wms-mono"
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: completed
                ? "var(--wms-c-ok)"
                : itensBipados > 0
                  ? "#b45309"
                  : "var(--wms-c-mute)",
            }}
          >
            {itensBipados}/{totalItens}
          </span>
          {completed && (
            <button
              type="button"
              className="wms-btn wms-btn-sm wms-btn-ghost"
              disabled={reimprimindo}
              onClick={(e) => {
                e.stopPropagation();
                onReimprimir();
              }}
            >
              <Icon name="download" size={11} />
              {reimprimindo ? "…" : "Reimprimir"}
            </button>
          )}
          <Icon name={expanded ? "chevron-d" : "chevron-r"} size={11} />
        </div>
      </div>

      {expanded && (
        <div
          style={{
            padding: "10px 0 2px",
            borderTop: "1px solid var(--wms-c-border)",
            marginTop: 10,
          }}
        >
          {itemsLoading && items.length === 0 ? (
            <div
              className="wms-td-mute"
              style={{ padding: "12px 0", fontSize: 12.5 }}
            >
              Carregando itens…
            </div>
          ) : items.length === 0 ? (
            <div
              className="wms-td-mute"
              style={{ padding: "12px 0", fontSize: 12.5 }}
            >
              Nenhum item neste pedido.
            </div>
          ) : (
            items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                readOnly={completed}
                qtyPegaTotal={qtyPegaPorItem.get(item.id) ?? 0}
                onConfirm={onConfirm}
                onFecharComoParcial={onFecharComoParcial}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── ItemRow ─────────────────────────────────────────────

function ItemRow({
  item,
  readOnly,
  qtyPegaTotal,
  onConfirm,
  onFecharComoParcial,
}: {
  item: PedidoItem;
  readOnly: boolean;
  qtyPegaTotal: number;
  onConfirm: (item: PedidoItem, delta: number) => void;
  onFecharComoParcial: (item: PedidoItem, qtyPegaTotal: number) => void;
}) {
  const isDone = item.bipado_completo;
  const showParcialBanner =
    !readOnly && item.separacao_parcial && qtyPegaTotal > 0 && qtyPegaTotal < item.quantidade;
  return (
    <>
      {showParcialBanner && (
        <div
          style={{
            background: "rgb(255 251 235)",
            borderLeft: "4px solid rgb(217 119 6)",
            padding: "8px 12px",
            fontSize: 12.5,
            color: "rgb(120 53 15)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 2,
          }}
        >
          <span>
            <strong>Parcial:</strong> pega real {qtyPegaTotal} de {item.quantidade}. Bipar apenas{" "}
            {qtyPegaTotal} unidade(s).
          </span>
          <button
            type="button"
            onClick={() => onFecharComoParcial(item, qtyPegaTotal)}
            style={{
              marginLeft: "auto",
              textDecoration: "underline",
              fontWeight: 600,
              color: "rgb(120 53 15)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            Fechar como parcial ({qtyPegaTotal}/{item.quantidade})
          </button>
        </div>
      )}
      <div className={`wms-hand-item ${isDone ? "is-done" : ""}`}>
      <div className="wms-hand-item-check" aria-hidden="true">
        {isDone && <Icon name="check" size={11} />}
      </div>
      <div>
        {item.imagem_url ? (
          <FotoProdutoZoom
            src={item.imagem_url}
            sku={item.sku}
            descricao={item.descricao}
            className="wms-thumb wms-thumb-md"
          />
        ) : (
          <div
            className="wms-thumb wms-thumb-md"
            style={{
              background: "var(--wms-c-faint)",
              border: "1px solid var(--wms-c-border)",
            }}
          />
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          className="wms-mono"
          style={{
            fontWeight: 600,
            fontSize: 13,
            lineHeight: 1.2,
          }}
        >
          {item.sku}
        </div>
        <div
          className="wms-td-mute"
          style={{
            fontSize: 11,
            lineHeight: 1.3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={item.descricao}
        >
          {item.descricao}
        </div>
        <div style={{ fontSize: 11, marginTop: 2 }}>
          <span className="wms-td-mute">Loc:</span>{" "}
          <span className="wms-mono wms-hand-item-loc">
            {item.localizacao || "—"}
          </span>
        </div>
      </div>
      <div
        className="wms-mono wms-tar"
        style={{
          fontSize: 13.5,
          fontWeight: 600,
          color: isDone
            ? "var(--wms-c-ok)"
            : item.quantidade_bipada > 0
              ? "#b45309"
              : "var(--wms-c-mute)",
        }}
      >
        {item.quantidade_bipada}/{item.quantidade}
      </div>
      <div style={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
        <button
          type="button"
          className="wms-btn-icon"
          disabled={readOnly || item.quantidade_bipada <= 0}
          aria-label="Diminuir"
          onClick={() => onConfirm(item, -1)}
        >
          <Icon name="minus" size={11} />
        </button>
        <button
          type="button"
          className="wms-btn-icon"
          disabled={readOnly || item.quantidade_bipada >= item.quantidade}
          aria-label="Aumentar"
          onClick={() => onConfirm(item, 1)}
        >
          <Icon name="plus" size={11} />
        </button>
      </div>
    </div>
    </>
  );
}
