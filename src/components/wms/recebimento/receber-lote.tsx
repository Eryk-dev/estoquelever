"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useMutation, useQueries } from "@tanstack/react-query";
import { usePermissoes } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, Field, fmtNum } from "@/components/wms/ui/wms-ui";
import {
  ProdutoCombo,
  LocalizacaoCombo,
  useLocalizacoes,
} from "@/components/wms/ui/modals";
import { ProdutoLightbox } from "@/components/wms/produto-lightbox";
import { MlAnunciosBlock } from "@/components/wms/ml-anuncios-block";
import type { Produto } from "@/lib/wms/types";
import type {
  ReceberLoteItem,
  ReceberLoteConfig,
} from "./receber-lote-types";

// Motivos de divergência — usados pelo dropdown quando qty recebida ≠ esperada
// (OC/manual, fase C3+). Mantido aqui pra ser compartilhado pelos fluxos.
export const MOTIVOS_DIVERGENCIA = [
  { value: "avaria_transporte", label: "Avaria em trânsito" },
  { value: "faltou", label: "Faltou na entrega" },
  { value: "veio_mais", label: "Veio mais que pedido" },
  { value: "sku_errado", label: "SKU errado" },
];

interface PutawayResp {
  localizacao_id: string;
  codigo?: string;
  razao: string;
  locaisExistentes: Array<{
    localizacao_id: string;
    codigo: string;
    tipo: string;
    saldo: number;
  }>;
}

export function makeUid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Linha vazia — usada como seed/reset (avulso). */
export function emptyReceberLoteItem(): ReceberLoteItem {
  return {
    uid: makeUid(),
    produto: null,
    sku: "",
    descricao: "",
    imagem_url: null,
    backendItemId: null,
    qty: "1",
    qtyEsperada: null,
    custo: "",
    locIdOverride: null,
    locCodigoOverride: null,
    imprimir: true,
    motivoDivergencia: null,
  };
}

export interface ReceberLoteSubmitCtx {
  galpaoId: string;
  entradaDireta: boolean;
  iniciarRota: boolean;
}

export interface ReceberLoteProps {
  config: ReceberLoteConfig;
  galpaoId: string;
  itensIniciais: ReceberLoteItem[];
  /** monta o body e faz o POST; resolve com o resultado pra onSuccess */
  submit: (itens: ReceberLoteItem[], ctx: ReceberLoteSubmitCtx) => Promise<unknown>;
  /** invalidação + navegação pós-sucesso (cada fluxo tem o seu) */
  onSuccess: (resp: unknown, itens: ReceberLoteItem[], ctx: ReceberLoteSubmitCtx) => void;
  /** mensagem de erro pós-falha (cada fluxo tem o seu) */
  onError?: (e: Error) => void;
  /** left-form completo do fluxo (galpão/fornecedor/origem/…) — wrapper o monta. */
  renderLeftFormExtra?: () => React.ReactNode;
  /** rodapé extra dentro do plano-de-guarda (avulso: "Ir pra fila de guarda"). */
  renderSidebarFooter?: () => React.ReactNode;
  /** validação extra do fluxo (avulso: fornecedor/compradora). true = ok */
  validarExtra?: (itens: ReceberLoteItem[]) => boolean;
}

