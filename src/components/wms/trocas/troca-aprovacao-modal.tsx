"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Modal, Icon, fmtNum, fmtRelative } from "@/components/wms/ui/wms-ui";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";
import {
  TIER_LABEL,
  type TierQualidade,
  type TrocaTipo,
} from "@/lib/wms/trocas-equivalencia-regra";

// ──────────────────────────────────────────────────────────────────
// Tipos — espelham GET /api/wms/trocas (siso_trocas_equivalencia + joins)

export type TrocaOrigemSolicitacao =
  | "roteamento"
  | "separacao"
  | "compras"
  | "painel";

export interface TrocaProdutoLado {
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  tier_qualidade: TierQualidade | null;
}

export interface Troca {
  id: string;
  pedido_id: string;
  pedido_item_id: number;
  galpao_id: string | null;
  sku_vendido: string;
  sku_substituto: string;
  quantidade: number;
  tipo: TrocaTipo;
  origem_solicitacao: TrocaOrigemSolicitacao;
  status: string;
  tier_vendido_snapshot: TierQualidade | null;
  tier_substituto_snapshot: TierQualidade | null;
  solicitado_em: string;
  motivo_rejeicao: string | null;
  produto_vendido: TrocaProdutoLado | null;
  produto_substituto: TrocaProdutoLado | null;
  solicitante: { nome: string } | null;
  galpao: { nome: string } | null;
}

// ──────────────────────────────────────────────────────────────────
// Rótulos / cor por tipo de troca

// Cor por tipo: cada entrada carrega a tripla {bg, bd, fg} de CSS vars
// existentes do design system. 'mute' usa painel/border (não há *-bg/-bd).
const TIPO_LABEL: Record<
  TrocaTipo,
  { texto: string; bg: string; bd: string; fg: string }
> = {
  upgrade: {
    texto: "⬆ UPGRADE — enviando peça superior à anunciada",
    bg: "var(--wms-c-info-bg)",
    bd: "var(--wms-c-info-bd)",
    fg: "var(--wms-c-info)",
  },
  downgrade: {
    texto: "⬇ DOWNGRADE — enviando peça inferior à anunciada",
    bg: "var(--wms-c-warn-bg)",
    bd: "var(--wms-c-warn-bd)",
    fg: "var(--wms-c-warn)",
  },
  misto: {
    texto:
      "⚠ MISTO — cliente receberá peças de marcas diferentes no mesmo pedido",
    bg: "var(--wms-c-danger-bg)",
    bd: "var(--wms-c-danger-bd)",
    fg: "var(--wms-c-danger)",
  },
  sem_classificacao: {
    texto: "❓ SEM CLASSIFICAÇÃO — classifique os produtos abaixo",
    bg: "var(--wms-c-warn-bg)",
    bd: "var(--wms-c-warn-bd)",
    fg: "var(--wms-c-warn)",
  },
  mesmo_nivel: {
    texto: "= MESMO NÍVEL — par não verificado",
    bg: "var(--wms-c-panel-2)",
    bd: "var(--wms-c-border)",
    fg: "var(--wms-c-fg-2)",
  },
};

const ORIGEM_LABEL: Record<TrocaOrigemSolicitacao, string> = {
  roteamento: "Roteamento",
  separacao: "Separação",
  compras: "Compras",
  painel: "Painel",
};

const TIER_OPTS: TierQualidade[] = ["original", "primeira_linha", "segunda_linha"];

// ──────────────────────────────────────────────────────────────────
// Card de um lado da troca (vendido / substituto), com classify inline

