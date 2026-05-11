"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { sisoFetch } from "@/lib/auth-context";
import { useWmsModals } from "@/components/wms/wms-shell";
import { LocalizacaoCombo } from "@/components/wms/ui/modals";
import {
  Icon,
  Modal,
  PageHeader,
  StatusBadge,
  fmtDateTime,
  fmtNum,
} from "@/components/wms/ui/wms-ui";

interface TransferenciaItem {
  id: string;
  produto_id: string;
  localizacao_origem_id: string;
  qty: number;
  localizacao_destino_id: string | null;
  mov_saida_id: string | null;
  mov_entrada_id: string | null;
  mov_estorno_id: string | null;
  produto?: { sku: string; descricao: string };
  localizacao_origem?: { codigo: string };
  localizacao_destino?: { codigo: string } | null;
}

interface Transferencia {
  id: string;
  empresa_dona_id: string;
  galpao_origem_id: string;
  galpao_destino_id: string;
  status: "em_transito" | "recebida" | "cancelada";
  criada_em: string;
  recebida_em: string | null;
  cancelada_em: string | null;
  observacoes: string | null;
  empresa?: { nome: string };
  galpao_origem?: { nome: string };
  galpao_destino?: { nome: string };
  criada_por_user?: { nome: string };
  itens?: TransferenciaItem[];
}

type Aba = "em_transito" | "historico";

