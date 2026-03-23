"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ClipboardCheck, Loader2, Package } from "lucide-react";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { sisoFetch, useAuth } from "@/lib/auth-context";

import type { ConferenciaItem } from "@/types";

interface OcInfo {
  id: string;
  fornecedor: string;
  empresa_id: string;
  status: string;
  observacao: string | null;
  comprado_por_nome: string | null;
  comprado_em: string | null;
  created_at: string;
}

interface ConferenciaResponse {
  ordem_compra: OcInfo;
  itens: ConferenciaItem[];
}

interface ConferirResult {
  processados: number;
  erros: number;
  erros_detalhe: string[];
  itens_sem_produto_id: number;
  pedidos_liberados: string[];
}

interface PrepararEmbalagemResult {
  pedido_ids: string[];
  preparados: string[];
  ja_separados: string[];
  ignorados: Array<{
    pedido_id: string;
    status_atual: string | null;
    motivo: string;
  }>;
  total_relacionados: number;
  galpao_id: string | null;
}

const ALLOWED_CARGOS = ["admin", "comprador"];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

async function fetchConferencia(
  ordemCompraId: string,
): Promise<ConferenciaResponse> {
  const res = await sisoFetch(
    `/api/compras/conferencia/${ordemCompraId}`,
  );
  if (res.status === 404)
    throw new Error("Ordem de compra não encontrada");
  if (res.status === 401) throw new Error("Sessão expirada");
  if (res.status === 403) throw new Error("Acesso negado");
  if (!res.ok) throw new Error("Erro ao carregar conferência");
  return res.json();
}

