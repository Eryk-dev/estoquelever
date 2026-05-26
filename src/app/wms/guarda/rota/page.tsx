"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Icon,
  Kpi,
  StatusBadge,
  fmtNum,
  fmtRelative,
} from "@/components/wms/ui/wms-ui";
import { LocalizacaoCombo, useLocalizacoes } from "@/components/wms/ui/modals";
import { ScanContagem } from "@/components/wms/scan-contagem";
import type { PendenciaJoined } from "@/lib/wms/guarda";
import { useTrackPresencaWms } from "@/hooks/use-presenca-wms";

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
  const qc = useQueryClient();

  // Anuncia presença no card "Guarda" do quadro de tarefas (/wms).
  useTrackPresencaWms("guarda");

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
  });

  const fila = useMemo(() => data?.rows ?? [], [data]);
  const restantes = fila.filter((p) => p.qty_pendente > 0).length;
  const concluidas = fila.length - restantes;
  // 1º não-zerado vira "ativa" pra autoFocus
  const ativaId = fila.find((p) => p.qty_pendente > 0)?.id ?? null;
  // Pendências ativas: usadas pelo "Imprimir todas as etiquetas" no header
  const pendenciasAtivasIds = fila
    .filter((p) => p.qty_pendente > 0)
    .map((p) => p.id);

  const imprimirTudo = useMutation({
    mutationFn: async () => {
      if (pendenciasAtivasIds.length === 0) {
        throw new Error("nenhuma pendência ativa pra imprimir");
      }
      const r = await sisoFetch("/api/wms/guarda/imprimir-lote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendencia_ids: pendenciasAtivasIds }),
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

  function onPendenciaResolvida() {
    qc.invalidateQueries({ queryKey: ["wms-guarda-rota", queryString] });
    qc.invalidateQueries({ queryKey: ["wms-guarda"] });
    qc.invalidateQueries({ queryKey: ["wms-estoque"] });
    qc.invalidateQueries({ queryKey: ["wms-ledger"] });
    qc.invalidateQueries({ queryKey: ["wms-cobertura"] });
    qc.invalidateQueries({ queryKey: ["wms-dashboard-geral"] });
    refetch();
  }

  const tituloRota = lote
    ? "Rota — lote único"
    : todas
      ? "Rota — guardar tudo"
      : ids
        ? "Rota — seleção"
        : "Rota";

  const tudoConcluido = !isLoading && (fila.length === 0 || restantes === 0);

  // Métricas pra tela de parabéns (cálculo barato, sem useMemo pra evitar
  // hook após early return).
  const guardadasFinais = fila.filter((p) => p.status === "guardada");
  const unidadesGuardadas = guardadasFinais.reduce(
    (sum, p) => sum + Number(p.qty_inicial),
    0,
  );
  const minutosRota = (() => {
    if (guardadasFinais.length === 0) return 0;
    const inicios = fila
      .map((p) => p.iniciada_em ?? p.criada_em)
      .filter(Boolean) as string[];
    const fins = guardadasFinais
      .map((p) => p.guardada_em)
      .filter(Boolean) as string[];
    if (inicios.length === 0 || fins.length === 0) return 0;
    const start = Math.min(...inicios.map((s) => new Date(s).getTime()));
    const end = Math.max(...fins.map((s) => new Date(s).getTime()));
    return Math.max(1, Math.round((end - start) / 60000));
  })();

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

  if (tudoConcluido) {
    return (
      <ResumoFinalRota
        titulo={tituloRota}
        guardadas={guardadasFinais.length}
        unidades={unidadesGuardadas}
        minutos={minutosRota}
      />
    );
  }

  return (
    <div style={{ maxWidth: 920, margin: "0 auto" }}>
      {/* Header da rota */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
          gap: 8,
          position: "sticky",
          top: 0,
          zIndex: 5,
          background: "var(--wms-c-bg, #fff)",
          padding: "8px 0",
        }}
      >
        <Link
          href="/wms/guarda"
          className="wms-btn wms-btn-ghost"
          style={{ fontSize: 12 }}
        >
          <Icon name="chevron-l" size={11} /> Fila
        </Link>
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{tituloRota}</div>
          <div className="wms-td-mute" style={{ fontSize: 11 }}>
            {concluidas} de {fila.length} concluídas · {restantes} restantes
          </div>
        </div>
        <button
          type="button"
          className="wms-btn wms-btn-ghost"
          onClick={() => imprimirTudo.mutate()}
          disabled={
            imprimirTudo.isPending || pendenciasAtivasIds.length === 0
          }
          style={{ fontSize: 12 }}
          title="Imprime de uma vez as etiquetas de todas as pendências ainda ativas"
        >
          <Icon name="tag" size={11} />
          {imprimirTudo.isPending
            ? "Imprimindo…"
            : `Imprimir tudo (${pendenciasAtivasIds.length})`}
        </button>
      </div>

      {/* Checklist */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {fila.map((p) => (
          <PendenciaCard
            key={p.id}
            pendencia={p}
            isActive={p.id === ativaId}
            onResolvida={onPendenciaResolvida}
          />
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// ResumoFinalRota — tela de parabéns ao zerar a fila (mesmo pattern do
// inventário cíclico: 🎉 + KPIs + CTAs pra fila/receber).

function ResumoFinalRota({
  titulo,
  guardadas,
  unidades,
  minutos,
}: {
  titulo: string;
  guardadas: number;
  unidades: number;
  minutos: number;
}) {
  const velocidade =
    minutos > 0 && guardadas > 0
      ? Math.round((guardadas / minutos) * 60)
      : 0;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 18,
        padding: "48px 16px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 56 }}>🎉</div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>Rota concluída!</div>
      <div className="wms-td-mute" style={{ maxWidth: 380 }}>
        {guardadas > 0
          ? `Todas as pendências da rota foram guardadas. ${titulo.toLowerCase().includes("tudo") ? "Excelente trabalho!" : "Bom trabalho!"}`
          : "Esta rota já estava vazia — nenhuma pendência ativa pra guardar."}
      </div>
      {guardadas > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 10,
            marginTop: 12,
            width: "100%",
            maxWidth: 520,
          }}
        >
          <Kpi label="Pendências" value={guardadas} />
          <Kpi label="Unidades" value={fmtNum(unidades)} />
          <Kpi
            label="Tempo"
            value={
              minutos === 0
                ? "—"
                : minutos < 60
                  ? `${minutos}min`
                  : `${Math.floor(minutos / 60)}h ${minutos % 60}min`
            }
          />
        </div>
      )}
      {velocidade > 0 && (
        <div className="wms-td-mute" style={{ fontSize: 12 }}>
          Velocidade média: <strong>{velocidade} pendências/h</strong>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap", justifyContent: "center" }}>
        <Link href="/wms/guarda" className="wms-btn wms-btn-primary">
          <Icon name="chevron-l" size={12} /> Voltar pra fila
        </Link>
        <Link href="/wms/receber" className="wms-btn wms-btn-ghost">
          <Icon name="plus" size={12} /> Receber mais
        </Link>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// PendenciaCard — uma linha do checklist. Encapsula scanner, troca de loc,
// imprimir e confirmar. Colapsa pra um resumo se status terminal.

function PendenciaCard({
  pendencia,
  isActive,
  onResolvida,
}: {
  pendencia: PendenciaJoined;
  isActive: boolean;
  onResolvida: () => void;
}) {
  const id = pendencia.id;
  const terminal =
    pendencia.status === "guardada" || pendencia.status === "cancelada";

  const [qtyInput, setQtyInput] = useState(String(pendencia.qty_pendente));
  const [destinoOverride, setDestinoOverride] = useState<{
    id: string;
    codigo: string;
  } | null>(null);
  const [scanKey, setScanKey] = useState(0);
  const [trocandoLoc, setTrocandoLoc] = useState(false);

  // Pendência muda (refetch após resolver alguém) → reseta estado local
  useEffect(() => {
    setQtyInput(String(pendencia.qty_pendente));
    setDestinoOverride(null);
    setTrocandoLoc(false);
  }, [pendencia.id, pendencia.qty_pendente]);

  const { data: locsResp } = useLocalizacoes(pendencia.galpao_id);
  const locsByCodigo = useMemo(() => {
    const m = new Map<string, { id: string; tipo: string }>();
    (locsResp?.rows ?? []).forEach((l) =>
      m.set(l.codigo.toUpperCase(), { id: l.id, tipo: l.tipo }),
    );
    return m;
  }, [locsResp]);

  const destinoEscolhido = destinoOverride ?? {
    id: pendencia.localizacao_destino_id ?? "",
    codigo: pendencia.localizacao_destino?.codigo ?? "",
  };
  const destinoVemDoRecebimento =
    !destinoOverride && !!pendencia.localizacao_destino_id;

  // Inicia ao montar (idempotente)
  useEffect(() => {
    if (pendencia.status === "pendente" && isActive) {
      sisoFetch(`/api/wms/guarda/${id}/iniciar`, { method: "POST" }).catch(
        () => {},
      );
    }
  }, [id, pendencia.status, isActive]);

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
        toast.success(`✓ ${pendencia.produto?.sku ?? "guarda"}`);
      } else {
        toast.success(
          `Parcial: faltam ${fmtNum(r.pendencia.qty_pendente)} un`,
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
      toast.success("Pendência cancelada");
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

  // ── Render terminal (colapsado) ─────────────────────────────
  if (terminal) {
    const isGuardada = pendencia.status === "guardada";
    return (
      <div
        style={{
          background: "var(--wms-c-panel)",
          border: "1px solid var(--wms-c-border)",
          borderRadius: "var(--wms-r-3)",
          padding: 10,
          display: "flex",
          alignItems: "center",
          gap: 12,
          opacity: 0.75,
        }}
      >
        {pendencia.produto?.imagem_url && (
          <img
            src={pendencia.produto.imagem_url}
            alt=""
            loading="lazy"
            className="wms-thumb wms-thumb-xs"
          />
        )}
        <Icon
          name={isGuardada ? "check" : "x"}
          size={16}
          className={isGuardada ? "wms-c-ok" : "wms-c-danger"}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="wms-mono" style={{ fontSize: 13, fontWeight: 600 }}>
            {pendencia.produto?.sku ?? "—"}
            {pendencia.localizacao_destino?.codigo && (
              <span className="wms-td-mute" style={{ marginLeft: 8, fontWeight: 400 }}>
                → {pendencia.localizacao_destino.codigo}
              </span>
            )}
          </div>
          <div
            className="wms-td-mute"
            style={{
              fontSize: 11,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {isGuardada
              ? `Guardada — ${fmtNum(pendencia.qty_inicial)} un`
              : `Cancelada — ${pendencia.motivo_cancelamento ?? "sem motivo"}`}
          </div>
        </div>
        <StatusBadge status={pendencia.status} />
      </div>
    );
  }

  // ── Render ativo (expandido) ────────────────────────────────
  return (
    <div
      style={{
        background: "var(--wms-c-panel)",
        border: isActive
          ? "2px solid var(--wms-c-primary, #2563eb)"
          : "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* Header: produto + qty grande */}
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        {pendencia.produto?.imagem_url && (
          <img
            src={pendencia.produto.imagem_url}
            alt=""
            loading="lazy"
            className="wms-thumb"
            style={{ width: 56, height: 56, borderRadius: 8, objectFit: "cover" }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="wms-mono"
            style={{ fontSize: 17, fontWeight: 700, marginBottom: 2 }}
          >
            {pendencia.produto?.sku ?? "—"}
          </div>
          <div
            style={{
              fontSize: 12.5,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {pendencia.produto?.descricao ?? ""}
          </div>
          <div
            className="wms-td-mute"
            style={{ fontSize: 11, display: "flex", gap: 10, flexWrap: "wrap", marginTop: 2 }}
          >
            {pendencia.galpao?.nome && <span>{pendencia.galpao.nome}</span>}
            {pendencia.nf_referencia && (
              <span>
                NF <span className="wms-mono">{pendencia.nf_referencia}</span>
              </span>
            )}
            <span>{fmtRelative(pendencia.criada_em)}</span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="wms-td-mute" style={{ fontSize: 10.5 }}>
            A guardar
          </div>
          <div className="wms-mono" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>
            {fmtNum(pendencia.qty_pendente)}
          </div>
          {pendencia.qty_guardada > 0 && (
            <div className="wms-td-mute" style={{ fontSize: 10 }}>
              {fmtNum(pendencia.qty_guardada)} já guardadas
            </div>
          )}
        </div>
      </div>

      {/* Loc destino + scanner */}
      <div>
        <div
          style={{
            fontSize: 10.5,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 4,
            fontWeight: 600,
          }}
        >
          <Icon name="pin" size={10} /> Loc destino
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 6,
            flexWrap: "wrap",
          }}
        >
          <span className="wms-mono" style={{ fontSize: 24, fontWeight: 700 }}>
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
          <button
            type="button"
            className="wms-btn-link"
            style={{ marginLeft: "auto", fontSize: 11.5 }}
            onClick={() => setTrocandoLoc((v) => !v)}
          >
            {trocandoLoc ? "Fechar" : "Trocar loc manual"}
          </button>
        </div>

        <ScanContagem
          key={`scan-loc-${id}-${scanKey}`}
          onScan={handleScanLoc}
          autoFocus={isActive}
          placeholder="bipe a localização de guarda"
        />

        {trocandoLoc && (
          <div style={{ marginTop: 8 }}>
            <LocalizacaoCombo
              galpaoId={pendencia.galpao_id}
              value={destinoEscolhido.id}
              onChange={(locId) => {
                if (!locId) return;
                if (locId === pendencia.localizacao_origem_id) {
                  toast.error("Não pode ser RECEBIMENTO");
                  return;
                }
                const loc = (locsResp?.rows ?? []).find((l) => l.id === locId);
                setDestinoOverride({
                  id: locId,
                  codigo: loc?.codigo ?? "",
                });
                setTrocandoLoc(false);
              }}
            />
          </div>
        )}
      </div>

      {/* Qty + Confirmar (CTA principal) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "140px 1fr",
          gap: 10,
          alignItems: "center",
        }}
      >
        <div>
          <label
            className="wms-td-mute"
            style={{ fontSize: 10.5, fontWeight: 600, display: "block", marginBottom: 4 }}
            htmlFor={`qty-${id}`}
          >
            Qty a guardar
          </label>
          <input
            id={`qty-${id}`}
            className="wms-input wms-mono wms-tar"
            type="number"
            min="1"
            max={pendencia.qty_pendente}
            value={qtyInput}
            onChange={(e) => setQtyInput(e.target.value)}
            style={{ fontSize: 20, fontWeight: 700, padding: "12px 10px" }}
          />
        </div>
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          onClick={() => confirmar.mutate()}
          disabled={
            confirmar.isPending || !destinoEscolhido.id || !Number(qtyInput)
          }
          style={{
            padding: "18px 14px",
            fontSize: 16,
            fontWeight: 700,
            height: "100%",
          }}
        >
          <Icon name="check" size={16} />
          {confirmar.isPending ? "Confirmando…" : "Confirmar guarda"}
        </button>
      </div>

      {/* Ações secundárias */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <button
          type="button"
          className="wms-btn-link"
          onClick={() => imprimir.mutate()}
          disabled={imprimir.isPending}
          style={{ fontSize: 11 }}
        >
          <Icon name="tag" size={10} />
          {imprimir.isPending ? "Imprimindo…" : "Imprimir etiqueta deste item"}
        </button>
        <button
          type="button"
          className="wms-btn-link"
          onClick={() => cancelar.mutate()}
          disabled={cancelar.isPending}
          style={{ color: "var(--wms-c-danger, #c81e1e)", fontSize: 11 }}
        >
          <Icon name="trash" size={10} /> Cancelar pendência
        </button>
      </div>
    </div>
  );
}
