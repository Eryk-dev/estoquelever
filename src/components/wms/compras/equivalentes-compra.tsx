"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { useHasCross } from "@/hooks/use-has-cross";
import { Icon, fmtNum } from "@/components/wms/ui/wms-ui";
import {
  TIER_LABEL,
  type TierQualidade,
  type ParVerificacao,
} from "@/lib/wms/trocas-equivalencia-regra";

interface SaldoGalpao {
  galpao_id: string;
  galpao_nome: string;
  disponivel: number;
}

// Item devolvido por GET /api/wms/compras/equivalentes.
interface Equivalente {
  produto_id: string;
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  tier_qualidade: TierQualidade | null;
  par_verificacao: ParVerificacao;
  saldo_por_galpao: SaldoGalpao[];
  total_disponivel: number;
}

/**
 * Painel de equivalentes do fluxo de COMPRAS (decisão Eryk 2026-06-14).
 *
 * Só aparece em SKUs que realmente têm equivalente (gating via has-cross).
 * Lista TODOS os equivalentes do cluster — com ou sem saldo — mostrando o saldo
 * por galpão de cada um (informativo). "Comprar este equivalente" troca o item
 * (e TODOS os pedidos do card) pra comprar o equivalente de outro fornecedor,
 * mesmo sem estoque — reusa o mecanismo compra_equivalente (set + confirmar),
 * imediato. A parte de troca por reserva (separação) é outra coisa, intocada.
 */
