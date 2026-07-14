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

/** Tira o sufixo "(CÓDIGO)" da razão do putaway quando repete a loc exibida ao lado. */
function stripRazaoLocSuffix(razao: string, locCodigo: string) {
  if (!locCodigo) return razao;
  const sufixo = `(${locCodigo})`;
  return razao.endsWith(sufixo)
    ? razao.slice(0, razao.length - sufixo.length).trimEnd()
    : razao;
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
    produtoWmsId: null,
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
  /** validação extra do fluxo (avulso: fornecedor/compradora). true/[] = ok.
   *  Pode devolver lista de pendências legíveis (ex.: "Falta: fornecedor") —
   *  a primeira aparece junto ao botão de confirmar. boolean só desabilita. */
  validarExtra?: (itens: ReceberLoteItem[]) => boolean | string[];
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
  // config.permissaoReceber === 'operacoes.receber'. Para OC, aceita qualquer
  // uma das permissões listadas (operacoes.receber OR compras.executar).
  const { can, canAny } = usePermissoes();
  const podeReceber = Array.isArray(config.permissaoReceber)
    ? canAny(...config.permissaoReceber)
    : can(config.permissaoReceber);

  const [lightbox, setLightbox] = useState<{
    imagens: string[];
    sku: string;
    descricao: string;
  } | null>(null);

  const [itens, setItens] = useState<ReceberLoteItem[]>(itensIniciais);
  const [iniciarRota, setIniciarRota] = useState(false);
  const [entradaDireta, setEntradaDireta] = useState(
    config.entradaDiretaDefault ?? false,
  );

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
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    queries: itens.map((it) => {
      const prodId = it.produto?.id ?? it.produtoWmsId;
      return {
        queryKey: ["wms-receber-lote-putaway", prodId, galpaoId],
        queryFn: () =>
          wmsApi<PutawayResp>(
            `/api/wms/receber?produto_id=${prodId}&galpao_id=${galpaoId}`,
          ),
        enabled: putawaySuggest && !!(prodId && galpaoId),
        staleTime: 30 * 1000,
      };
    }),
  });

  // Plano de guarda: agrupa por loc destino (resolvida ou pendente), com os
  // itens agregados por SKU dentro de cada loc (soma qty, conta linhas).
  const plano = useMemo(() => {
    const grupos = new Map<
      string,
      {
        locId: string | null;
        locCodigo: string;
        locTipo: string;
        itens: Map<
          string,
          {
            sku: string;
            qty: number;
            linhas: number;
            imagem_url: string | null;
            imagens: string[];
            descricao: string;
          }
        >;
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
        itens: new Map(),
      };
      const entry = grp.itens.get(sku);
      if (entry) {
        entry.qty += Number(it.qty);
        entry.linhas += 1;
      } else {
        grp.itens.set(sku, {
          sku,
          qty: Number(it.qty),
          linhas: 1,
          imagem_url: it.produto?.imagem_url ?? it.imagem_url,
          imagens: it.produto?.imagens ?? [],
          descricao: it.produto?.descricao ?? it.descricao,
        });
      }
      grupos.set(key, grp);
    });
    return Array.from(grupos.values())
      .map((g) => ({
        ...g,
        itens: Array.from(g.itens.values()).sort((a, b) =>
          a.sku.localeCompare(b.sku),
        ),
      }))
      .sort((a, b) => {
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
        totalLinhas += i.linhas;
      });
      if (g.locId === null)
        semLoc += g.itens.reduce((s, i) => s + i.linhas, 0);
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
  // Linha pré-definida com qty 0 = "não veio" (recebimento parcial). É válida
  // — os adapters filtram qty<=0 do payload — e não exige custo/loc.
  const ehNaoVeio = (it: ReceberLoteItem) =>
    it.backendItemId != null && Number(it.qty) === 0;
  const itemPendencia = (it: ReceberLoteItem): string | null => {
    if (ehNaoVeio(it)) return null;
    // qty > 0 sempre exigida (editável ou fixa)
    if (!it.qty || Number(it.qty) <= 0) return "sem quantidade";
    if (config.custoObrigatorio) {
      if (it.custo === "") return "sem custo";
      if (!Number.isFinite(Number(it.custo)) || Number(it.custo) < 0)
        return "com custo inválido";
    } else if (config.custoVisible) {
      // custo opcional mas, se preenchido, precisa ser válido
      if (it.custo !== "" && (!Number.isFinite(Number(it.custo)) || Number(it.custo) < 0))
        return "com custo inválido";
    }
    if (config.locObrigatoria && !it.locIdOverride) return "sem localização";
    return null;
  };
  const itensComProduto = itens.filter(temProduto);
  const itensValidos = itensComProduto.filter((it) => itemPendencia(it) === null);
  const itensConfirmaveis = itensValidos.filter((it) => Number(it.qty) > 0).length;
  const itensNaoVieram = itensValidos.length - itensConfirmaveis;

  // Pendências legíveis — a primeira aparece junto ao botão de confirmar.
  const pendencias: string[] = [];
  if (!galpaoId) pendencias.push("Falta: galpão");
  const extraResult = validarExtra ? validarExtra(itens) : true;
  if (Array.isArray(extraResult)) pendencias.push(...extraResult);
  else if (!extraResult)
    pendencias.push("Preencha os campos obrigatórios do formulário");
  itensComProduto.forEach((it) => {
    const p = itemPendencia(it);
    if (p) pendencias.push(`${it.produto?.sku ?? it.sku} ${p}`);
  });
  if (itensComProduto.length === 0)
    pendencias.push(
      itens.length > 0 ? "Escolha o produto do item" : "Adicione ao menos 1 item",
    );
  // o lote não pode ser todo qty 0 (todas as linhas "não veio")
  if (itensComProduto.length > 0 && !itens.some((it) => Number(it.qty) > 0))
    pendencias.push("Todas as linhas estão como “não veio”");
  // entrada direta exige loc só nas linhas que de fato vêm (qty>0); totaisPlano
  // já só conta linhas qty>0.
  if (entradaDireta && totaisPlano.semLoc > 0)
    pendencias.push(
      `${totaisPlano.semLoc} ${totaisPlano.semLoc > 1 ? "itens" : "item"} sem loc destino (entrada direta exige loc)`,
    );
  const valid = pendencias.length === 0;

  const confirmIdleLabel = `${config.confirmLabel ?? "Confirmar lote"} (${itensConfirmaveis}${
    itensNaoVieram > 0
      ? ` · ${itensNaoVieram} não ${itensNaoVieram === 1 ? "veio" : "vieram"}`
      : ""
  })`;

  // ── helpers de manipulação de itens (avulso) ─────────────────────────
  const updateItem = (idx: number, next: ReceberLoteItem) =>
    setItens((prev) => prev.map((x, i) => (i === idx ? next : x)));

  const removeItem = (idx: number) =>
    setItens((prev) =>
      prev.length === 1 ? [emptyReceberLoteItem()] : prev.filter((_, i) => i !== idx),
    );

  const addItem = () => setItens((p) => [...p, emptyReceberLoteItem()]);

  // Render: ordena por SKU e agrupa linhas consecutivas do mesmo SKU (OC gera
  // 1 linha por siso_pedido_item). Só visual — cada linha mantém seu input e
  // seu idx original (putaway/update/remove apontam pro estado real).
  const renderGroups = useMemo(() => {
    const entries = itens.map((it, idx) => ({
      it,
      idx,
      sku: it.produto?.sku ?? it.sku,
    }));
    const sorted = [...entries].sort((a, b) => {
      if (!a.sku && !b.sku) return a.idx - b.idx;
      if (!a.sku) return 1;
      if (!b.sku) return -1;
      return a.sku.localeCompare(b.sku) || a.idx - b.idx;
    });
    const groups: Array<{ sku: string; totalUn: number; entries: typeof sorted }> = [];
    sorted.forEach((e) => {
      const last = groups[groups.length - 1];
      if (last && e.sku && last.sku === e.sku) {
        last.entries.push(e);
        last.totalUn += Number(e.it.qty) || 0;
      } else {
        groups.push({ sku: e.sku, totalUn: Number(e.it.qty) || 0, entries: [e] });
      }
    });
    return groups;
  }, [itens]);

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
            <h3 className="wms-sec-h">
              {config.tituloConfiguracao ?? "Configuração do lote"}
            </h3>
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
          Itens (
          {itensValidos.length === itens.length
            ? itens.length
            : `${itensValidos.length} de ${itens.length} prontos`}
          )
        </h3>
        {(config.qtyEditable || config.custoVisible) && itens.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 11px",
              marginBottom: 4,
            }}
          >
            <span style={{ flex: 1 }} />
            <span
              className="wms-td-mute"
              style={{ width: 80, textAlign: "right", fontSize: 11 }}
            >
              {config.qtdColLabel ?? "Qtd recebida"}
            </span>
            {config.custoVisible && (
              <span
                className="wms-td-mute"
                style={{ width: 100, textAlign: "right", fontSize: 11 }}
              >
                Custo un.
              </span>
            )}
            {config.canAddItems && <span style={{ width: 24 }} />}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
          {renderGroups.map((grupo) => {
            const rows = grupo.entries.map((e) => {
              const row = (
                <ItemLoteRow
                  key={e.it.uid}
                  config={config}
                  item={e.it}
                  putaway={putawayQueries[e.idx]?.data}
                  isFetching={!!putawayQueries[e.idx]?.isFetching}
                  galpaoId={galpaoId}
                  locsById={locsById}
                  canResolve={!!galpaoId}
                  grouped={grupo.entries.length > 1}
                  onImageClick={onImageClick}
                  onChange={(next) => updateItem(e.idx, next)}
                  onRemove={() => removeItem(e.idx)}
                />
              );
              if (grupo.entries.length === 1) return row;
              return (
                <div
                  key={e.it.uid}
                  style={{ borderTop: "1px solid var(--wms-c-border)" }}
                >
                  {row}
                </div>
              );
            });
            if (grupo.entries.length === 1) return rows;
            return (
              <div
                key={`g-${grupo.sku}`}
                style={{
                  border: "1px solid var(--wms-c-border)",
                  borderRadius: "var(--wms-r-2)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 10px",
                    background: "var(--wms-c-faint)",
                    fontSize: 11,
                  }}
                >
                  <span className="wms-mono" style={{ fontWeight: 600 }}>
                    {grupo.sku}
                  </span>
                  <span className="wms-td-mute">
                    × {fmtNum(grupo.totalUn)} un ({grupo.entries.length} linhas)
                  </span>
                </div>
                {rows}
              </div>
            );
          })}
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
                      key={i.sku}
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
            {config.guardaTogglesVisible !== false && (
              <>
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
              </>
            )}
          </div>

          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid var(--wms-c-border)",
            }}
          >
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              style={{ width: "100%" }}
              disabled={!valid || submitMut.isPending || !podeReceber}
              title={!podeReceber ? "Sem permissão pra receber mercadoria" : ""}
              onClick={() => submitMut.mutate()}
            >
              <Icon name="check" size={11} />
              {submitMut.isPending ? "Enviando…" : confirmIdleLabel}
            </button>
            {!valid && !submitMut.isPending && pendencias[0] && (
              <div
                className="wms-td-mute"
                style={{ marginTop: 6, fontSize: 11, textAlign: "center" }}
              >
                {pendencias[0]}
              </div>
            )}
            {renderSidebarFooter && (
              <div style={{ marginTop: 10 }}>{renderSidebarFooter()}</div>
            )}
          </div>
        </aside>
      ) : (
        // Footer simples (fluxos sem plano-de-guarda)
        <div
          style={{
            marginTop: 16,
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 10,
          }}
        >
          {!valid && !submitMut.isPending && pendencias[0] && (
            <span className="wms-td-mute" style={{ fontSize: 11 }}>
              {pendencias[0]}
            </span>
          )}
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            disabled={!valid || submitMut.isPending || !podeReceber}
            title={!podeReceber ? "Sem permissão pra receber mercadoria" : ""}
            onClick={() => submitMut.mutate()}
          >
            <Icon name="check" size={11} />
            {submitMut.isPending ? "Enviando…" : confirmIdleLabel}
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
  grouped,
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
  /** linha dentro de um grupo visual de SKU repetido (sem borda própria) */
  grouped?: boolean;
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
  // Trava o produto por linha: ou o config não permite editar, ou a linha veio
  // do backend (OC/manual/transferência) — nesse caso o SKU é fixo.
  const productLocked = !config.productEditable || item.backendItemId != null;
  const divergiu =
    config.divergenciaVisible &&
    item.qtyEsperada != null &&
    Number(item.qty) !== item.qtyEsperada;
  const naoVeio = item.backendItemId != null && Number(item.qty) === 0;
  const custoFaltando =
    config.custoObrigatorio && temProduto && !naoVeio && item.custo === "";

  return (
    <div
      style={{
        background: "var(--wms-c-panel)",
        border: grouped ? "none" : "1px solid var(--wms-c-border)",
        borderRadius: grouped ? 0 : "var(--wms-r-2)",
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
          {!productLocked ? (
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
          item.qtyEsperada != null ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                gap: 2,
              }}
            >
              <input
                className="wms-input wms-mono wms-tar"
                type="number"
                min={item.backendItemId != null ? 0 : 1}
                value={item.qty}
                style={{ width: 80 }}
                onChange={(e) => onChange({ ...item, qty: e.target.value })}
                placeholder="qty"
              />
              {naoVeio ? (
                <span
                  className="wms-td-mute"
                  style={{ fontSize: 11, whiteSpace: "nowrap" }}
                >
                  não veio · fica pendente
                </span>
              ) : (
                <>
                  <span
                    className="wms-td-mute"
                    style={{ fontSize: 11, whiteSpace: "nowrap" }}
                  >
                    {item.qtyPedida != null &&
                    item.qtyJaRecebida != null &&
                    item.qtyJaRecebida > 0
                      ? `pedido ${fmtNum(item.qtyPedida)} · recebido ${fmtNum(item.qtyJaRecebida)} · falta ${fmtNum(item.qtyEsperada)}`
                      : `falta ${fmtNum(item.qtyEsperada)}`}
                  </span>
                  {item.backendItemId != null && (
                    <button
                      type="button"
                      className="wms-btn-link"
                      style={{ fontSize: 11 }}
                      onClick={() => onChange({ ...item, qty: "0" })}
                    >
                      não veio
                    </button>
                  )}
                </>
              )}
            </div>
          ) : (
            <input
              className="wms-input wms-mono wms-tar"
              type="number"
              min={item.backendItemId != null ? 0 : 1}
              value={item.qty}
              style={{ width: 80 }}
              onChange={(e) => onChange({ ...item, qty: e.target.value })}
              placeholder="qty"
            />
          )
        ) : (
          <span className="wms-mono wms-tar" style={{ width: 80, fontSize: 13 }}>
            {fmtNum(Number(item.qty))} un
          </span>
        )}
        {config.custoVisible && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: 2,
            }}
          >
            <div
              className="wms-input-prefix"
              style={{
                width: 100,
                ...(custoFaltando
                  ? { borderColor: "var(--wms-c-danger)" }
                  : {}),
              }}
            >
              <span>R$</span>
              <input
                className="wms-mono wms-tar"
                type="number"
                step="0.01"
                value={item.custo}
                style={{ minWidth: 0, fontSize: 13 }}
                placeholder="unit."
                title="Custo unitário"
                onChange={(e) => onChange({ ...item, custo: e.target.value })}
              />
            </div>
            {custoFaltando && (
              <span style={{ fontSize: 11, color: "var(--wms-c-danger)" }}>
                obrigatório
              </span>
            )}
          </div>
        )}
        {config.canAddItems && item.backendItemId == null ? (
          <button
            type="button"
            className="wms-btn-icon"
            title="Remover"
            onClick={onRemove}
          >
            <Icon name="trash" size={12} />
          </button>
        ) : config.canAddItems ? (
          <span style={{ width: 24, flexShrink: 0 }} />
        ) : null}
      </div>

      {config.divergenciaVisible && divergiu && (
        <div style={{ paddingLeft: 4 }}>
          <Field label="Motivo da divergência" hint="opcional">
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
                  <Icon name="sparkle" size={10} />{" "}
                  {stripRazaoLocSuffix(putaway.razao, locCodigoAtual)}
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
