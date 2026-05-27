"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";
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
import { useTrackPresencaWms } from "@/hooks/use-presenca-wms";

interface DetalheResponse {
  pendencia: PendenciaJoined;
  sugestao: { localizacao_id: string; codigo?: string; razao: string } | null;
  locais_existentes: Array<{
    localizacao_id: string;
    codigo: string;
    tipo: string;
    saldo: number;
  }>;
}

export default function GuardaTabletPage() {
  const params = useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const { can } = usePermissoes();
  const podeGuardar = can("operacoes.guarda");
  const id = String(params?.id ?? "");

  // Anuncia presença no card "Guarda" do quadro de tarefas (/wms).
  useTrackPresencaWms("guarda");
  const [qtyInput, setQtyInput] = useState("");
  const [destinoOverride, setDestinoOverride] = useState<{
    id: string;
    codigo: string;
  } | null>(null);
  const [scanKey, setScanKey] = useState(0);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["wms-guarda", id],
    queryFn: () => wmsApi<DetalheResponse>(`/api/wms/guarda/${id}`),
    enabled: !!id,
  });

  const pend = data?.pendencia;
  const galpaoId = pend?.galpao_id ?? null;
  const { data: locsResp } = useLocalizacoes(galpaoId);
  const locsById = useMemo(() => {
    const m = new Map<string, { codigo: string; tipo: string }>();
    (locsResp?.rows ?? []).forEach((l) =>
      m.set(l.id, { codigo: l.codigo, tipo: l.tipo }),
    );
    return m;
  }, [locsResp]);
  const locsByCodigo = useMemo(() => {
    const m = new Map<string, { id: string; tipo: string }>();
    (locsResp?.rows ?? []).forEach((l) =>
      m.set(l.codigo.toUpperCase(), { id: l.id, tipo: l.tipo }),
    );
    return m;
  }, [locsResp]);

  // Prioridade do destino:
  //   1) override do scan/troca do operador
  //   2) loc destino decidida no recebimento (pendência)
  //   3) sugestão dinâmica de putaway
  const destinoEscolhido = destinoOverride ?? {
    id:
      pend?.localizacao_destino_id ??
      data?.sugestao?.localizacao_id ??
      "",
    codigo:
      pend?.localizacao_destino?.codigo ??
      data?.sugestao?.codigo ??
      "",
  };
  const destinoVemDoRecebimento =
    !destinoOverride && !!pend?.localizacao_destino_id;
  const destinoEhSugestao =
    !destinoOverride &&
    !pend?.localizacao_destino_id &&
    data?.sugestao?.localizacao_id === destinoEscolhido.id;

  // Quando carregar a pendência, popula o input de qty com qty_pendente
  useEffect(() => {
    if (pend && qtyInput === "") {
      setQtyInput(String(pend.qty_pendente));
    }
  }, [pend, qtyInput]);

  const iniciarMut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch(`/api/wms/guarda/${id}/iniciar`, {
        method: "POST",
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-guarda", id] });
      toast.success("Guarda iniciada — você é o operador responsável");
    },
    onError: (e: Error) => toast.error(e.message),
  });

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
        toast.success("Guarda completa — voltando pra fila");
        qc.invalidateQueries({ queryKey: ["wms-guarda"] });
        qc.invalidateQueries({ queryKey: ["wms-estoque"] });
        qc.invalidateQueries({ queryKey: ["wms-ledger"] });
        qc.invalidateQueries({ queryKey: ["wms-cobertura"] });
        qc.invalidateQueries({ queryKey: ["wms-cobertura-all"] });
        qc.invalidateQueries({ queryKey: ["wms-dashboard-geral"] });
        router.push("/wms/guarda");
      } else {
        toast.success(
          `Parcial: guardado, faltam ${fmtNum(r.pendencia.qty_pendente)} un`,
        );
        setQtyInput(String(r.pendencia.qty_pendente));
        setDestinoOverride(null);
        qc.invalidateQueries({ queryKey: ["wms-guarda", id] });
      }
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
      qc.invalidateQueries({ queryKey: ["wms-guarda"] });
      router.push("/wms/guarda");
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
    if (found.id === pend?.localizacao_origem_id) {
      toast.error("Loc destino não pode ser RECEBIMENTO");
      setScanKey((k) => k + 1);
      return;
    }
    setDestinoOverride({ id: found.id, codigo });
    setScanKey((k) => k + 1);
    toast.success(`Destino: ${codigo}`);
  }

  if (isLoading) {
    return <div className="wms-loading-pane">Carregando pendência…</div>;
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
  if (!pend) return null;

  const terminal = pend.status === "guardada" || pend.status === "cancelada";

  return (
    <div style={{ maxWidth: 880, margin: "0 auto" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <Link
          href="/wms/guarda"
          className="wms-btn wms-btn-ghost"
          style={{ fontSize: 12 }}
        >
          <Icon name="chevron-r" size={11} /> Fila
        </Link>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {pend?.status === "pendente" ? (
            <button
              className="wms-btn wms-btn-primary"
              onClick={() => iniciarMut.mutate()}
              disabled={iniciarMut.isPending}
            >
              <Icon name="arrow-right" size={12} />
              {iniciarMut.isPending ? "Iniciando…" : "Começar guarda"}
            </button>
          ) : null}
          <StatusBadge status={pend.status} size="lg" />
        </div>
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
        {pend.produto?.imagem_url && (
          <img
            src={pend.produto.imagem_url}
            alt=""
            className="wms-thumb wms-thumb-lg"
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="wms-mono"
            style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}
          >
            {pend.produto?.sku ?? "—"}
          </div>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            {pend.produto?.descricao ?? ""}
          </div>
          <div
            className="wms-td-mute"
            style={{ fontSize: 11.5, display: "flex", gap: 14, flexWrap: "wrap" }}
          >
            <span>
              <Icon name="pin" size={10} /> {pend.galpao?.nome ?? "—"}
            </span>
            {pend.nf_referencia && (
              <span>
                NF <span className="wms-mono">{pend.nf_referencia}</span>
              </span>
            )}
            <span>Recebida {fmtRelative(pend.criada_em)}</span>
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
            {fmtNum(pend.qty_pendente)}
          </div>
          {pend.qty_guardada > 0 && (
            <div className="wms-td-mute" style={{ fontSize: 11 }}>
              {fmtNum(pend.qty_guardada)} já guardadas de {fmtNum(pend.qty_inicial)}
            </div>
          )}
        </div>
      </div>

      {terminal ? (
        <div className="wms-empty-block">
          <h3>
            Pendência {pend.status === "guardada" ? "concluída" : "cancelada"}
          </h3>
          {pend.status === "guardada" && (
            <p>
              Toda a quantidade foi guardada em{" "}
              {pend.guardada_em ? fmtRelative(pend.guardada_em) : "—"}.
            </p>
          )}
          {pend.status === "cancelada" && (
            <p>
              Cancelada em{" "}
              {pend.cancelada_em ? fmtRelative(pend.cancelada_em) : "—"}.
              Motivo: {pend.motivo_cancelamento ?? "—"}
            </p>
          )}
        </div>
      ) : (
        <>
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
              }}
            >
              <span
                className="wms-mono"
                style={{ fontSize: 28, fontWeight: 700 }}
              >
                {destinoEscolhido.codigo || "—"}
              </span>
              {destinoVemDoRecebimento && (
                <span className="wms-td-mute" style={{ fontSize: 11 }}>
                  <Icon name="sparkle" size={10} /> decidido no recebimento
                </span>
              )}
              {destinoEhSugestao && data?.sugestao?.razao && (
                <span className="wms-td-mute" style={{ fontSize: 11 }}>
                  <Icon name="sparkle" size={10} /> {data.sugestao.razao}
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
              placeholder="bipe a localização de guarda"
            />
            <div
              className="wms-td-mute"
              style={{ fontSize: 11, marginTop: 6 }}
            >
              Bipe o QR/código da prateleira pra trocar a sugestão.
            </div>

            {/* Atalhos pra locs onde o SKU já tem saldo */}
            {data && data.locais_existentes.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div
                  className="wms-td-mute"
                  style={{ fontSize: 11, marginBottom: 6, fontWeight: 600 }}
                >
                  <Icon name="box" size={10} /> Já tem saldo em:
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {data.locais_existentes.map((l) => {
                    const isSelected = l.localizacao_id === destinoEscolhido.id;
                    return (
                      <button
                        key={l.localizacao_id}
                        type="button"
                        className={`wms-btn wms-btn-sm ${isSelected ? "wms-btn-primary" : "wms-btn-ghost"}`}
                        onClick={() =>
                          setDestinoOverride({
                            id: l.localizacao_id,
                            codigo: l.codigo,
                          })
                        }
                        style={{ fontSize: 12 }}
                      >
                        <span className="wms-mono">{l.codigo}</span>
                        <span
                          className="wms-td-mute"
                          style={{ marginLeft: 6, fontSize: 10.5 }}
                        >
                          {fmtNum(l.saldo)} un · {l.tipo}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
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
                Qty a guardar agora
              </label>
              <input
                id="guarda-qty"
                className="wms-input wms-mono wms-tar"
                type="number"
                min="1"
                max={pend.qty_pendente}
                value={qtyInput}
                onChange={(e) => setQtyInput(e.target.value)}
                style={{ width: 110, fontSize: 18 }}
              />
              <button
                type="button"
                className="wms-btn wms-btn-ghost"
                onClick={() => setQtyInput(String(pend.qty_pendente))}
                style={{ fontSize: 11.5 }}
              >
                = total ({fmtNum(pend.qty_pendente)})
              </button>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
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
                  : `Imprimir ${fmtNum(Number(qtyInput) || pend.qty_pendente)} etiq`}
              </button>
              <button
                type="button"
                className="wms-btn wms-btn-primary"
                onClick={() => confirmar.mutate()}
                disabled={
                  confirmar.isPending ||
                  !destinoEscolhido.id ||
                  !Number(qtyInput) ||
                  !podeGuardar
                }
                title={!podeGuardar ? "Sem permissão pra confirmar guarda" : ""}
                style={{ padding: "14px 12px", fontSize: 14 }}
              >
                <Icon name="check" size={14} />
                {confirmar.isPending ? "Confirmando…" : "Confirmar guarda"}
              </button>
            </div>
          </div>

          {/* Cancelar */}
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
      )}
    </div>
  );
}
