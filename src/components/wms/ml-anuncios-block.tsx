"use client";

/**
 * <MlAnunciosBlock sku="ABC123" />
 *
 * Bloco compacto que consulta /api/ml/anuncios?sku=X e lista anúncios do
 * SKU em todas as contas ML ativas. Mostra preço, status (ativo/pausado/
 * fechado), nickname da conta e link pro anúncio.
 *
 * Uso primário: recebimento (/wms/receber). Operador bipa o SKU e vê na
 * mesma tela se aquele produto tem anúncio em alguma conta — pra decidir
 * se vale a pena guardar/repassar/devolver.
 */

import { useCallback, useEffect, useState } from "react";
import { sisoFetch } from "@/lib/auth-context";
import { Icon } from "@/components/wms/ui/wms-ui";

interface Anuncio {
  conexao_id: string;
  conta_nickname: string;
  mlb_id: string;
  title: string;
  price: number | null;
  status: string | null;
  permalink: string | null;
  available_quantity: number | null;
  sold_quantity: number | null;
  thumbnail: string | null;
  listing_type_id: string | null;
}

interface ContaSummary {
  conexao_id: string;
  nickname: string;
  total: number;
  ativos: number;
  erro: string | null;
}

interface ApiResp {
  anuncios: Anuncio[];
  contas_consultadas: number;
  contas_com_erro: Array<{ conexao_id: string; nickname: string; erro: string }>;
  contas: ContaSummary[];
}

function statusLabel(status: string | null): {
  label: string;
  cls: string;
} {
  switch (status) {
    case "active":
      return { label: "Ativo", cls: "wms-badge-ok" };
    case "paused":
      return { label: "Pausado", cls: "wms-badge-warn" };
    case "closed":
      return { label: "Fechado", cls: "wms-badge-mute" };
    case "under_review":
      return { label: "Em revisão", cls: "wms-badge-warn" };
    case "inactive":
      return { label: "Inativo", cls: "wms-badge-mute" };
    default:
      return { label: status ?? "?", cls: "wms-badge-mute" };
  }
}

function fmtBrl(v: number | null): string {
  if (v == null || isNaN(v)) return "—";
  return v.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
  });
}

