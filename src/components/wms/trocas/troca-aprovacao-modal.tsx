"use client";

import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Modal, Icon, fmtNum, fmtRelative } from "@/components/wms/ui/wms-ui";
import {
  ProdutoLightbox,
  ProdutoComparador,
} from "@/components/wms/produto-lightbox";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";
import {
  TIER_LABEL,
  type TierQualidade,
  type TrocaTipo,
  type ParVerificacao,
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
  imagens: string[] | null;
  tier_qualidade: TierQualidade | null;
}

/** Lista de fotos do produto: array completo, com fallback pra capa. */
function imagensDe(p: TrocaProdutoLado | null): string[] {
  if (!p) return [];
  if (p.imagens && p.imagens.length > 0) return p.imagens;
  return p.imagem_url ? [p.imagem_url] : [];
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
  onAbrirFotos,
}: {
  rotulo: string;
  produto: TrocaProdutoLado | null;
  tierLocal: TierQualidade | null;
  onClassificar: (tier: TierQualidade | null) => void;
  podeClassificar: boolean;
  classificando: boolean;
  onAbrirFotos: () => void;
}) {
  const semTier = !tierLocal;
  const fotos = imagensDe(produto);
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
        {fotos.length > 0 ? (
          <button
            type="button"
            onClick={onAbrirFotos}
            title="Ver fotos"
            style={{
              position: "relative",
              padding: 0,
              border: "none",
              background: "none",
              cursor: "zoom-in",
              flexShrink: 0,
            }}
          >
            <img
              src={fotos[0]}
              alt=""
              loading="lazy"
              className="wms-thumb wms-thumb-sm wms-thumb-click"
            />
            {fotos.length > 1 && (
              <span
                className="wms-mono"
                style={{
                  position: "absolute",
                  bottom: -4,
                  right: -4,
                  background: "var(--wms-c-fg)",
                  color: "var(--wms-c-bg)",
                  fontSize: 9,
                  fontWeight: 700,
                  lineHeight: 1,
                  padding: "2px 4px",
                  borderRadius: 999,
                }}
              >
                {fotos.length}
              </span>
            )}
          </button>
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

  // Visualizador de fotos: lightbox de um produto + comparador lado a lado.
  const [lightbox, setLightbox] = useState<{
    imagens: string[];
    sku: string;
    descricao: string;
  } | null>(null);
  const [comparando, setComparando] = useState(false);

  // Substituto exibido: começa do da troca; muda ao vivo quando o operador
  // escolhe outra opção (sem fechar o modal). Aprovar usa o troca.id (intocado).
  const [subOverride, setSubOverride] = useState<{
    sku: string;
    produto: TrocaProdutoLado;
    tipo: TrocaTipo;
    tier: TierQualidade | null;
  } | null>(null);

  const pendente = troca.status === "pendente";

  const subSku = subOverride?.sku ?? troca.sku_substituto;
  const subProduto = subOverride?.produto ?? troca.produto_substituto;
  const subTipo = subOverride?.tipo ?? troca.tipo;

  const tipo = TIPO_LABEL[subTipo] ?? TIPO_LABEL.mesmo_nivel;

  const fotosVendido = imagensDe(troca.produto_vendido);
  const fotosSubstituto = imagensDe(subProduto);
  const podeComparar = fotosVendido.length > 0 && fotosSubstituto.length > 0;

  // ESC/backdrop fecham primeiro o visualizador aberto, só então o modal.
  function fechar() {
    if (lightbox) return setLightbox(null);
    if (comparando) return setComparando(false);
    onClose();
  }

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
      if (sku === subSku) setTierSubstituto(tier);
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
      toast.success(`Troca aprovada — ${troca.sku_vendido} → ${subSku}`);
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
    <>
    <Modal
      title="Troca de equivalência"
      subtitle={`Pedido #${troca.pedido_id} · ${ORIGEM_LABEL[troca.origem_solicitacao] ?? troca.origem_solicitacao}`}
      width={720}
      onClose={fechar}
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
              {podeComparar && (
                <button
                  className="wms-btn wms-btn-ghost"
                  onClick={() => setComparando(true)}
                  disabled={ocupado}
                  style={{ marginRight: "auto" }}
                >
                  <Icon name="columns" size={11} />
                  Comparar
                </button>
              )}
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
          <>
            {podeComparar && (
              <button
                className="wms-btn wms-btn-ghost"
                onClick={() => setComparando(true)}
                style={{ marginRight: "auto" }}
              >
                <Icon name="columns" size={11} />
                Comparar
              </button>
            )}
            <button className="wms-btn wms-btn-ghost" onClick={onClose}>
              Fechar
            </button>
          </>
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
          onAbrirFotos={() =>
            setLightbox({
              imagens: fotosVendido,
              sku: troca.sku_vendido,
              descricao: troca.produto_vendido?.descricao ?? "",
            })
          }
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
          produto={subProduto}
          tierLocal={tierSubstituto}
          onClassificar={(t) => classificar(subSku, t)}
          podeClassificar={podeClassificar}
          classificando={classificandoSku === subSku}
          onAbrirFotos={() =>
            setLightbox({
              imagens: fotosSubstituto,
              sku: subSku,
              descricao: subProduto?.descricao ?? "",
            })
          }
        />
      </div>

      {/* Outras opções de substituto (só em troca pendente, quem decide) */}
      {podeDecidir && pendente && (
        <OutrasOpcoes
          trocaId={troca.id}
          skuVendido={troca.sku_vendido}
          galpaoId={troca.galpao_id}
          skuSubstitutoAtual={subSku}
          quantidade={troca.quantidade}
          onTrocado={(e, tipoNovo) => {
            setSubOverride({
              sku: e.sku,
              produto: {
                sku: e.sku,
                descricao: e.descricao,
                imagem_url: e.imagem_url,
                imagens:
                  e.imagens && e.imagens.length > 0
                    ? e.imagens
                    : e.imagem_url
                      ? [e.imagem_url]
                      : null,
                tier_qualidade: e.tier_qualidade,
              },
              tipo: tipoNovo,
              tier: e.tier_qualidade,
            });
            setTierSubstituto(e.tier_qualidade);
            invalidar();
          }}
        />
      )}

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

      {/* Lightbox de um produto (clique na foto) */}
      {lightbox && (
        <ProdutoLightbox
          imagens={lightbox.imagens}
          sku={lightbox.sku}
          descricao={lightbox.descricao}
          onClose={() => setLightbox(null)}
        />
      )}

      {/* Comparador lado a lado (vendido × substituto) */}
      {comparando && (
        <ProdutoComparador
          esquerda={{
            rotulo: "Vendido (anunciado)",
            sku: troca.sku_vendido,
            descricao: troca.produto_vendido?.descricao ?? "",
            imagens: fotosVendido,
          }}
          direita={{
            rotulo: "Substituto (físico)",
            sku: subSku,
            descricao: subProduto?.descricao ?? "",
            imagens: fotosSubstituto,
          }}
          onClose={() => setComparando(false)}
        />
      )}
    </>
  );
}

// ──────────────────────────────────────────────────────────────────
// Outras opções de substituto — lista os equivalentes com saldo no galpão da
// troca e troca o substituto via POST /trocas/[id]/trocar-substituto.

interface EquivalenteOpcao {
  produto_id: string;
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  imagens: string[] | null;
  tier_qualidade: TierQualidade | null;
  par_verificacao: ParVerificacao;
  disponivel_galpao: number;
}

function OutrasOpcoes({
  trocaId,
  skuVendido,
  galpaoId,
  skuSubstitutoAtual,
  quantidade,
  onTrocado,
}: {
  trocaId: string;
  skuVendido: string;
  galpaoId: string | null;
  skuSubstitutoAtual: string;
  quantidade: number;
  onTrocado: (e: EquivalenteOpcao, tipoNovo: TrocaTipo) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [trocando, setTrocando] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["wms-trocas-candidatos", trocaId, skuVendido, galpaoId],
    queryFn: async () => {
      const r = await sisoFetch(
        `/api/wms/trocas/equivalentes?sku=${encodeURIComponent(skuVendido)}&galpao_id=${encodeURIComponent(galpaoId ?? "")}`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ equivalentes: EquivalenteOpcao[] }>;
    },
    enabled: aberto && !!galpaoId,
  });

  // Outras opções: saldo suficiente, par não bloqueado, ≠ substituto atual.
  const opcoes = useMemo(
    () =>
      (data?.equivalentes ?? []).filter(
        (e) =>
          e.sku !== skuSubstitutoAtual &&
          e.par_verificacao !== "bloqueado" &&
          e.disponivel_galpao >= quantidade,
      ),
    [data?.equivalentes, skuSubstitutoAtual, quantidade],
  );

  async function trocar(e: EquivalenteOpcao) {
    setTrocando(e.sku);
    try {
      const r = await sisoFetch(`/api/wms/trocas/${trocaId}/trocar-substituto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ novo_sku: e.sku }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        troca?: { tipo: TrocaTipo };
        error?: string;
      };
      if (!r.ok || !body.troca) {
        toast.error(body.error ?? "Erro ao trocar substituto");
        return;
      }
      toast.success(`Substituto trocado para ${e.sku}`);
      setAberto(false);
      onTrocado(e, body.troca.tipo);
    } catch {
      toast.error("Erro de conexão ao trocar substituto");
    } finally {
      setTrocando(null);
    }
  }

  if (!galpaoId) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        className="wms-btn wms-btn-ghost wms-btn-sm"
        onClick={() => setAberto((v) => !v)}
      >
        {aberto ? "▾ Ocultar outras opções" : "▸ Ver outras opções de substituto"}
      </button>

      {aberto && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {opcoes.length === 0 ? (
            <div className="wms-td-mute" style={{ fontSize: 12, padding: "4px 2px" }}>
              Nenhum outro equivalente com saldo suficiente neste galpão.
            </div>
          ) : (
            opcoes.map((e) => {
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
                            : "Par não verificado — troca exige aprovação"
                        }
                      >
                        {verificado ? "✓ Verificado" : "Não verificado"}
                      </span>
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
                      {e.descricao}
                    </div>
                  </div>
                  <div
                    className="wms-mono wms-tar"
                    style={{ fontWeight: 700, fontSize: 14, whiteSpace: "nowrap" }}
                    title="Disponível neste galpão"
                  >
                    {fmtNum(e.disponivel_galpao)}
                  </div>
                  <button
                    type="button"
                    className="wms-btn wms-btn-sm wms-btn-ghost"
                    disabled={trocando !== null}
                    onClick={() => trocar(e)}
                    style={{ whiteSpace: "nowrap" }}
                  >
                    {trocando === e.sku ? "Trocando…" : "Usar esta"}
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
