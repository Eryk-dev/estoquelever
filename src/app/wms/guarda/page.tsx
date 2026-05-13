"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
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

export default function GuardaListaPage() {
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
  const totaisPorStatus = useMemo(() => {
    const t: Record<string, number> = {
      pendente: 0,
      em_guarda: 0,
      guardada: 0,
      cancelada: 0,
    };
    for (const r of rows) t[r.status] = (t[r.status] ?? 0) + 1;
    return t;
  }, [rows]);

  return (
    <>
      <PageHeader
        title="Fila de guarda"
        subtitle="Pendências de put-away — operador imprime etiqueta, bipa loc destino e confirma no tablet."
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
          {(["ativas", "guardada", "cancelada", "todas"] as StatusFiltro[]).map(
            (s) => (
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
            ),
          )}
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

      {statusFiltro === "ativas" && (
        <div
          className="wms-td-mute"
          style={{ marginBottom: 10, fontSize: 12 }}
        >
          <Icon name="box" size={11} /> {totaisPorStatus.pendente ?? 0} pendentes
          · {totaisPorStatus.em_guarda ?? 0} em guarda
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
            confirmar um lote, as linhas aparecem aqui.
          </p>
        </div>
      )}

      {!isLoading && rows.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th>Produto</th>
                <th>Empresa</th>
                <th>Galpão</th>
                <th>Origem</th>
                <th className="wms-tar">Qty</th>
                <th>Status</th>
                <th>Recebido</th>
                <th style={{ width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="wms-tr-clickable">
                  <td>
                    <Link
                      href={`/wms/guarda/${p.id}`}
                      className="wms-link-row"
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        {p.produto?.imagem_url && (
                          <img
                            src={p.produto.imagem_url}
                            alt=""
                            loading="lazy"
                            className="wms-thumb wms-thumb-xs"
                          />
                        )}
                        <div>
                          <div className="wms-mono" style={{ fontWeight: 600 }}>
                            {p.produto?.sku ?? "—"}
                          </div>
                          <div
                            className="wms-td-mute"
                            style={{
                              fontSize: 11.5,
                              maxWidth: 380,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {p.produto?.descricao ?? ""}
                          </div>
                        </div>
                      </div>
                    </Link>
                  </td>
                  <td className="wms-td-mute">{p.empresa?.nome ?? "—"}</td>
                  <td className="wms-td-mute">{p.galpao?.nome ?? "—"}</td>
                  <td className="wms-td-mute" style={{ fontSize: 11.5 }}>
                    {p.nf_referencia ? (
                      <>
                        NF{" "}
                        <span className="wms-mono">{p.nf_referencia}</span>
                      </>
                    ) : (
                      <span style={{ opacity: 0.6 }}>{p.origem_tipo}</span>
                    )}
                  </td>
                  <td className="wms-tar wms-mono">
                    {fmtNum(p.qty_pendente)}
                    {p.qty_guardada > 0 && p.status !== "guardada" && (
                      <div
                        className="wms-td-mute"
                        style={{ fontSize: 10.5 }}
                      >
                        de {fmtNum(p.qty_inicial)}
                      </div>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="wms-td-mute" style={{ fontSize: 11.5 }}>
                    {fmtRelative(p.criada_em)}
                  </td>
                  <td className="wms-td-actions">
                    <Link
                      href={`/wms/guarda/${p.id}`}
                      className="wms-btn-icon"
                      title="Abrir tablet"
                    >
                      <Icon name="chevron-r" size={11} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