export function MlAnunciosBlock({
  sku,
  defaultOpen = false,
}: {
  sku: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (forceRefresh = false) => {
      if (!sku) return;
      if (forceRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const url = `/api/wms/ml/anuncios?sku=${encodeURIComponent(sku)}${
          forceRefresh ? "&refresh=1" : ""
        }`;
        const r = await sisoFetch(url);
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        const j = (await r.json()) as ApiResp;
        setData(j);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Erro");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [sku],
  );

  // Reset + auto-fetch ao trocar de SKU (mesmo colapsado, pro indicador colorido)
  useEffect(() => {
    setData(null);
    setError(null);
    if (sku) load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sku]);

  // Badge único pros estados sem dado/erro/loading/sem-contas; quando tem
  // dado, renderiza 1 chip por conta (ver loop abaixo).
  let statusBadge: { cls: string; text: string } | null = null;
  if (loading || refreshing) {
    statusBadge = { cls: "wms-badge-mute", text: "consultando…" };
  } else if (error) {
    statusBadge = { cls: "wms-badge-mute", text: "erro" };
  } else if (data && data.contas_consultadas === 0) {
    statusBadge = { cls: "wms-badge-mute", text: "sem contas" };
  }

  // Resumo por conta — verde se tem ativo, amarelo se só inativo, vermelho
  // se 0, cinza se erro
  function contaChip(c: ContaSummary): { cls: string; text: string } {
    if (c.erro) return { cls: "wms-badge-mute", text: `${c.nickname} (erro)` };
    if (c.ativos > 0)
      return { cls: "wms-badge-ok", text: `${c.nickname} (${c.ativos})` };
    if (c.total > 0)
      return {
        cls: "wms-badge-warn",
        text: `${c.nickname} (${c.total} inativo${c.total > 1 ? "s" : ""})`,
      };
    return { cls: "wms-badge-danger", text: `${c.nickname} (0)` };
  }

  return (
    <div
      style={{
        borderTop: "1px dashed var(--wms-c-border)",
        marginTop: 8,
        paddingTop: 6,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="wms-btn-link"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          padding: 0,
          background: "transparent",
          border: "none",
          cursor: "pointer",
        }}
        title="Conferir anúncios no Mercado Livre"
      >
        <Icon name={open ? "chevron-d" : "chevron-r"} size={10} />
        Anúncios ML
        {statusBadge && (
          <span
            className={`wms-badge ${statusBadge.cls}`}
            style={{ fontSize: 10 }}
          >
            {statusBadge.text}
          </span>
        )}
        {!statusBadge &&
          data?.contas.map((c) => {
            const chip = contaChip(c);
            return (
              <span
                key={c.conexao_id}
                className={`wms-badge ${chip.cls}`}
                style={{ fontSize: 10 }}
                title={c.erro ?? undefined}
              >
                {chip.text}
              </span>
            );
          })}
      </button>

      {open && (
        <div style={{ marginTop: 6 }}>
          {loading && (
            <span className="wms-td-mute" style={{ fontSize: 11 }}>
              Consultando contas ML…
            </span>
          )}
          {error && (
            <div
              className="wms-hint-card wms-hint-warn"
              style={{ fontSize: 11 }}
            >
              <Icon name="alert" />
              <span>{error}</span>
            </div>
          )}
          {data && !loading && data.anuncios.length === 0 && (
            <p
              className="wms-td-mute"
              style={{ fontSize: 11, margin: 0, fontStyle: "italic" }}
            >
              SKU não encontrado em nenhuma das {data.contas_consultadas} conta
              {data.contas_consultadas !== 1 ? "s" : ""} ML.
            </p>
          )}
          {data && data.anuncios.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {data.anuncios.map((a) => {
                const st = statusLabel(a.status);
                return (
                  <div
                    key={`${a.conexao_id}:${a.mlb_id}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 11,
                      padding: "4px 6px",
                      borderRadius: "var(--wms-r-2)",
                      background: "var(--wms-c-panel-2)",
                    }}
                  >
                    {a.thumbnail && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={a.thumbnail}
                        alt=""
                        width={28}
                        height={28}
                        style={{
                          objectFit: "cover",
                          borderRadius: 3,
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <span
                      className="wms-mono wms-td-mute"
                      style={{ fontSize: 10, flexShrink: 0 }}
                      title="Conta ML"
                    >
                      {a.conta_nickname}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={a.title}
                    >
                      {a.title}
                    </span>
                    <span
                      className="wms-mono"
                      style={{ fontWeight: 600, fontSize: 11.5 }}
                    >
                      {fmtBrl(a.price)}
                    </span>
                    <span className={`wms-badge ${st.cls}`}>{st.label}</span>
                    {a.permalink && (
                      <a
                        href={a.permalink}
                        target="_blank"
                        rel="noreferrer"
                        className="wms-btn-icon"
                        title="Abrir anúncio"
                      >
                        <Icon name="arrow-right" size={10} />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {data && data.contas_com_erro.length > 0 && (
            <p
              className="wms-td-mute"
              style={{ fontSize: 10.5, marginTop: 4, marginBottom: 0 }}
            >
              {data.contas_com_erro.length} conta
              {data.contas_com_erro.length > 1 ? "s" : ""} com erro:{" "}
              {data.contas_com_erro.map((c) => c.nickname).join(", ")}
            </p>
          )}

          <button
            type="button"
            className="wms-btn-link"
            onClick={() => load(true)}
            disabled={refreshing || loading}
            style={{
              fontSize: 10.5,
              padding: 0,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              marginTop: 4,
            }}
          >
            {refreshing ? "Atualizando…" : "Atualizar"}
          </button>
        </div>
      )}
    </div>
  );
}