export function ReceberLote({
  config,
  galpaoId,
  itensIniciais,
  submit,
  onSuccess,
  onError,
  renderLeftFormExtra,
  renderSidebarFooter,
  validarExtra,
}: ReceberLoteProps) {
  // Permissão de receber derivada do config (fonte única). Para avulso,
  // config.permissaoReceber === 'operacoes.receber'.
  const { can } = usePermissoes();
  const podeReceber = can(config.permissaoReceber);

  const [lightbox, setLightbox] = useState<{
    imagens: string[];
    sku: string;
    descricao: string;
  } | null>(null);

  const [itens, setItens] = useState<ReceberLoteItem[]>(itensIniciais);
  const [iniciarRota, setIniciarRota] = useState(false);
  const [entradaDireta, setEntradaDireta] = useState(false);

  // Seed-once dos fluxos pré-definidos: a lista vem async e, depois de seedada,
  // o operador edita qty/custo/loc. Re-sincronizar a cada nova referência de
  // itensIniciais atropelaria essas edições — então adota a lista UMA vez, na
  // primeira vez que ela ficar não-vazia.
  const predefSeededRef = useRef(false);

  // Re-sincroniza com itensIniciais quando o wrapper o atualiza (avulso: seed
  // via ?produto_id= chega async). Só preenche a primeira linha se estiver
  // vazia — não atropela o operador. Para fluxos pré-definidos (OC/manual/
  // transferência) a lista inteira vem pronta e é adotada uma única vez.
  useEffect(() => {
    if (!config.canAddItems) {
      // Fluxos pré-definidos: seed uma vez, na 1ª vez que itensIniciais chega
      // não-vazio (no mount ainda está [] enquanto carrega). Depois não
      // re-sincroniza, pra não atropelar edições do operador.
      if (predefSeededRef.current || itensIniciais.length === 0) return;
      predefSeededRef.current = true;
      setItens(itensIniciais);
      return;
    }
    // Avulso: o wrapper só muda itensIniciais pra seedar o produto na 1ª linha.
    const seed = itensIniciais[0];
    if (!seed?.produto) return;
    setItens((prev) => {
      const first = prev[0];
      if (first && first.produto) return prev;
      return [{ ...first!, produto: seed.produto }, ...prev.slice(1)];
    });
  }, [itensIniciais, config.canAddItems]);

  // Loc override depende do galpão — ao trocar de galpão, limpa os overrides
  // (mesma semântica do select de galpão no avulso). Ref evita limpar no mount.
  const galpaoRef = useRef(galpaoId);
  useEffect(() => {
    if (galpaoRef.current === galpaoId) return;
    galpaoRef.current = galpaoId;
    setItens((prev) =>
      prev.map((it) => ({ ...it, locIdOverride: null, locCodigoOverride: null })),
    );
  }, [galpaoId]);

  const { data: locsResp } = useLocalizacoes(galpaoId || null);
  const locsById = useMemo(() => {
    const m = new Map<string, { codigo: string; tipo: string }>();
    (locsResp?.rows ?? []).forEach((l) =>
      m.set(l.id, { codigo: l.codigo, tipo: l.tipo }),
    );
    return m;
  }, [locsResp]);

  // Putaway por item — só roda quando o fluxo pede sugestão de loc (avulso).
  // 3D: só produto_id + galpao_id (sem empresa).
  const putawaySuggest = !!config.putawaySuggest;
  const putawayQueries = useQueries({
    queries: itens.map((it) => ({
      queryKey: ["wms-receber-lote-putaway", it.produto?.id, galpaoId],
      queryFn: () =>
        wmsApi<PutawayResp>(
          `/api/wms/receber?produto_id=${it.produto!.id}&galpao_id=${galpaoId}`,
        ),
      enabled: putawaySuggest && !!(it.produto?.id && galpaoId),
      staleTime: 30 * 1000,
    })),
  });

  // Plano de guarda: agrupa por loc destino (resolvida ou pendente)
  const plano = useMemo(() => {
    const grupos = new Map<
      string,
      {
        locId: string | null;
        locCodigo: string;
        locTipo: string;
        itens: Array<{
          uid: string;
          sku: string;
          qty: number;
          imagem_url: string | null;
          imagens: string[];
          descricao: string;
        }>;
      }
    >();
    itens.forEach((it, idx) => {
      const sku = it.produto?.sku ?? it.sku;
      if (!sku || !it.qty || Number(it.qty) <= 0) return;
      const sug = putawayQueries[idx]?.data;
      const locId = it.locIdOverride ?? sug?.localizacao_id ?? null;
      const fromLocs = locId ? locsById.get(locId) : undefined;
      const locCodigo =
        fromLocs?.codigo ??
        it.locCodigoOverride ??
        sug?.codigo ??
        (locId ? locId.slice(0, 8) : "Sem loc decidida");
      const locTipo =
        fromLocs?.tipo ??
        sug?.locaisExistentes.find((l) => l.localizacao_id === locId)?.tipo ??
        "";
      const key = locId ?? "__pending__";
      const grp = grupos.get(key) ?? {
        locId,
        locCodigo,
        locTipo,
        itens: [],
      };
      grp.itens.push({
        uid: it.uid,
        sku,
        qty: Number(it.qty),
        imagem_url: it.produto?.imagem_url ?? it.imagem_url,
        imagens: it.produto?.imagens ?? [],
        descricao: it.produto?.descricao ?? it.descricao,
      });
      grupos.set(key, grp);
    });
    return Array.from(grupos.values()).sort((a, b) => {
      if (a.locId === null) return 1;
      if (b.locId === null) return -1;
      return a.locCodigo.localeCompare(b.locCodigo);
    });
  }, [itens, putawayQueries, locsById]);

  const totaisPlano = useMemo(() => {
    let totalUn = 0;
    let totalLinhas = 0;
    let semLoc = 0;
    plano.forEach((g) => {
      g.itens.forEach((i) => {
        totalUn += i.qty;
        totalLinhas++;
      });
      if (g.locId === null) semLoc += g.itens.length;
    });
    return { totalUn, totalLinhas, semLoc };
  }, [plano]);

  const marcadosImprimir = itens.filter((it) => it.imprimir).length;
  const todosMarcadosImprimir = itens.length > 0 && marcadosImprimir === itens.length;
  const parcialmenteMarcadosImprimir =
    marcadosImprimir > 0 && marcadosImprimir < itens.length;

  const submitMut = useMutation({
    mutationFn: async () => {
      const ctx: ReceberLoteSubmitCtx = { galpaoId, entradaDireta, iniciarRota };
      // Resolve a loc efetiva por item (override do operador OU sugestão de
      // putaway), baixando o suggestion pro `locIdOverride` que o `submit`
      // consome. Sem sugestão de putaway, mantém o override como está.
      const itensResolvidos: ReceberLoteItem[] = itens.map((it, idx) => {
        const sug = putawayQueries[idx]?.data;
        const locId = it.locIdOverride ?? sug?.localizacao_id ?? null;
        const locCodigo = it.locCodigoOverride ?? sug?.codigo ?? null;
        return { ...it, locIdOverride: locId, locCodigoOverride: locCodigo };
      });
      const resp = await submit(itensResolvidos, ctx);
      return { resp, ctx };
    },
    onSuccess: ({ resp, ctx }) => {
      onSuccess(resp, itens, ctx);
      // Avulso: limpa a lista pra próximo lote (left-form é resetado no wrapper).
      // Fluxos pré-definidos navegam embora no onSuccess, sem reset local.
      if (config.canAddItems) {
        setItens([emptyReceberLoteItem()]);
      }
    },
    onError: (e: Error) => {
      if (onError) onError(e);
      else toast.error(e.message);
    },
  });

  // ── Validade ──────────────────────────────────────────────────────
  // Um item "tem produto" se há um produto resolvido (avulso) ou um sku
  // pré-definido (OC/manual/transferência).
  const temProduto = (it: ReceberLoteItem) => !!it.produto || !!it.sku;
  const itensValidos = itens.filter((it) => {
    if (!temProduto(it)) return false;
    // qty > 0 sempre exigida (editável ou fixa)
    if (!it.qty || Number(it.qty) <= 0) return false;
    if (config.custoObrigatorio) {
      if (it.custo === "" || !Number.isFinite(Number(it.custo)) || Number(it.custo) < 0)
        return false;
    } else if (config.custoVisible) {
      // custo opcional mas, se preenchido, precisa ser válido
      if (it.custo !== "" && (!Number.isFinite(Number(it.custo)) || Number(it.custo) < 0))
        return false;
    }
    if (config.locObrigatoria && !it.locIdOverride) return false;
    return true;
  });

  const extraOk = validarExtra ? validarExtra(itens) : true;
  const valid =
    !!galpaoId &&
    extraOk &&
    itensValidos.length > 0 &&
    itensValidos.length === itens.filter(temProduto).length &&
    (!entradaDireta || totaisPlano.semLoc === 0);

  // ── helpers de manipulação de itens (avulso) ─────────────────────────
  const updateItem = (idx: number, next: ReceberLoteItem) =>
    setItens((prev) => prev.map((x, i) => (i === idx ? next : x)));

  const removeItem = (idx: number) =>
    setItens((prev) =>
      prev.length === 1 ? [emptyReceberLoteItem()] : prev.filter((_, i) => i !== idx),
    );

  const addItem = () => setItens((p) => [...p, emptyReceberLoteItem()]);

  const onImageClick = (p: Produto) =>
    setLightbox({
      imagens:
        p.imagens && p.imagens.length > 0
          ? p.imagens
          : p.imagem_url
            ? [p.imagem_url]
            : [],
      sku: p.sku,
      descricao: p.descricao,
    });

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: config.planoSidebarVisible
          ? "minmax(0, 1fr) 320px"
          : "minmax(0, 1fr)",
        gap: 16,
        alignItems: "start",
      }}
    >
      {/* ── COLUNA ESQUERDA: captura ───────────────────────────────── */}
      <div>
        {config.leftFormVisible ? (
          <>
            <h3 className="wms-sec-h">Configuração do lote</h3>
            {renderLeftFormExtra?.()}
          </>
        ) : (
          config.headerChips &&
          config.headerChips.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                marginBottom: 12,
              }}
            >
              {config.headerChips.map((c) => (
                <span
                  key={c.label}
                  className="wms-td-mute"
                  style={{
                    fontSize: 12,
                    background: "var(--wms-c-faint)",
                    border: "1px solid var(--wms-c-border)",
                    borderRadius: "var(--wms-r-2)",
                    padding: "4px 10px",
                  }}
                >
                  {c.label}: <strong>{c.value}</strong>
                </span>
              ))}
            </div>
          )
        )}

        <h3 className="wms-sec-h" style={{ marginTop: config.leftFormVisible ? 16 : 0 }}>
          Itens ({itens.length})
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
          {itens.map((it, idx) => (
            <ItemLoteRow
              key={it.uid}
              config={config}
              item={it}
              putaway={putawayQueries[idx]?.data}
              isFetching={!!putawayQueries[idx]?.isFetching}
              galpaoId={galpaoId}
              locsById={locsById}
              canResolve={!!galpaoId}
              onImageClick={onImageClick}
              onChange={(next) => updateItem(idx, next)}
              onRemove={() => removeItem(idx)}
            />
          ))}
          {config.canAddItems && (
            <button
              type="button"
              className="wms-btn wms-btn-ghost"
              style={{ borderStyle: "dashed", alignSelf: "flex-start" }}
              onClick={addItem}
            >
              <Icon name="plus" size={11} /> Adicionar item
            </button>
          )}
        </div>
      </div>

      {/* ── COLUNA DIREITA: plano de guarda ────────────────────────── */}
      {config.planoSidebarVisible ? (
        <aside
          style={{
            position: "sticky",
            top: 16,
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
              marginBottom: 10,
            }}
          >
            <strong style={{ fontSize: 13 }}>
              <Icon name="box" size={12} />{" "}
              {entradaDireta ? "Plano de entrada direta" : "Plano de guarda"}
            </strong>
            <span className="wms-td-mute" style={{ fontSize: 11 }}>
              {totaisPlano.totalLinhas} linha
              {totaisPlano.totalLinhas !== 1 ? "s" : ""} ·{" "}
              {fmtNum(totaisPlano.totalUn)} un
            </span>
          </div>

          {plano.length === 0 && (
            <div className="wms-td-mute" style={{ fontSize: 12 }}>
              Bipe SKUs ao lado pra gerar o plano automaticamente.
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {plano.map((g) => (
              <div
                key={g.locId ?? "pending"}
                style={{
                  background:
                    g.locId === null
                      ? "var(--wms-c-warn-faint, #fff7e6)"
                      : "var(--wms-c-faint)",
                  border:
                    g.locId === null
                      ? "1px solid #f0c36d"
                      : "1px solid var(--wms-c-border)",
                  borderRadius: "var(--wms-r-2)",
                  padding: 10,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 6,
                  }}
                >
                  <span
                    className="wms-mono"
                    style={{ fontSize: 12, fontWeight: 600 }}
                  >
                    {g.locCodigo}
                  </span>
                  <span className="wms-td-mute" style={{ fontSize: 11 }}>
                    {g.locTipo}
                    {g.locTipo ? " · " : ""}
                    {g.itens.length} SKU{g.itens.length > 1 ? "s" : ""}
                  </span>
                </div>
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {g.itens.map((i) => (
                    <li
                      key={i.uid}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        justifyContent: "space-between",
                        fontSize: 11.5,
                        padding: "2px 0",
                      }}
                    >
                      {i.imagem_url && (
                        <img
                          src={i.imagem_url}
                          alt=""
                          loading="lazy"
                          className="wms-thumb wms-thumb-xs wms-thumb-click"
                          onClick={() =>
                            setLightbox({
                              imagens:
                                i.imagens.length > 0
                                  ? i.imagens
                                  : [i.imagem_url!],
                              sku: i.sku,
                              descricao: i.descricao,
                            })
                          }
                        />
                      )}
                      <span className="wms-mono" style={{ flex: 1, minWidth: 0 }}>
                        {i.sku}
                      </span>
                      <span className="wms-mono wms-tar">{fmtNum(i.qty)} un</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {totaisPlano.semLoc > 0 && (
            <div
              className="wms-td-mute"
              style={{
                marginTop: 10,
                fontSize: 11,
                color: entradaDireta ? "#b91c1c" : "#a16207",
                fontWeight: entradaDireta ? 600 : undefined,
              }}
            >
              <Icon name="alert" size={11} /> {totaisPlano.semLoc} item
              {totaisPlano.semLoc > 1 ? "ns" : ""} sem loc destino —{" "}
              {entradaDireta
                ? "defina pra confirmar (entrada direta exige loc)"
                : "tablet decide via putaway na hora de guardar"}
            </div>
          )}

          <div
            style={{
              marginTop: 12,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontSize: 11.5,
            }}
          >
            {config.imprimirVisible && (
              <label
                style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                title="Marca/desmarca todos os itens da lista"
              >
                <input
                  type="checkbox"
                  checked={todosMarcadosImprimir}
                  ref={(el) => {
                    if (el) el.indeterminate = parcialmenteMarcadosImprimir;
                  }}
                  onChange={() => {
                    const next = !todosMarcadosImprimir;
                    setItens((prev) => prev.map((it) => ({ ...it, imprimir: next })));
                  }}
                />
                Imprimir etiquetas ao confirmar{" "}
                <span className="wms-td-mute" style={{ fontSize: 11 }}>
                  ({marcadosImprimir}/{itens.length})
                </span>
              </label>
            )}
            <label
              style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={entradaDireta}
                onChange={(e) => {
                  setEntradaDireta(e.target.checked);
                  if (e.target.checked) setIniciarRota(false);
                }}
              />
              <span>
                Entrada direta <span className="wms-td-mute">(pula a guarda)</span>
              </span>
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: entradaDireta ? "not-allowed" : "pointer",
                opacity: entradaDireta ? 0.5 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={iniciarRota}
                disabled={entradaDireta}
                onChange={(e) => setIniciarRota(e.target.checked)}
              />
              Já abrir a rota de guarda do lote
            </label>
          </div>

          <button
            type="button"
            className="wms-btn wms-btn-primary"
            style={{ marginTop: 10, width: "100%" }}
            disabled={!valid || submitMut.isPending || !podeReceber}
            title={!podeReceber ? "Sem permissão pra receber mercadoria" : ""}
            onClick={() => submitMut.mutate()}
          >
            <Icon name="check" size={11} />
            {submitMut.isPending
              ? "Enviando…"
              : `Confirmar lote (${itensValidos.length})`}
          </button>

          {renderSidebarFooter?.()}
        </aside>
      ) : (
        // Footer simples (fluxos sem plano-de-guarda)
        <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            disabled={!valid || submitMut.isPending || !podeReceber}
            title={!podeReceber ? "Sem permissão pra receber mercadoria" : ""}
            onClick={() => submitMut.mutate()}
          >
            <Icon name="check" size={11} />
            {submitMut.isPending
              ? "Enviando…"
              : `Confirmar (${itensValidos.length})`}
          </button>
        </div>
      )}

      {lightbox && (
        <ProdutoLightbox
          imagens={lightbox.imagens}
          sku={lightbox.sku}
          descricao={lightbox.descricao}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

function ItemLoteRow({
  config,
  item,
  putaway,
  isFetching,
  galpaoId,
  locsById,
  canResolve,
  onChange,
  onRemove,
  onImageClick,
}: {
  config: ReceberLoteConfig;
  item: ReceberLoteItem;
  putaway?: PutawayResp;
  isFetching: boolean;
  galpaoId: string;
  locsById: Map<string, { codigo: string; tipo: string }>;
  canResolve: boolean;
  onChange: (next: ReceberLoteItem) => void;
  onRemove: () => void;
  onImageClick?: (p: Produto) => void;
}) {
  const [trocandoLoc, setTrocandoLoc] = useState(false);

  const locIdAtual = item.locIdOverride ?? putaway?.localizacao_id ?? "";
  const locCodigoAtual =
    item.locCodigoOverride ??
    (locIdAtual ? locsById.get(locIdAtual)?.codigo : undefined) ??
    putaway?.codigo ??
    "";
  const isSugestao =
    !!putaway && locIdAtual === putaway.localizacao_id && !item.locIdOverride;

  const skuDisplay = item.produto?.sku ?? item.sku;
  const descDisplay = item.produto?.descricao ?? item.descricao;
  const imgDisplay = item.produto?.imagem_url ?? item.imagem_url;
  const temProduto = !!item.produto || !!item.sku;
  const divergiu =
    config.divergenciaVisible &&
    item.qtyEsperada != null &&
    Number(item.qty) !== item.qtyEsperada;

  return (
    <div
      style={{
        background: "var(--wms-c-panel)",
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-2)",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {config.imprimirVisible && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              cursor: "pointer",
              color: item.imprimir ? "currentColor" : "var(--wms-c-mute, #888)",
            }}
            title={
              item.imprimir
                ? "Etiqueta deste item vai pra impressora"
                : "Etiqueta deste item NÃO será impressa"
            }
          >
            <input
              type="checkbox"
              checked={item.imprimir}
              onChange={(e) => onChange({ ...item, imprimir: e.target.checked })}
            />
            <Icon name="tag" size={12} />
          </label>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {config.productEditable ? (
            <ProdutoCombo
              value={item.produto}
              onChange={(p) =>
                onChange({
                  ...item,
                  produto: p,
                  locIdOverride: null,
                  locCodigoOverride: null,
                })
              }
              autoFocus={!item.produto}
              onImageClick={onImageClick}
            />
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              {imgDisplay && (
                <img
                  src={imgDisplay}
                  alt=""
                  loading="lazy"
                  className="wms-thumb wms-thumb-xs"
                />
              )}
              <div style={{ minWidth: 0 }}>
                <div className="wms-mono" style={{ fontWeight: 600, fontSize: 12 }}>
                  {skuDisplay}
                </div>
                <div
                  className="wms-td-mute"
                  style={{
                    fontSize: 11,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={descDisplay}
                >
                  {descDisplay}
                </div>
              </div>
            </div>
          )}
        </div>
        {config.qtyEditable ? (
          <input
            className="wms-input wms-mono wms-tar"
            type="number"
            min={1}
            value={item.qty}
            style={{ width: 80 }}
            onChange={(e) => onChange({ ...item, qty: e.target.value })}
            placeholder="qty"
          />
        ) : (
          <span className="wms-mono wms-tar" style={{ width: 80, fontSize: 13 }}>
            {fmtNum(Number(item.qty))} un
          </span>
        )}
        {config.custoVisible && (
          <input
            className="wms-input wms-mono wms-tar"
            type="number"
            step="0.01"
            value={item.custo}
            style={{ width: 100 }}
            placeholder="custo"
            onChange={(e) => onChange({ ...item, custo: e.target.value })}
          />
        )}
        {config.canAddItems && (
          <button
            type="button"
            className="wms-btn-icon"
            title="Remover"
            onClick={onRemove}
          >
            <Icon name="trash" size={12} />
          </button>
        )}
      </div>

      {config.divergenciaVisible && divergiu && (
        <div style={{ paddingLeft: 4 }}>
          <Field label="Motivo da divergência" hint="qty difere do esperado">
            <select
              className="wms-select"
              value={item.motivoDivergencia ?? ""}
              onChange={(e) =>
                onChange({ ...item, motivoDivergencia: e.target.value || null })
              }
            >
              <option value="">Escolha o motivo…</option>
              {MOTIVOS_DIVERGENCIA.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {config.locPickVisible && temProduto && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            paddingLeft: 4,
            fontSize: 11.5,
          }}
        >
          {!canResolve && (
            <span className="wms-td-mute">Escolha galpão acima</span>
          )}
          {canResolve && isFetching && (
            <span className="wms-td-mute">Buscando localização…</span>
          )}
          {canResolve && !isFetching && locIdAtual && (
            <>
              <Icon name="arrow-right" size={11} />
              <span className="wms-mono" style={{ fontWeight: 600 }}>
                {locCodigoAtual}
              </span>
              {isSugestao && putaway?.razao && (
                <span className="wms-td-mute">
                  <Icon name="sparkle" size={10} /> {putaway.razao}
                </span>
              )}
              {!isSugestao && (
                <span className="wms-td-mute">(escolhida pelo operador)</span>
              )}
              <button
                type="button"
                className="wms-btn-link"
                onClick={() => setTrocandoLoc((v) => !v)}
              >
                {trocandoLoc ? "Cancelar" : "Trocar loc"}
              </button>
              <button
                type="button"
                className="wms-btn-link"
                onClick={() => onChange({ ...item, locIdOverride: null, locCodigoOverride: null })}
                title="Deixa tablet decidir na guarda"
              >
                Limpar
              </button>
            </>
          )}
          {canResolve && !isFetching && !locIdAtual && (
            <>
              <Icon name="alert" size={11} />
              <span className="wms-td-mute">Sem sugestão automática</span>
              <button
                type="button"
                className="wms-btn-link"
                onClick={() => setTrocandoLoc((v) => !v)}
              >
                {trocandoLoc ? "Cancelar" : "Definir localização"}
              </button>
            </>
          )}
        </div>
      )}

      {/* Locs com saldo */}
      {config.locPickVisible &&
        temProduto &&
        canResolve &&
        !isFetching &&
        (putaway?.locaisExistentes.length ?? 0) > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 4 }}>
            <span className="wms-td-mute" style={{ fontSize: 11, alignSelf: "center" }}>
              <Icon name="box" size={10} /> Onde já tem saldo:
            </span>
            {putaway!.locaisExistentes.map((l) => {
              const isSelected = l.localizacao_id === locIdAtual;
              return (
                <button
                  key={l.localizacao_id}
                  type="button"
                  className={`wms-btn wms-btn-sm ${isSelected ? "wms-btn-primary" : "wms-btn-ghost"}`}
                  style={{ fontSize: 11 }}
                  onClick={() =>
                    onChange({
                      ...item,
                      locIdOverride: l.localizacao_id,
                      locCodigoOverride: l.codigo,
                    })
                  }
                  title={`${fmtNum(l.saldo)} un. em ${l.codigo}`}
                >
                  <span className="wms-mono">{l.codigo}</span>
                  <span className="wms-td-mute" style={{ marginLeft: 6, fontSize: 10.5 }}>
                    {fmtNum(l.saldo)} un · {l.tipo}
                  </span>
                </button>
              );
            })}
          </div>
        )}

      {config.locPickVisible && trocandoLoc && (
        <div style={{ paddingLeft: 4 }}>
          <LocalizacaoCombo
            galpaoId={galpaoId || null}
            value={locIdAtual}
            allowCreate={config.locAllowCreate ?? true}
            onChange={(id) => {
              if (!id) return;
              onChange({
                ...item,
                locIdOverride: id,
                locCodigoOverride: null,
              });
              setTrocandoLoc(false);
            }}
          />
        </div>
      )}

      {config.mlBlockVisible && (item.produto?.sku || item.sku) && (
        <MlAnunciosBlock sku={item.produto?.sku ?? item.sku} />
      )}
    </div>
  );
}
