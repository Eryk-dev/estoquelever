"use client";

/**
 * <MlAnunciosBlock sku="ABC123" />
 *
 * Bloco compacto que consulta /api/ml/anuncios?sku=X e lista anúncios do
 * SKU em todas as contas ML ativas. Mostra preço, status (ativo/pausado/
 * fechado), nickname da conta e link pro anúncio.
 *
 * Colapsado por default; o fetch só roda quando o usuário expande (cache
 * por SKU via React Query). Colapsado com dado em cache mostra um único
 * chip-resumo neutro ("ML: 6 ativos · 1/4 contas").
 *
 * Uso primário: recebimento (/wms/receber). Operador bipa o SKU e vê na
 * mesma tela se aquele produto tem anúncio em alguma conta — pra decidir
 * se vale a pena guardar/repassar/devolver.
 */

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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

// Detalhe por conta — danger só pra erro real de fetch da conta;
// sem anúncio = neutro mute.
function contaChip(c: ContaSummary): { cls: string; text: string } {
  if (c.erro) return { cls: "wms-badge-danger", text: `${c.nickname} (erro)` };
  if (c.ativos > 0)
    return { cls: "wms-badge-ok", text: `${c.nickname} (${c.ativos})` };
  if (c.total > 0)
    return {
      cls: "wms-badge-warn",
      text: `${c.nickname} (${c.total} inativo${c.total > 1 ? "s" : ""})`,
    };
  return { cls: "wms-badge-mute", text: `${c.nickname} (0)` };
}

export function MlAnunciosBlock({
  sku,
  defaultOpen = false,
}: {
  sku: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const forceRefreshRef = useRef(false);

  const query = useQuery<ApiResp>({
    queryKey: ["ml-anuncios", sku],
    enabled: open && !!sku,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      const force = forceRefreshRef.current;
      forceRefreshRef.current = false;
      const url = `/api/wms/ml/anuncios?sku=${encodeURIComponent(sku)}${
        force ? "&refresh=1" : ""
      }`;
      const r = await sisoFetch(url);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      return (await r.json()) as ApiResp;
    },
  });

  const data = query.data ?? null;
  const fetching = query.isFetching;
  const errorMsg = query.isError
    ? query.error instanceof Error
      ? query.error.message
      : "Erro"
    : null;

  // Chip-resumo único e neutro no header — nunca danger pra ausência.
  let headerChip: { cls: string; text: string } | null = null;
  if (fetching) {
    headerChip = { cls: "wms-badge-mute", text: "consultando…" };
  } else if (errorMsg) {
    headerChip = { cls: "wms-badge-mute", text: "erro" };
  } else if (data) {
    if (data.contas_consultadas === 0) {
      headerChip = { cls: "wms-badge-mute", text: "sem contas" };
    } else {
      const ativos = data.contas.reduce((s, c) => s + c.ativos, 0);
      const comAnuncio = data.contas.filter((c) => c.total > 0).length;
      headerChip = {
        cls: ativos > 0 ? "wms-badge-ok" : "wms-badge-mute",
        text: `${ativos} ativo${ativos !== 1 ? "s" : ""} · ${comAnuncio}/${data.contas.length} contas`,
      };
    }
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
        {headerChip && (
          <span
            className={`wms-badge ${headerChip.cls}`}
            style={{ fontSize: 10 }}
          >
            {headerChip.text}
          </span>
        )}
      </button>

      {open && (
        <div style={{ marginTop: 6 }}>
          {fetching && !data && (
            <span className="wms-td-mute" style={{ fontSize: 11 }}>
              Consultando contas ML…
            </span>
          )}
          {errorMsg && !fetching && (
            <div
              className="wms-hint-card wms-hint-danger"
              style={{ fontSize: 11 }}
            >
              <Icon name="alert" />
              <span>{errorMsg}</span>
              <button
                type="button"
                className="wms-btn-link"
                onClick={() => query.refetch()}
                style={{
                  fontSize: 10.5,
                  padding: 0,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                Tentar de novo
              </button>
            </div>
          )}
          {data && data.contas.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                marginBottom: 6,
              }}
            >
              {data.contas.map((c) => {
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
            </div>
          )}
          {data && data.anuncios.length === 0 && (
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

          {data && (
            <button
              type="button"
              className="wms-btn-link"
              onClick={() => {
                forceRefreshRef.current = true;
                query.refetch();
              }}
              disabled={fetching}
              style={{
                fontSize: 10.5,
                padding: 0,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                marginTop: 4,
              }}
            >
              {fetching ? "Atualizando…" : "Atualizar"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
