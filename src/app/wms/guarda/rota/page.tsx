"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Icon,
  StatusBadge,
  fmtNum,
  fmtRelative,
} from "@/components/wms/ui/wms-ui";
import { useLocalizacoes } from "@/components/wms/ui/modals";
import { ScanContagem } from "@/components/wms/scan-contagem";
import type { PendenciaJoined } from "@/lib/wms/guarda";

interface RotaResponse {
  rows: PendenciaJoined[];
}

export default function GuardaRotaPage() {
  return (
    <Suspense fallback={<div className="wms-loading-pane">Carregando rota…</div>}>
      <GuardaRotaContent />
    </Suspense>
  );
}

function GuardaRotaContent() {
  const sp = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();

  const lote = sp.get("lote") ?? undefined;
  const ids = sp.get("ids") ?? undefined;
  const galpao = sp.get("galpao") ?? undefined;
  const todas = sp.get("todas") === "true";

  const queryString = useMemo(() => {
    const u = new URLSearchParams();
    if (lote) u.set("lote", lote);
    if (ids) u.set("ids", ids);
    if (galpao) u.set("galpao", galpao);
    if (todas) u.set("todas", "true");
    return u.toString();
  }, [lote, ids, galpao, todas]);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["wms-guarda-rota", queryString],
    queryFn: () => wmsApi<RotaResponse>(`/api/wms/guarda/rota?${queryString}`),
    enabled: !!queryString,
    refetchInterval: false,
  });

  const fila = useMemo(() => data?.rows ?? [], [data]);
  // Pendência ativa = primeira não-zerada (qty_pendente > 0)
  const ativaIdx = fila.findIndex((p) => p.qty_pendente > 0);
  const ativa = ativaIdx >= 0 ? fila[ativaIdx] : null;
  const restantes = fila.filter((p) => p.qty_pendente > 0).length;
  const concluidas = fila.length - restantes;

  // Quando uma pendência é zerada, refetch pra avançar pra próxima
  function onPendenciaResolvida() {
    qc.invalidateQueries({ queryKey: ["wms-guarda-rota", queryString] });
    qc.invalidateQueries({ queryKey: ["wms-guarda"] });
    qc.invalidateQueries({ queryKey: ["wms-estoque"] });
    qc.invalidateQueries({ queryKey: ["wms-ledger"] });
    qc.invalidateQueries({ queryKey: ["wms-cobertura"] });
    qc.invalidateQueries({ queryKey: ["wms-dashboard-geral"] });
    refetch();
  }

  if (isLoading) {
    return <div className="wms-loading-pane">Carregando rota…</div>;
  }
  if (isError) {
    return (
      <div className="wms-empty-block">
        <h3>Erro</h3>
        <p>{(error as Error).message}</p>
        <Link href="/wms/guarda" className="wms-btn wms-btn-ghost">
          Voltar
        </Link>
      </div>
    );
  }
  if (fila.length === 0) {
    return (
      <div className="wms-empty-block">
        <h3>Rota vazia</h3>
        <p>Nenhuma pendência ativa nessa rota.</p>
        <Link href="/wms/guarda" className="wms-btn wms-btn-primary">
          Voltar pra fila
        </Link>
      </div>
    );
  }

  if (!ativa) {
    return (
      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        <div className="wms-empty-block" style={{ textAlign: "center" }}>
          <Icon name="check" size={20} />
          <h3 style={{ marginTop: 8 }}>Rota concluída</h3>
          <p>
            Todas as {fila.length} pendência{fila.length > 1 ? "s foram" : " foi"}{" "}
            guardada{fila.length > 1 ? "s" : ""}.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16 }}>
            <Link href="/wms/guarda" className="wms-btn wms-btn-primary">
              Voltar pra fila
            </Link>
            <Link href="/wms/receber" className="wms-btn wms-btn-ghost">
              Receber mais
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const tituloRota = lote
    ? "Rota — lote único"
    : todas
      ? "Rota — guardar tudo"
      : ids
        ? "Rota — seleção"
        : "Rota";

  return (
    <div style={{ maxWidth: 880, margin: "0 auto" }}>
      {/* Header da rota */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
          gap: 8,
        }}
      >
        <div>
          <Link
            href="/wms/guarda"
            className="wms-btn wms-btn-ghost"
            style={{ fontSize: 12 }}
          >
            <Icon name="chevron-l" size={11} /> Fila
          </Link>
        </div>
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{tituloRota}</div>
          <div className="wms-td-mute" style={{ fontSize: 11 }}>
            {concluidas + 1} de {fila.length} · {restantes - 1} restantes
          </div>
        </div>
        <div style={{ width: 60 }} />
      </div>

      {/* Pendência ativa — UI igual à de tablet single */}
      <PendenciaTablet pendencia={ativa} onResolvida={onPendenciaResolvida} />

      {/* Próximas (preview) */}
      {restantes > 1 && (
        <div
          style={{
            marginTop: 16,
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-3)",
            padding: 12,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8 }}>
            <Icon name="list" size={11} /> Próximas na rota ({restantes - 1})
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {fila
              .filter((p) => p.qty_pendente > 0)
              .slice(1, 6)
              .map((p) => (
                <li
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "4px 0",
                    fontSize: 12,
                  }}
                >
                  <span
                    className="wms-mono"
                    style={{
                      fontWeight: 600,
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {p.localizacao_destino?.codigo ?? "— sem loc"} ·{" "}
                    {p.produto?.sku ?? ""}
                  </span>
                  <span className="wms-mono wms-td-mute" style={{ fontSize: 11 }}>
                    {fmtNum(p.qty_pendente)} un
                  </span>
                </li>
              ))}
            {restantes - 1 > 5 && (
              <li
                className="wms-td-mute"
                style={{ fontSize: 11, textAlign: "center", marginTop: 4 }}
              >
                + {restantes - 1 - 5} mais
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Tablet de uma pendência — extraído pra reuso. Igual à página
// /wms/guarda/[id] mas inline, com callback ao finalizar pra avançar
// pra próxima pendência da rota.

function PendenciaTablet({
  pendencia,
  onResolvida,
}: {
  pendencia: PendenciaJoined;
  onResolvida: () => void;
}) {
  const router = useRouter();
  const id = pendencia.id;
  const [qtyInput, setQtyInput] = useState(String(pendencia.qty_pendente));
  const [destinoOverride, setDestinoOverride] = useState<{
    id: string;
    codigo: string;
  } | null>(null);
  const [scanKey, setScanKey] = useState(0);

  // Sempre que a pendência muda (avançou na rota), reseta o estado local
  useEffect(() => {
    setQtyInput(String(pendencia.qty_pendente));
    setDestinoOverride(null);
    setScanKey((k) => k + 1);
  }, [pendencia.id, pendencia.qty_pendente]);

  const { data: locsResp } = useLocalizacoes(pendencia.galpao_id);
  const locsByCodigo = useMemo(() => {
    const m = new Map<string, { id: string; tipo: string }>();
    (locsResp?.rows ?? []).forEach((l) =>
      m.set(l.codigo.toUpperCase(), { id: l.id, tipo: l.tipo }),
    );
    return m;
  }, [locsResp]);

  // Loc destino: override do scan > destino decidido no recebimento > vazio
  const destinoEscolhido = destinoOverride ?? {
    id: pendencia.localizacao_destino_id ?? "",
    codigo: pendencia.localizacao_destino?.codigo ?? "",
  };
  const destinoVemDoRecebimento =
    !destinoOverride && !!pendencia.localizacao_destino_id;

  // Inicia idempotente ao abrir
  useEffect(() => {
    if (pendencia.status === "pendente") {
      sisoFetch(`/api/wms/guarda/${id}/iniciar`, { method: "POST" }).catch(() => {});
    }
  }, [id, pendencia.status]);

  const imprimir = useMutation({
    mutationFn: async () => {
      const qtyN = Number(qtyInput);
      const body: Record<string, unknown> = {};
      if (qtyN > 0) body.qty = qtyN;
      if (destinoEscolhido.codigo) body.localizacao_codigo = destinoEscolhido.codigo;
      const r = await sisoFetch(`/api/wms/guarda/${id}/imprimir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      return (await r.json()) as {
        ok: boolean;
        totalEtiquetas?: number;
        totalFolhas?: number;
        fallbackEnvelope?: boolean;
      };
    },
    onSuccess: (r) => {
      toast.success(
        `${r.totalEtiquetas} etiquetas em ${r.totalFolhas} folhas${r.fallbackEnvelope ? " (impressora de envio)" : ""}`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const confirmar = useMutation({
    mutationFn: async () => {
      if (!destinoEscolhido.id) throw new Error("escolha a loc destino");
      const qtyN = Number(qtyInput);
      if (!qtyN || qtyN <= 0) throw new Error("qty inválida");
      const r = await sisoFetch(`/api/wms/guarda/${id}/confirmar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qty: qtyN,
          localizacao_destino_id: destinoEscolhido.id,
        }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      return (await r.json()) as {
        ok: boolean;
        totalmente_guardada: boolean;
        pendencia: PendenciaJoined;
      };
    },
    onSuccess: (r) => {
      if (r.totalmente_guardada) {
        toast.success(`✓ ${pendencia.produto?.sku ?? "guarda"} — próxima…`);
      } else {
        toast.success(
          `Parcial: faltam ${fmtNum(r.pendencia.qty_pendente)} un dessa pendência`,
        );
      }
      onResolvida();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelar = useMutation({
    mutationFn: async () => {
      const motivo = window.prompt(
        "Motivo do cancelamento (≥3 chars):",
        "peça avariada",
      );
      if (!motivo) throw new Error("cancelamento abortado");
      const r = await sisoFetch(`/api/wms/guarda/${id}/cancelar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Pendência cancelada — próxima…");
      onResolvida();
    },
    onError: (e: Error) => {
      if (e.message !== "cancelamento abortado") toast.error(e.message);
    },
  });

  function handleScanLoc(value: string) {
    const codigo = value.trim().toUpperCase();
    if (!codigo) return;
    const found = locsByCodigo.get(codigo);
    if (!found) {
      toast.error(`Loc "${value}" não existe nesse galpão`);
      setScanKey((k) => k + 1);
      return;
    }
    if (found.id === pendencia.localizacao_origem_id) {
      toast.error("Loc destino não pode ser RECEBIMENTO");
      setScanKey((k) => k + 1);
      return;
    }
    setDestinoOverride({ id: found.id, codigo });
    setScanKey((k) => k + 1);
    toast.success(`Destino: ${codigo}`);
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <StatusBadge status={pendencia.status} size="lg" />
      </div>

      {/* Produto */}
      <div
        style={{
          background: "var(--wms-c-panel)",
          border: "1px solid var(--wms-c-border)",
          borderRadius: "var(--wms-r-3)",
          padding: 16,
          marginBottom: 14,
          display: "flex",
          gap: 14,
          alignItems: "center",
        }}
      >
        {pendencia.produto?.imagem_url && (
          <img
            src={pendencia.produto.imagem_url}
            alt=""
            className="wms-thumb wms-thumb-lg"
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="wms-mono"
            style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}
          >
            {pendencia.produto?.sku ?? "—"}
          </div>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            {pendencia.produto?.descricao ?? ""}
          </div>
          <div
            className="wms-td-mute"
            style={{ fontSize: 11.5, display: "flex", gap: 14, flexWrap: "wrap" }}
          >
            <span>
              <Icon name="box" size={10} /> {pendencia.empresa?.nome ?? "—"}
            </span>
            <span>
              <Icon name="pin" size={10} /> {pendencia.galpao?.nome ?? "—"}
            </span>
            {pendencia.nf_referencia && (
              <span>
                NF <span className="wms-mono">{pendencia.nf_referencia}</span>
              </span>
            )}
            <span>Recebida {fmtRelative(pendencia.criada_em)}</span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="wms-td-mute" style={{ fontSize: 11 }}>
            A guardar
          </div>
          <div
            className="wms-mono"
            style={{ fontSize: 32, fontWeight: 700, lineHeight: 1 }}
          >
            {fmtNum(pendencia.qty_pendente)}
          </div>
          {pendencia.qty_guardada > 0 && (
            <div className="wms-td-mute" style={{ fontSize: 11 }}>
              {fmtNum(pendencia.qty_guardada)} já guardadas
            </div>
          )}
        </div>
      </div>

      {/* Destino + scan */}
      <div
        style={{
          background: "var(--wms-c-panel)",
          border: "1px solid var(--wms-c-border)",
          borderRadius: "var(--wms-r-3)",
          padding: 16,
          marginBottom: 14,
        }}
      >
        <div
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 6,
            fontWeight: 600,
          }}
        >
          <Icon name="pin" size={11} /> Loc destino
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 10,
            flexWrap: "wrap",
          }}
        >
          <span
            className="wms-mono"
            style={{ fontSize: 28, fontWeight: 700 }}
          >
            {destinoEscolhido.codigo || "— sem destino"}
          </span>
          {destinoVemDoRecebimento && (
            <span className="wms-td-mute" style={{ fontSize: 11 }}>
              <Icon name="sparkle" size={10} /> decidido no recebimento
            </span>
          )}
          {destinoOverride && (
            <span className="wms-td-mute" style={{ fontSize: 11 }}>
              (trocada pelo operador)
            </span>
          )}
        </div>

        <ScanContagem
          key={`scan-loc-${scanKey}`}
          onScan={handleScanLoc}
          autoFocus
        />
        <div className="wms-td-mute" style={{ fontSize: 11, marginTop: 6 }}>
          Bipe o QR/código da prateleira pra trocar o destino.
        </div>
      </div>

      {/* Qty + ações */}
      <div
        style={{
          background: "var(--wms-c-panel)",
          border: "1px solid var(--wms-c-border)",
          borderRadius: "var(--wms-r-3)",
          padding: 16,
          marginBottom: 14,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <label
            style={{ fontSize: 12, fontWeight: 600 }}
            htmlFor="guarda-qty"
          >
            Qty a guardar
          </label>
          <input
            id="guarda-qty"
            className="wms-input wms-mono wms-tar"
            type="number"
            min="1"
            max={pendencia.qty_pendente}
            value={qtyInput}
            onChange={(e) => setQtyInput(e.target.value)}
            style={{ width: 110, fontSize: 18 }}
          />
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={() => setQtyInput(String(pendencia.qty_pendente))}
            style={{ fontSize: 11.5 }}
          >
            = total ({fmtNum(pendencia.qty_pendente)})
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={() => imprimir.mutate()}
            disabled={imprimir.isPending}
            style={{ padding: "14px 12px", fontSize: 14 }}
          >
            <Icon name="tag" size={14} />
            {imprimir.isPending
              ? "Enviando…"
              : `Imprimir ${fmtNum(Number(qtyInput) || pendencia.qty_pendente)} etiq`}
          </button>
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            onClick={() => confirmar.mutate()}
            disabled={
              confirmar.isPending ||
              !destinoEscolhido.id ||
              !Number(qtyInput)
            }
            style={{ padding: "14px 12px", fontSize: 14 }}
          >
            <Icon name="check" size={14} />
            {confirmar.isPending ? "Confirmando…" : "Confirmar e seguir"}
          </button>
        </div>
      </div>

      <div style={{ textAlign: "center" }}>
        <button
          type="button"
          className="wms-btn-link"
          onClick={() => cancelar.mutate()}
          disabled={cancelar.isPending}
          style={{ color: "var(--wms-c-danger, #c81e1e)" }}
        >
          <Icon name="trash" size={11} /> Cancelar pendência (peça
          sumiu/devolvida)
        </button>
      </div>
    </>
  );
}