export function EquivalentesCompra({
  sku,
  itemIds,
  onAplicado,
}: {
  sku: string;
  /** Todos os pedido_item_id do card (mesma semântica de trocar-sku, P3-05). */
  itemIds: string[];
  onAplicado?: () => void;
}) {
  const has = useHasCross(sku);
  const [aberto, setAberto] = useState(false);
  const [aplicando, setAplicando] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["wms-compras-equivalentes", sku],
    queryFn: async () => {
      const r = await sisoFetch(
        `/api/wms/compras/equivalentes?sku=${encodeURIComponent(sku)}`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ sku: string; equivalentes: Equivalente[] }>;
    },
    enabled: aberto && !!sku,
  });

  // Gating: não há equivalente cadastrado → botão nem aparece.
  if (has !== true) return null;

  async function comprar(e: Equivalente) {
    if (itemIds.length === 0) {
      toast.error("Item sem pedido vinculado pra trocar");
      return;
    }
    setAplicando(e.sku);
    let ok = 0;
    let falhas = 0;
    let ultimoErro = "";
    for (const itemId of itemIds) {
      try {
        const setRes = await sisoFetch(
          `/api/wms/compras/itens/${itemId}/equivalente`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sku_equivalente: e.sku }),
          },
        );
        if (!setRes.ok) {
          falhas++;
          ultimoErro =
            ((await setRes.json().catch(() => ({}))) as { error?: string })
              .error ?? `HTTP ${setRes.status}`;
          continue;
        }
        const confRes = await sisoFetch(
          `/api/wms/compras/itens/${itemId}/equivalente/confirmar`,
          { method: "POST" },
        );
        if (!confRes.ok) {
          falhas++;
          ultimoErro =
            ((await confRes.json().catch(() => ({}))) as { error?: string })
              .error ?? `HTTP ${confRes.status}`;
          continue;
        }
        ok++;
      } catch {
        falhas++;
        ultimoErro = "erro de conexão";
      }
    }

    if (ok > 0 && falhas === 0) {
      toast.success(`Trocado por ${e.sku} — agora compre ${e.sku}`);
    } else if (ok > 0) {
      toast.warning(
        `${ok} trocado(s), ${falhas} falhou(aram)${ultimoErro ? `: ${ultimoErro}` : ""} (ver Exceções)`,
      );
    } else {
      toast.error(`Falha ao trocar${ultimoErro ? `: ${ultimoErro}` : ""}`);
    }
    setAplicando(null);
    if (ok > 0) onAplicado?.();
  }

  return (
    <div style={{ marginTop: 6 }}>
      <button
        type="button"
        className="wms-btn wms-btn-sm wms-btn-ghost"
        onClick={(ev) => {
          ev.stopPropagation();
          setAberto((v) => !v);
        }}
        title="Ver equivalentes e comprar de outro fornecedor (mesmo sem estoque)"
      >
        <Icon name={aberto ? "chevron-u" : "chevron-d"} size={10} />
        Equivalentes
      </button>

      {aberto && (
        <div
          style={{ padding: "6px 0 2px", display: "flex", flexDirection: "column", gap: 6 }}
          onClick={(ev) => ev.stopPropagation()}
        >
          {isLoading && (
            <div className="wms-td-mute" style={{ fontSize: 12 }}>
              Buscando equivalentes…
            </div>
          )}
          {isError && (
            <div className="wms-td-mute" style={{ fontSize: 12 }}>
              Erro ao buscar equivalentes.
            </div>
          )}
          {!isLoading && !isError && (data?.equivalentes ?? []).length === 0 && (
            <div className="wms-td-mute" style={{ fontSize: 12 }}>
              Nenhum equivalente no catálogo.
            </div>
          )}
          {(data?.equivalentes ?? []).map((e) => {
            const verificado = e.par_verificacao === "verificado";
            return (
              <div
                key={e.produto_id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 8px",
                  border: "1px solid var(--wms-c-border)",
                  borderRadius: "var(--wms-r-3)",
                  background: "var(--wms-c-faint)",
                }}
              >
                {e.imagem_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={e.imagem_url}
                    alt={e.sku}
                    className="wms-thumb wms-thumb-xs"
                    loading="lazy"
                  />
                ) : (
                  <div
                    className="wms-thumb wms-thumb-xs"
                    style={{
                      display: "grid",
                      placeItems: "center",
                      background: "var(--wms-c-panel-2)",
                    }}
                  >
                    <Icon name="box" size={12} className="wms-td-mute" />
                  </div>
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    <span className="wms-mono" style={{ fontWeight: 600, fontSize: 12.5 }}>
                      {e.sku}
                    </span>
                    <span
                      className={`wms-badge ${e.tier_qualidade ? "wms-badge-info" : "wms-badge-mute"}`}
                      style={{ fontSize: 10 }}
                    >
                      {e.tier_qualidade ? TIER_LABEL[e.tier_qualidade] : "Sem classificação"}
                    </span>
                    <span
                      className={`wms-badge ${verificado ? "wms-badge-ok" : "wms-badge-mute"}`}
                      style={{ fontSize: 10 }}
                      title={
                        verificado
                          ? "Par verificado por humano"
                          : "Par não verificado"
                      }
                    >
                      {verificado ? "✓ Verificado" : "Não verificado"}
                    </span>
                  </div>
                  {e.descricao && (
                    <div
                      className="wms-td-mute"
                      style={{
                        fontSize: 11,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {e.descricao}
                    </div>
                  )}
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                      marginTop: 3,
                      fontSize: 10.5,
                    }}
                  >
                    {e.saldo_por_galpao.length === 0 ? (
                      <span className="wms-td-mute">sem estoque em nenhum galpão</span>
                    ) : (
                      e.saldo_por_galpao.map((g) => (
                        <span
                          key={g.galpao_id}
                          className="wms-badge wms-badge-mute"
                          style={{ fontSize: 10 }}
                          title={`Disponível em ${g.galpao_nome}`}
                        >
                          {g.galpao_nome}: <b>{fmtNum(g.disponivel)}</b>
                        </span>
                      ))
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="wms-btn wms-btn-sm wms-btn-primary"
                  disabled={aplicando !== null}
                  onClick={() => comprar(e)}
                  style={{ whiteSpace: "nowrap" }}
                  title="Trocar o item por este equivalente e comprá-lo de outro fornecedor"
                >
                  {aplicando === e.sku ? "Trocando…" : "Comprar este"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