export default function TransferirPage() {
  const modals = useWmsModals();
  const queryClient = useQueryClient();
  const [aba, setAba] = useState<Aba>("em_transito");
  const [receberId, setReceberId] = useState<string | null>(null);

  const emTransitoQuery = useQuery({
    queryKey: ["wms-transferencias", "em_transito"],
    queryFn: () =>
      wmsApi<{ rows: Transferencia[] }>(
        `/api/wms/transferencias?status=em_transito&limit=200`,
      ),
    staleTime: 15 * 1000,
  });

  const historicoQuery = useQuery({
    queryKey: ["wms-transferencias", "historico"],
    queryFn: async () => {
      const [recebidas, canceladas] = await Promise.all([
        wmsApi<{ rows: Transferencia[] }>(
          `/api/wms/transferencias?status=recebida&limit=100`,
        ),
        wmsApi<{ rows: Transferencia[] }>(
          `/api/wms/transferencias?status=cancelada&limit=100`,
        ),
      ]);
      const all = [...recebidas.rows, ...canceladas.rows];
      all.sort(
        (a, b) =>
          new Date(b.recebida_em ?? b.cancelada_em ?? b.criada_em).getTime() -
          new Date(a.recebida_em ?? a.cancelada_em ?? a.criada_em).getTime(),
      );
      return { rows: all };
    },
    enabled: aba === "historico",
    staleTime: 30 * 1000,
  });

  const cancelMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await sisoFetch(`/api/wms/transferencias/${id}/cancelar`, {
        method: "POST",
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Transferência cancelada e saídas estornadas");
      queryClient.invalidateQueries({ queryKey: ["wms-transferencias"] });
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const emTransito = useMemo(
    () => emTransitoQuery.data?.rows ?? [],
    [emTransitoQuery.data],
  );
  const transferenciaParaReceber = useMemo(
    () => emTransito.find((t) => t.id === receberId) ?? null,
    [emTransito, receberId],
  );

  return (
    <>
      <PageHeader
        title="Transferências entre galpões"
        subtitle="Fluxo 2-etapas: origem envia, destino confirma a localização"
      >
        <button
          className="wms-btn wms-btn-primary"
          onClick={() => modals.open("transferir")}
        >
          <Icon name="plus" size={12} />
          Nova transferência
        </button>
      </PageHeader>

      <div className="wms-seg" style={{ marginBottom: 16 }}>
        <button
          className={`wms-seg-btn ${aba === "em_transito" ? "is-active" : ""}`}
          onClick={() => setAba("em_transito")}
        >
          Em trânsito{" "}
          <span className="wms-td-mute">({emTransito.length})</span>
        </button>
        <button
          className={`wms-seg-btn ${aba === "historico" ? "is-active" : ""}`}
          onClick={() => setAba("historico")}
        >
          Histórico
        </button>
      </div>

      {aba === "em_transito" && (
        <EmTransitoList
          rows={emTransito}
          isLoading={emTransitoQuery.isLoading}
          onReceber={(id) => setReceberId(id)}
          onCancelar={(id) => {
            if (!confirm("Cancelar e estornar saídas da origem?")) return;
            cancelMut.mutate(id);
          }}
        />
      )}

      {aba === "historico" && (
        <HistoricoList
          rows={historicoQuery.data?.rows ?? []}
          isLoading={historicoQuery.isLoading}
        />
      )}

      {transferenciaParaReceber && (
        <ReceberModal
          transferencia={transferenciaParaReceber}
          onClose={() => setReceberId(null)}
          onSuccess={() => {
            setReceberId(null);
            queryClient.invalidateQueries({ queryKey: ["wms-transferencias"] });
            queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
            queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
            queryClient.invalidateQueries({ queryKey: ["wms-produtos"] });
          }}
        />
      )}
    </>
  );
}

// ─── Em trânsito ──────────────────────────────────────────────────────────

function EmTransitoList({
  rows,
  isLoading,
  onReceber,
  onCancelar,
}: {
  rows: Transferencia[];
  isLoading: boolean;
  onReceber: (id: string) => void;
  onCancelar: (id: string) => void;
}) {
  if (isLoading) {
    return <div className="wms-loading-pane">Carregando…</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="wms-empty-block">
        <h3>Nenhuma transferência em trânsito</h3>
        <p>
          Quando uma transferência é criada, ela aparece aqui até ser recebida
          pelo galpão destino ou cancelada.
        </p>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {rows.map((t) => (
        <div
          key={t.id}
          style={{
            background: "var(--wms-c-paper)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-3)",
            padding: 14,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 12,
              marginBottom: 10,
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                <span className="wms-chip-emp">
                  {(t.empresa?.nome ?? "?").slice(0, 3).toUpperCase()}
                </span>{" "}
                {t.galpao_origem?.nome ?? "?"}{" "}
                <Icon name="arrow-right" size={12} />{" "}
                {t.galpao_destino?.nome ?? "?"}
              </div>
              <div
                className="wms-td-mute"
                style={{ fontSize: 11, marginTop: 2 }}
              >
                Criada {fmtDateTime(t.criada_em)}
                {t.criada_por_user?.nome && ` por ${t.criada_por_user.nome}`}
                {t.observacoes && ` · "${t.observacoes}"`}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="wms-btn wms-btn-ghost wms-btn-sm"
                onClick={() => onCancelar(t.id)}
              >
                <Icon name="x" size={11} />
                Cancelar
              </button>
              <button
                className="wms-btn wms-btn-primary wms-btn-sm"
                onClick={() => onReceber(t.id)}
              >
                <Icon name="check" size={11} />
                Receber
              </button>
            </div>
          </div>
          <div className="wms-tbl wms-tbl-tight">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Produto</th>
                  <th>Origem</th>
                  <th className="wms-tar">Qty</th>
                </tr>
              </thead>
              <tbody>
                {(t.itens ?? []).map((it) => (
                  <tr key={it.id}>
                    <td className="wms-mono">{it.produto?.sku ?? "—"}</td>
                    <td>{it.produto?.descricao ?? "—"}</td>
                    <td className="wms-mono">
                      {it.localizacao_origem?.codigo ?? "—"}
                    </td>
                    <td className="wms-tar wms-mono">{fmtNum(it.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Histórico ────────────────────────────────────────────────────────────

function HistoricoList({
  rows,
  isLoading,
}: {
  rows: Transferencia[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return <div className="wms-loading-pane">Carregando…</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="wms-empty-block">
        <h3>Sem histórico</h3>
        <p>Transferências recebidas ou canceladas aparecem aqui.</p>
      </div>
    );
  }
  return (
    <div className="wms-tbl">
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>Origem</th>
            <th></th>
            <th>Destino</th>
            <th className="wms-tar">Itens</th>
            <th className="wms-tar">Qty total</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const qtyTotal = (t.itens ?? []).reduce(
              (s, i) => s + Number(i.qty),
              0,
            );
            const data =
              t.recebida_em ?? t.cancelada_em ?? t.criada_em;
            return (
              <tr key={t.id}>
                <td className="wms-td-mute">{fmtDateTime(data)}</td>
                <td>{t.galpao_origem?.nome ?? "—"}</td>
                <td>
                  <Icon name="arrow-right" size={12} />
                </td>
                <td>{t.galpao_destino?.nome ?? "—"}</td>
                <td className="wms-tar wms-mono">{(t.itens ?? []).length}</td>
                <td className="wms-tar wms-mono">{fmtNum(qtyTotal)}</td>
                <td>
                  <StatusBadge status={t.status} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Modal de receber ─────────────────────────────────────────────────────

function ReceberModal({
  transferencia,
  onClose,
  onSuccess,
}: {
  transferencia: Transferencia;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const galpaoDestId = transferencia.galpao_destino_id;
  const itensPendentes = (transferencia.itens ?? []).filter(
    (it) => !it.mov_entrada_id && !it.mov_estorno_id,
  );
  const [destinos, setDestinos] = useState<Record<string, string>>(() =>
    Object.fromEntries(itensPendentes.map((it) => [it.id, ""])),
  );

  const mut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch(
        `/api/wms/transferencias/${transferencia.id}/receber`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itens: itensPendentes.map((it) => ({
              transferencia_item_id: it.id,
              localizacao_destino_id: destinos[it.id],
            })),
          }),
        },
      );
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Transferência recebida — saldos atualizados");
      onSuccess();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const valid = itensPendentes.every((it) => !!destinos[it.id]);

  return (
    <Modal
      title="Receber transferência"
      subtitle={`${transferencia.galpao_origem?.nome ?? "?"} → ${transferencia.galpao_destino?.nome ?? "?"}`}
      width={820}
      onClose={onClose}
      footer={
        <>
          <button className="wms-btn wms-btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="wms-btn wms-btn-primary"
            disabled={!valid || mut.isPending}
            onClick={() => mut.mutate()}
          >
            <Icon name="check" size={11} />
            {mut.isPending ? "Recebendo…" : "Confirmar recebimento"}
          </button>
        </>
      }
    >
      <div
        className="wms-td-mute"
        style={{ fontSize: 12, marginBottom: 12 }}
      >
        Escolha a localização final pra cada item no galpão{" "}
        <strong>{transferencia.galpao_destino?.nome}</strong>.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {itensPendentes.map((it) => (
          <div
            key={it.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1.5fr 70px 1fr",
              gap: 8,
              alignItems: "center",
              padding: 10,
              background: "var(--wms-c-faint)",
              border: "1px solid var(--wms-c-border)",
              borderRadius: "var(--wms-r-3)",
            }}
          >
            <div>
              <div className="wms-mono" style={{ fontSize: 13 }}>
                {it.produto?.sku ?? "—"}
              </div>
              <div
                className="wms-td-mute"
                style={{ fontSize: 11, marginTop: 2 }}
              >
                {it.produto?.descricao}
              </div>
              <div
                className="wms-td-mute"
                style={{ fontSize: 11, marginTop: 2 }}
              >
                Origem:{" "}
                <span className="wms-mono">
                  {it.localizacao_origem?.codigo ?? "—"}
                </span>
              </div>
            </div>
            <div className="wms-tar wms-mono" style={{ fontWeight: 600 }}>
              {fmtNum(it.qty)}
            </div>
            <LocalizacaoCombo
              galpaoId={galpaoDestId}
              value={destinos[it.id] ?? ""}
              onChange={(v) =>
                setDestinos((prev) => ({ ...prev, [it.id]: v }))
              }
            />
          </div>
        ))}
        {itensPendentes.length === 0 && (
          <div className="wms-exp-empty">
            Nenhum item pendente — todos já foram recebidos.
          </div>
        )}
      </div>
    </Modal>
  );
}
