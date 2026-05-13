"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Icon,
  PageHeader,
  StatusBadge,
  fmtNum,
  fmtRelative,
} from "@/components/wms/ui/wms-ui";
import { useGalpoes } from "@/components/wms/ui/modals";
import type { PendenciaJoined } from "@/lib/wms/guarda";

type StatusFiltro = "ativas" | "todas" | "guardada" | "cancelada";

interface Grupo {
  key: string;
  lote_id: string | null;
  galpao_id: string;
  galpao_nome: string;
  empresa_nome: string;
  nf_referencia: string | null;
  origem_tipo: string;
  criada_em: string;
  pendencias: PendenciaJoined[];
  qty_pendente_total: number;
  n_skus: number;
}

export default function GuardaListaPage() {
  const router = useRouter();
  const { data: galpoes } = useGalpoes();
  const galpoesList = useMemo(() => galpoes ?? [], [galpoes]);

  const [galpaoId, setGalpaoId] = useState<string>("");
  const [statusFiltro, setStatusFiltro] = useState<StatusFiltro>("ativas");
  const [q, setQ] = useState("");

  const statusParam = useMemo(() => {
    switch (statusFiltro) {
      case "ativas":
        return "pendente,em_guarda";
      case "guardada":
        return "guardada";
      case "cancelada":
        return "cancelada";
      case "todas":
        return "pendente,em_guarda,guardada,cancelada";
    }
  }, [statusFiltro]);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["wms-guarda", galpaoId, statusParam, q],
    queryFn: () => {
      const sp = new URLSearchParams();
      if (galpaoId) sp.set("galpao_id", galpaoId);
      sp.set("status", statusParam);
      if (q.trim()) sp.set("q", q.trim());
      return wmsApi<{ rows: PendenciaJoined[] }>(
        `/api/wms/guarda?${sp.toString()}`,
      );
    },
    refetchInterval: 30 * 1000,
  });

  const rows = data?.rows ?? [];

  // Agrupa por lote_id. NULL vira "avulsas" (cada uma como grupo de 1).
  const { lotes, avulsas } = useMemo(() => {
    const lotesMap = new Map<string, PendenciaJoined[]>();
    const avulsasArr: PendenciaJoined[] = [];
    for (const r of rows) {
      if (r.lote_id) {
        const arr = lotesMap.get(r.lote_id) ?? [];
        arr.push(r);
        lotesMap.set(r.lote_id, arr);
      } else {
        avulsasArr.push(r);
      }
    }
    const lotes: Grupo[] = Array.from(lotesMap.entries()).map(([lote_id, pendencias]) => {
      const first = pendencias[0];
      const qty_pendente_total = pendencias.reduce(
        (sum, p) => sum + (p.status === "guardada" || p.status === "cancelada" ? 0 : p.qty_pendente),
        0,
      );
      return {
        key: lote_id,
        lote_id,
        galpao_id: first.galpao_id,
        galpao_nome: first.galpao?.nome ?? "—",
        empresa_nome: first.empresa?.nome ?? "—",
        nf_referencia: first.nf_referencia,
        origem_tipo: first.origem_tipo,
        criada_em: first.criada_em,
        pendencias: pendencias.sort((a, b) => {
          const ac = a.localizacao_destino?.codigo ?? "zzz";
          const bc = b.localizacao_destino?.codigo ?? "zzz";
          return ac.localeCompare(bc);
        }),
        qty_pendente_total,
        n_skus: pendencias.length,
      };
    });
    // Ordena lotes por criada_em desc (mais novos primeiro)
    lotes.sort((a, b) => b.criada_em.localeCompare(a.criada_em));
    return { lotes, avulsas: avulsasArr };
  }, [rows]);

  // Total ativas (pra "Guardar tudo")
  const totalAtivas = useMemo(() => {
    return rows.filter((r) => r.status === "pendente" || r.status === "em_guarda")
      .length;
  }, [rows]);

  // Pendências ativas avulsas (não ligadas a lote)
  const avulsasAtivas = useMemo(
    () => avulsas.filter((p) => p.status === "pendente" || p.status === "em_guarda"),
    [avulsas],
  );

  function abrirRotaTudo() {
    const sp = new URLSearchParams({ todas: "true" });
    if (galpaoId) sp.set("galpao", galpaoId);
    router.push(`/wms/guarda/rota?${sp.toString()}`);
  }

  function abrirRotaLote(lote_id: string) {
    router.push(`/wms/guarda/rota?lote=${lote_id}`);
  }

  function abrirRotaAvulsas() {
    const ids = avulsasAtivas.map((p) => p.id).join(",");
    router.push(`/wms/guarda/rota?ids=${ids}`);
  }

  return (
    <>
      <PageHeader
        title="Fila de guarda"
        subtitle="Recebimentos em lote agrupam numa rota única. Botão Guardar tudo bundla todas as pendências ativas pra uma caminhada só."
      />

      {/* Filtros */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <div className="wms-seg">
          {(["ativas", "guardada", "cancelada", "todas"] as StatusFiltro[]).map((s) => (
            <button
              key={s}
              type="button"
              className={`wms-seg-btn ${statusFiltro === s ? "is-active" : ""}`}
              onClick={() => setStatusFiltro(s)}
            >
              {s === "ativas"
                ? "Ativas"
                : s === "guardada"
                  ? "Guardadas"
                  : s === "cancelada"
                    ? "Canceladas"
                    : "Todas"}
            </button>
          ))}
        </div>

        <select
          className="wms-select"
          value={galpaoId}
          onChange={(e) => setGalpaoId(e.target.value)}
          style={{ maxWidth: 200 }}
        >
          <option value="">Todos galpões</option>
          {galpoesList.map((g) => (
            <option key={g.id} value={g.id}>
              {g.nome}
            </option>
          ))}
        </select>

        <input
          className="wms-input"
          placeholder="SKU ou descrição…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />

        <button
          type="button"
          className="wms-btn wms-btn-ghost"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <Icon name="rotate" size={11} />
          {isFetching ? "Atualizando…" : "Atualizar"}
        </button>
      </div>

      {/* Guardar tudo */}
      {statusFiltro === "ativas" && totalAtivas > 0 && (
        <div
          style={{
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-3)",
            padding: 16,
            marginBottom: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              <Icon name="box" size={13} /> Guardar tudo
            </div>
            <div className="wms-td-mute" style={{ fontSize: 12 }}>
              {totalAtivas} pendência{totalAtivas > 1 ? "s" : ""} ativa
              {totalAtivas > 1 ? "s" : ""} em {lotes.length} lote
              {lotes.length !== 1 ? "s" : ""}
              {avulsasAtivas.length > 0 && (
                <>
                  {" "}
                  + {avulsasAtivas.length} avulsa
                  {avulsasAtivas.length > 1 ? "s" : ""}
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            onClick={abrirRotaTudo}
            style={{ padding: "10px 18px", fontSize: 14 }}
          >
            <Icon name="arrow-right" size={12} /> Iniciar rota com tudo
          </button>
        </div>
      )}

      {isLoading && (
        <div className="wms-loading-pane">Carregando pendências…</div>
      )}
      {isError && (
        <div className="wms-empty-block">
          <h3>Erro</h3>
          <p>{(error as Error).message}</p>
        </div>
      )}
      {!isLoading && !isError && rows.length === 0 && (
        <div className="wms-empty-block">
          <h3>Fila vazia</h3>
          <p>
            Nenhuma pendência de guarda com esses filtros. Quando o recebimento
            confirmar um lote, as linhas aparecem aqui agrupadas.
          </p>
        </div>
      )}

      {/* Lotes */}
      {!isLoading && lotes.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14,
            marginBottom: 14,
          }}
        >
          {lotes.map((g) => (
            <LoteCard key={g.key} grupo={g} onIniciar={abrirRotaLote} />
          ))}
        </div>
      )}

      {/* Avulsas */}
      {!isLoading && avulsasAtivas.length > 0 && statusFiltro === "ativas" && (
        <div
          style={{
            background: "var(--wms-c-panel)",
            border: "1px dashed var(--wms-c-border)",
            borderRadius: "var(--wms-r-3)",
            padding: 14,
            marginBottom: 14,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                <Icon name="box" size={12} /> Pendências avulsas
              </div>
              <div className="wms-td-mute" style={{ fontSize: 11 }}>
                Recebimentos individuais ou pendências antigas sem lote
              </div>
            </div>
            <button
              type="button"
              className="wms-btn wms-btn-primary wms-btn-sm"
              onClick={abrirRotaAvulsas}
              style={{ fontSize: 12 }}
            >
              <Icon name="arrow-right" size={11} /> Guardar avulsas (
              {avulsasAtivas.length})
            </button>
          </div>
          <div className="wms-tbl">
            <table>
              <tbody>
                {avulsasAtivas.map((p) => (
                  <PendenciaRow key={p.id} p={p} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Avulsas em outros filtros (guardadas/canceladas/todas) — flat */}
      {!isLoading && statusFiltro !== "ativas" && avulsas.length > 0 && (
        <div className="wms-tbl">
          <table>
            <tbody>
              {avulsas.map((p) => (
                <PendenciaRow key={p.id} p={p} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function LoteCard({
  grupo,
  onIniciar,
}: {
  grupo: Grupo;
  onIniciar: (lote_id: string) => void;
}) {
  const ativas = grupo.pendencias.filter(
    (p) => p.status === "pendente" || p.status === "em_guarda",
  );
  const terminadas = grupo.pendencias.length - ativas.length;
  const algumaEmGuarda = grupo.pendencias.some((p) => p.status === "em_guarda");

  return (
    <div
      style={{
        background: "var(--wms-c-panel)",
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
        padding: 14,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            <Icon name="box" size={12} /> Lote{" "}
            {grupo.nf_referencia ? (
              <>
                NF <span className="wms-mono">{grupo.nf_referencia}</span>
              </>
            ) : (
              <span className="wms-mono" style={{ fontSize: 12 }}>
                {grupo.lote_id?.slice(0, 8) ?? "—"}
              </span>
            )}
          </div>
          <div className="wms-td-mute" style={{ fontSize: 11, marginTop: 2 }}>
            <span className="wms-mono">{grupo.empresa_nome}</span> · {grupo.galpao_nome}{" "}
            · {grupo.origem_tipo} · recebido {fmtRelative(grupo.criada_em)}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ textAlign: "right" }}>
            <div className="wms-mono" style={{ fontSize: 16, fontWeight: 700 }}>
              {fmtNum(grupo.qty_pendente_total)}
            </div>
            <div className="wms-td-mute" style={{ fontSize: 10.5 }}>
              un a guardar
            </div>
          </div>
          {ativas.length > 0 ? (
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              onClick={() => onIniciar(grupo.lote_id!)}
              style={{ padding: "10px 14px", fontSize: 13 }}
            >
              <Icon name="arrow-right" size={12} />{" "}
              {algumaEmGuarda ? "Continuar rota" : "Iniciar rota"}
            </button>
          ) : (
            <StatusBadge status="guardada" />
          )}
        </div>
      </div>

      <div className="wms-tbl" style={{ marginTop: 6 }}>
        <table>
          <tbody>
            {grupo.pendencias.slice(0, 4).map((p) => (
              <PendenciaRow key={p.id} p={p} compact />
            ))}
            {grupo.pendencias.length > 4 && (
              <tr>
                <td colSpan={5}>
                  <Link
                    href={`/wms/guarda/rota?lote=${grupo.lote_id}`}
                    className="wms-btn-link"
                    style={{ fontSize: 11.5 }}
                  >
                    + {grupo.pendencias.length - 4} mais…
                  </Link>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div
        className="wms-td-mute"
        style={{ fontSize: 11, marginTop: 8, textAlign: "right" }}
      >
        {ativas.length} ativas
        {terminadas > 0 && <> · {terminadas} concluídas</>}
      </div>
    </div>
  );
}

function PendenciaRow({
  p,
  compact = false,
}: {
  p: PendenciaJoined;
  compact?: boolean;
}) {
  return (
    <tr>
      <td style={{ width: compact ? 36 : 46 }}>
        {p.produto?.imagem_url && (
          <img
            src={p.produto.imagem_url}
            alt=""
            loading="lazy"
            className="wms-thumb wms-thumb-xs"
          />
        )}
      </td>
      <td>
        <div className="wms-mono" style={{ fontWeight: 600, fontSize: 12 }}>
          {p.produto?.sku ?? "—"}
        </div>
        <div
          className="wms-td-mute"
          style={{
            fontSize: 11,
            maxWidth: 320,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {p.produto?.descricao ?? ""}
        </div>
      </td>
      <td className="wms-mono wms-td-mute" style={{ fontSize: 11 }}>
        {p.localizacao_destino?.codigo ?? "—"}
      </td>
      <td className="wms-mono wms-tar" style={{ fontSize: 12 }}>
        {fmtNum(p.qty_pendente)}
      </td>
      <td>
        <StatusBadge status={p.status} />
      </td>
      <td className="wms-td-actions">
        <Link
          href={`/wms/guarda/${p.id}`}
          className="wms-btn-icon"
          title="Tablet individual"
        >
          <Icon name="chevron-r" size={11} />
        </Link>
      </td>
    </tr>
  );
}