export default function ConferenciaPage() {
  const { ordemCompraId } = useParams<{ ordemCompraId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { user, setActiveGalpao } = useAuth();

  const cargos = user?.cargos ?? (user?.cargo ? [user.cargo] : []);
  const cargo = cargos.find((c) => ALLOWED_CARGOS.includes(c)) ?? "";
  const allowed = cargo !== "";

  const storageKey = `conferencia_qtd_${ordemCompraId}`;
  const [quantities, setQuantities] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const stored = sessionStorage.getItem(storageKey);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });
  const [submitting, setSubmitting] = useState(false);
  const [showEmbalarConfirm, setShowEmbalarConfirm] = useState(false);

  const persistQuantities = useCallback((qty: Record<string, number>) => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(qty));
    } catch { /* quota exceeded — ignore */ }
  }, [storageKey]);

  // Clear sessionStorage after successful submit
  useEffect(() => {
    return () => {
      // Don't clear on unmount — we want persistence across navigations
    };
  }, []);

  const batchOcIds = useMemo(() => {
    const param = searchParams.get("ocs");
    const ids = param ? param.split(",").filter(Boolean) : [];
    if (!ids.includes(ordemCompraId)) {
      ids.unshift(ordemCompraId);
    }
    return [...new Set(ids)];
  }, [ordemCompraId, searchParams]);

  const currentBatchIndex = useMemo(
    () => batchOcIds.indexOf(ordemCompraId),
    [batchOcIds, ordemCompraId],
  );

  const nextOcId =
    currentBatchIndex >= 0 ? batchOcIds[currentBatchIndex + 1] ?? null : null;
  const hasBatchFlow = searchParams.has("ocs");

  const { data, isLoading, error } = useQuery({
    queryKey: ["conferencia", ordemCompraId],
    queryFn: () => fetchConferencia(ordemCompraId),
    enabled: !!user && allowed && !!ordemCompraId,
    // No refetchInterval — avoid losing typed values
  });

  const oc = data?.ordem_compra;
  const itens = data?.itens ?? [];

  // Initialize quantities from API data (only for items not yet set by user)
  const getQuantity = (item: ConferenciaItem): number => {
    if (quantities[item.item_id] !== undefined) return quantities[item.item_id];
    return item.quantidade_restante;
  };

  const setQuantity = (itemId: string, value: number) => {
    setQuantities((prev) => {
      const next = { ...prev, [itemId]: value };
      persistQuantities(next);
      return next;
    });
  };

  const allZero = itens.every((item) => getQuantity(item) === 0);

  const handleConfirm = async () => {
    if (!oc || !user) return;
    setSubmitting(true);

    try {
      const itensPayload = itens
        .map((item) => ({
          item_id: item.item_id,
          quantidade_recebida: getQuantity(item),
        }))
        .filter((i) => i.quantidade_recebida > 0);

      const res = await sisoFetch("/api/compras/conferir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ordem_compra_id: oc.id,
          itens: itensPayload,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error ?? "Erro ao processar conferência");
      }

      const result: ConferirResult = await res.json();

      // Show results
      if (result.erros > 0) {
        toast.error(
          `${result.processados} processado(s), ${result.erros} erro(s)`,
          {
            description: result.erros_detalhe.join("; "),
            duration: 8000,
          },
        );
      } else {
        let msg = `${result.processados} item(ns) recebido(s) com sucesso`;
        if (result.pedidos_liberados.length > 0) {
          msg += ` — ${result.pedidos_liberados.length} pedido(s) liberado(s)`;
        }
        toast.success(msg);
      }

      // Clear persisted quantities on success
      try { sessionStorage.removeItem(storageKey); } catch { /* ignore */ }

      // Invalidate caches
      queryClient.invalidateQueries({ queryKey: ["compras"] });
      queryClient.invalidateQueries({ queryKey: ["conferencia"] });
      queryClient.invalidateQueries({ queryKey: ["separacao"] });

      if (nextOcId) {
        toast.success(
          `OC ${Math.max(currentBatchIndex + 1, 1)} de ${batchOcIds.length} conferida. Abrindo a próxima.`,
        );
        router.push(`/compras/conferencia/${nextOcId}?ocs=${batchOcIds.join(",")}`);
        return;
      }

      if (hasBatchFlow) {
        // Show inline confirm instead of window.confirm
        setShowEmbalarConfirm(true);
        setSubmitting(false);
        return;
      }

      router.push("/compras");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Erro ao processar conferência",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell
      title="Conferência"
      subtitle={
        oc
          ? batchOcIds.length > 1
            ? `OC — ${oc.fornecedor} · ${Math.max(currentBatchIndex + 1, 1)}/${batchOcIds.length}`
            : `OC — ${oc.fornecedor}`
          : "Carregando..."
      }
      backHref="/compras"
    >
      {!allowed ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16">
          <Package className="h-8 w-8 text-ink-faint" />
          <p className="text-sm text-ink-faint">Acesso negado.</p>
        </div>
      ) : isLoading ? (
        <LoadingSpinner message="Carregando conferência..." />
      ) : error ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16">
          <Package className="h-8 w-8 text-ink-faint" />
          <p className="text-sm text-ink-faint">
            {error instanceof Error
              ? error.message
              : "Erro ao carregar conferência"}
          </p>
          <button
            type="button"
            onClick={() => router.push("/compras")}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </button>
        </div>
      ) : (
        <>
          {batchOcIds.length > 1 && (
            <div className="mb-4 rounded-xl border border-line bg-surface px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Rodada de conferência
              </p>
              <p className="mt-1 text-sm text-ink">
                Você está conferindo a OC {Math.max(currentBatchIndex + 1, 1)} de {batchOcIds.length}. Ao final da última, o SISO pergunta se deseja abrir a embalagem dos pedidos vinculados.
              </p>
            </div>
          )}

          {/* OC Header Info */}
          <div className="mb-5 rounded-xl border border-line bg-paper p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
              {oc?.comprado_por_nome && (
                <span>
                  Comprado por{" "}
                  <span className="font-medium text-ink">
                    {oc.comprado_por_nome}
                  </span>{" "}
                  em {formatDate(oc.comprado_em)}
                </span>
              )}
              {oc?.observacao && (
                <span className="italic">{oc.observacao}</span>
              )}
            </div>
            <p className="mt-3 text-xs text-ink-muted">
              Informe o que realmente chegou. Quantidades serão limitadas ao restante esperado de cada item.
            </p>
          </div>

          {/* Items */}
          {itens.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12">
              <ClipboardCheck className="h-8 w-8 text-emerald-400" />
              <p className="text-sm text-ink-muted">
                Todos os itens desta OC já foram recebidos.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-ink-faint">
                {itens.length} item(ns) pendente(s) de recebimento
              </p>

              <div className="rounded-xl border border-line bg-paper divide-y divide-line/50 overflow-hidden">
                {itens.map((item) => {
                  const qty = getQuantity(item);
                  return (
                    <div key={item.item_id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        {item.imagem && (
                          <img
                            src={item.imagem}
                            alt={item.sku}
                            className="h-10 w-10 shrink-0 rounded-md border border-line object-cover bg-surface"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-ink">
                            {item.sku}
                          </p>
                          <p className="text-xs text-ink-muted truncate">
                            {item.descricao}
                          </p>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {item.pedidos.map((p) => (
                              <span
                                key={p.pedido_id}
                                className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted"
                              >
                                #{p.numero_pedido} ({p.quantidade}un)
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-3 sm:gap-4">
                        <div className="text-xs text-ink-muted">
                          <span className="text-ink-faint">Restante esperado:</span>{" "}
                          <span className="font-semibold text-ink tabular-nums">
                            {item.quantidade_restante}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <label
                            htmlFor={`qty-${item.item_id}`}
                            className="text-xs text-ink-faint"
                          >
                            Recebido:
                          </label>
                          <input
                            id={`qty-${item.item_id}`}
                            type="number"
                            min={0}
                            max={item.quantidade_restante}
                            step={1}
                            value={qty}
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10);
                              setQuantity(
                                item.item_id,
                                Number.isNaN(val) ? 0 : val,
                              );
                            }}
                            className="w-20 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-semibold text-ink tabular-nums text-center focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink/20"
                          />
                        </div>
                        {item.quantidade_ja_recebida > 0 && (
                          <span className="text-[10px] text-blue-600">
                            Já recebido: {item.quantidade_ja_recebida}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Confirm button */}
              {!showEmbalarConfirm && (
                <div className="mt-2">
                  <button
                    type="button"
                    disabled={allZero || submitting}
                    onClick={handleConfirm}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 py-3 text-sm font-medium text-paper transition-colors hover:bg-ink/90 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Processando...
                      </>
                    ) : (
                      <>
                        <ClipboardCheck className="h-4 w-4" />
                        Confirmar Recebimento
                      </>
                    )}
                  </button>
                </div>
              )}

              {showEmbalarConfirm && (
                <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                  <p className="text-sm font-semibold text-emerald-800">
                    {batchOcIds.length > 1
                      ? "Deseja embalar os pedidos dessas OCs agora?"
                      : "Deseja embalar os pedidos desta OC agora?"}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={async () => {
                        setSubmitting(true);
                        try {
                          const prepRes = await sisoFetch("/api/compras/preparar-embalagem", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ ordem_compra_ids: batchOcIds }),
                          });
                          if (!prepRes.ok) {
                            const err = await prepRes.json().catch(() => null);
                            throw new Error(err?.error ?? "Erro ao preparar pedidos para embalagem");
                          }
                          const prepResult: PrepararEmbalagemResult = await prepRes.json();
                          if (prepResult.pedido_ids.length === 0) {
                            const skippedMsg =
                              prepResult.ignorados.length > 0
                                ? prepResult.ignorados[0]?.motivo ?? "Nenhum pedido pronto para embalagem"
                                : "Nenhum pedido dessas OCs ficou pronto para embalagem";
                            toast.success(skippedMsg);
                            router.push("/compras");
                            return;
                          }
                          if (prepResult.galpao_id) setActiveGalpao(prepResult.galpao_id);
                          const extras = prepResult.ignorados.length;
                          const msg = extras > 0
                            ? `${prepResult.pedido_ids.length} pedido(s) enviado(s) para embalagem — ${extras} ainda não ficaram prontos`
                            : `${prepResult.pedido_ids.length} pedido(s) enviado(s) para embalagem`;
                          toast.success(msg);
                          router.push(`/separacao/embalagem?pedidos=${prepResult.pedido_ids.join(",")}`);
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : "Erro ao preparar embalagem");
                        } finally {
                          setSubmitting(false);
                        }
                      }}
                      className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Package className="h-4 w-4" />}
                      Sim, embalar agora
                    </button>
                    <button
                      type="button"
                      onClick={() => router.push("/compras")}
                      className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-surface"
                    >
                      Voltar para compras
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