function ProdutoLadoCard({
  rotulo,
  produto,
  tierLocal,
  onClassificar,
  podeClassificar,
  classificando,
}: {
  rotulo: string;
  produto: TrocaProdutoLado | null;
  tierLocal: TierQualidade | null;
  onClassificar: (tier: TierQualidade | null) => void;
  podeClassificar: boolean;
  classificando: boolean;
}) {
  const semTier = !tierLocal;
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
        padding: 12,
        background: "var(--wms-c-faint)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div className="wms-td-mute" style={{ fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>
        {rotulo}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        {produto?.imagem_url ? (
          <img
            src={produto.imagem_url}
            alt=""
            loading="lazy"
            className="wms-thumb wms-thumb-sm"
          />
        ) : (
          <div
            className="wms-thumb wms-thumb-sm"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--wms-c-mute)",
            }}
          >
            <Icon name="box" size={16} />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="wms-mono" style={{ fontSize: 13, fontWeight: 600 }}>
            {produto?.sku ?? "—"}
          </div>
          <div className="wms-td-mute" style={{ fontSize: 12, lineHeight: 1.3 }}>
            {produto?.descricao ?? "—"}
          </div>
        </div>
      </div>

      <div>
        {tierLocal ? (
          <span className="wms-badge wms-badge-info">{TIER_LABEL[tierLocal]}</span>
        ) : (
          <span className="wms-badge wms-badge-warn">Sem classificação</span>
        )}
      </div>

      {semTier && podeClassificar && produto && (
        <div style={{ marginTop: 2 }}>
          <select
            className="wms-select"
            value=""
            disabled={classificando}
            onChange={(e) => {
              const v = e.target.value as TierQualidade | "";
              if (v) onClassificar(v);
            }}
          >
            <option value="">{classificando ? "Classificando…" : "Classificar…"}</option>
            {TIER_OPTS.map((t) => (
              <option key={t} value={t}>
                {TIER_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Modal principal

export function TrocaAprovacaoModal({
  troca,
  onClose,
  onDecidido,
}: {
  troca: Troca;
  onClose: () => void;
  onDecidido?: () => void;
}) {
  const qc = useQueryClient();
  const { can } = usePermissoes();
  const podeDecidir = can("vendas.aprovar_troca");
  const podeClassificar = can("produtos.editar");

  // Tier ao vivo: começa do produto (ou snapshot) e atualiza com classify inline.
  const [tierVendido, setTierVendido] = useState<TierQualidade | null>(
    troca.produto_vendido?.tier_qualidade ?? troca.tier_vendido_snapshot ?? null,
  );
  const [tierSubstituto, setTierSubstituto] = useState<TierQualidade | null>(
    troca.produto_substituto?.tier_qualidade ??
      troca.tier_substituto_snapshot ??
      null,
  );

  const [classificandoSku, setClassificandoSku] = useState<string | null>(null);
  const [mostrarRejeicao, setMostrarRejeicao] = useState(false);
  const [motivo, setMotivo] = useState("");

  const pendente = troca.status === "pendente";
  const tipo = TIPO_LABEL[troca.tipo] ?? TIPO_LABEL.mesmo_nivel;

  function invalidar() {
    qc.invalidateQueries({ queryKey: ["wms-trocas"] });
    qc.invalidateQueries({ queryKey: ["wms-trocas-pendentes-count"] });
    qc.invalidateQueries({ queryKey: ["wms-pedidos"] });
    qc.invalidateQueries({ queryKey: ["wms-tarefas-pendentes"] });
  }

  // Classificar produto inline (POST /api/wms/cross/produtos/:sku/tier).
  async function classificar(sku: string, tier: TierQualidade | null) {
    setClassificandoSku(sku);
    try {
      const r = await sisoFetch(
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}/tier`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier }),
        },
      );
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      if (sku === troca.sku_vendido) setTierVendido(tier);
      if (sku === troca.sku_substituto) setTierSubstituto(tier);
      toast.success(
        `${sku} classificado como ${tier ? TIER_LABEL[tier] : "sem classificação"}`,
      );
      qc.invalidateQueries({ queryKey: ["wms-produtos"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setClassificandoSku(null);
    }
  }

  const aprovarMut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch(`/api/wms/trocas/${troca.id}/aprovar`, {
        method: "POST",
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success(`Troca aprovada — ${troca.sku_vendido} → ${troca.sku_substituto}`);
      invalidar();
      onDecidido?.();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejeitarMut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch(`/api/wms/trocas/${troca.id}/rejeitar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivo.trim() || undefined }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Troca rejeitada");
      invalidar();
      onDecidido?.();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const ocupado = aprovarMut.isPending || rejeitarMut.isPending;

  return (
    <Modal
      title="Troca de equivalência"
      subtitle={`Pedido #${troca.pedido_id} · ${ORIGEM_LABEL[troca.origem_solicitacao] ?? troca.origem_solicitacao}`}
      width={720}
      onClose={onClose}
      footer={
        podeDecidir && pendente ? (
          mostrarRejeicao ? (
            <>
              <button
                className="wms-btn wms-btn-ghost"
                onClick={() => setMostrarRejeicao(false)}
                disabled={ocupado}
              >
                Voltar
              </button>
              <button
                className="wms-btn wms-btn-danger"
                onClick={() => rejeitarMut.mutate()}
                disabled={ocupado}
              >
                <Icon name="x" size={11} />
                {rejeitarMut.isPending ? "Rejeitando…" : "Confirmar rejeição"}
              </button>
            </>
          ) : (
            <>
              <button
                className="wms-btn wms-btn-ghost"
                onClick={() => setMostrarRejeicao(true)}
                disabled={ocupado}
              >
                <Icon name="x" size={11} />
                Rejeitar
              </button>
              <button
                className="wms-btn wms-btn-primary"
                onClick={() => aprovarMut.mutate()}
                disabled={ocupado}
              >
                <Icon name="check" size={11} />
                {aprovarMut.isPending ? "Aprovando…" : "Aprovar troca"}
              </button>
            </>
          )
        ) : (
          <button className="wms-btn wms-btn-ghost" onClick={onClose}>
            Fechar
          </button>
        )
      }
    >
      {/* Rótulo grande do tipo */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 14,
          padding: "12px 14px",
          fontSize: 14,
          fontWeight: 600,
          borderRadius: "var(--wms-r-3)",
          border: `1px solid ${tipo.bd}`,
          background: tipo.bg,
          color: tipo.fg,
        }}
      >
        {tipo.texto}
      </div>

      {/* Par lado a lado com seta + qty */}
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: 12,
        }}
      >
        <ProdutoLadoCard
          rotulo="Vendido (anunciado)"
          produto={troca.produto_vendido}
          tierLocal={tierVendido}
          onClassificar={(t) => classificar(troca.sku_vendido, t)}
          podeClassificar={podeClassificar}
          classificando={classificandoSku === troca.sku_vendido}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            color: "var(--wms-c-mute)",
          }}
        >
          <Icon name="arrow-right" size={20} />
          <div
            className="wms-mono"
            style={{ fontSize: 18, fontWeight: 700, color: "var(--wms-c-fg)" }}
          >
            {fmtNum(troca.quantidade)}
          </div>
          <div className="wms-td-mute" style={{ fontSize: 10.5 }}>
            un
          </div>
        </div>
        <ProdutoLadoCard
          rotulo="Substituto (físico)"
          produto={troca.produto_substituto}
          tierLocal={tierSubstituto}
          onClassificar={(t) => classificar(troca.sku_substituto, t)}
          podeClassificar={podeClassificar}
          classificando={classificandoSku === troca.sku_substituto}
        />
      </div>

      {/* Campo de motivo da rejeição */}
      {mostrarRejeicao && (
        <div style={{ marginTop: 14 }}>
          <label className="wms-field-lbl">Motivo da rejeição (opcional)</label>
          <textarea
            className="wms-textarea"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Ex: marcas incompatíveis, cliente exige original…"
            autoFocus
          />
        </div>
      )}

      {/* Motivo de rejeição já registrado (histórico) */}
      {!pendente && troca.motivo_rejeicao && (
        <div className="wms-hint-card wms-hint-danger" style={{ marginTop: 14 }}>
          <Icon name="alert" size={12} />
          <div>
            <strong>Rejeitada</strong>
            <div className="wms-td-mute">{troca.motivo_rejeicao}</div>
          </div>
        </div>
      )}

      {/* Metadados */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          marginTop: 16,
          paddingTop: 12,
          borderTop: "1px solid var(--wms-c-border)",
          fontSize: 12,
        }}
      >
        <span className="wms-pcard-chip">
          {ORIGEM_LABEL[troca.origem_solicitacao] ?? troca.origem_solicitacao}
        </span>
        {troca.galpao?.nome && (
          <span className="wms-pcard-chip is-galpao">{troca.galpao.nome}</span>
        )}
        <span className="wms-td-mute">
          {troca.solicitante?.nome ? `por ${troca.solicitante.nome}` : "solicitação automática"}
        </span>
        <span className="wms-td-mute">·</span>
        <span className="wms-td-mute">{fmtRelative(troca.solicitado_em)}</span>
        <span className="wms-td-mute">·</span>
        <span className="wms-mono wms-td-mute">Pedido #{troca.pedido_id}</span>
      </div>
    </Modal>
  );
}
