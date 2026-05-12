"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Card,
  Icon,
  Pagination,
  StatusBadge,
  LocTipoBadge,
  fmtBRL,
  fmtDateTime,
  fmtNum,
  fmtRelative,
} from "@/components/wms/ui/wms-ui";
import { useWmsModals } from "@/components/wms/wms-shell";
import { ProdutoLightbox } from "@/components/wms/produto-lightbox";
import type { Produto, Movimentacao } from "@/lib/wms/types";
import type { LinhaCobertura } from "@/lib/wms/cobertura";
import type { UltimaContagemProduto } from "@/lib/wms/inventario";

type TabId =
  | "overview"
  | "estoque"
  | "movs"
  | "cobertura"
  | "fornec"
  | "kit"
  | "fotos";

interface EstoqueLinhaItem {
  saldo: number;
  reservado: number;
  disponivel: number;
  custo_medio: number;
  empresa: { id: string; nome: string };
  galpao: { id: string; nome: string };
  localizacao: { id: string; codigo: string; tipo: string };
}

interface EstoqueAgregadoProduto {
  chave: string;
  nome: string;
  saldo: number;
  reservado: number;
  disponivel: number;
  itens: EstoqueLinhaItem[];
}

interface MovComposite extends Movimentacao {
  produto?: { sku: string; descricao: string };
  empresa?: { nome: string };
  galpao?: { nome: string };
  localizacao?: { codigo: string };
}

export function ProdutoDrawer({
  produtoId,
  onClose,
}: {
  produtoId: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabId>("overview");
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  // Derive-during-render: reseta a paginação quando o produto muda
  // sem usar useEffect (padrão recomendado pelo React).
  const [movsPage, setMovsPage] = useState(1);
  const [movsPageFor, setMovsPageFor] = useState(produtoId);
  if (movsPageFor !== produtoId) {
    setMovsPageFor(produtoId);
    setMovsPage(1);
  }
  const MOVS_PAGE_SIZE = 100;
  const modals = useWmsModals();

  // ESC fecha
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const produtoQuery = useQuery({
    queryKey: ["wms-produto", produtoId],
    queryFn: () => wmsApi<Produto>(`/api/wms/produtos/${produtoId}`),
  });

  const estoqueQuery = useQuery({
    queryKey: ["wms-produto-estoque", produtoId],
    queryFn: () =>
      wmsApi<{ rows: EstoqueAgregadoProduto[] }>(
        `/api/wms/estoque?view=produto&produto_id=${produtoId}`,
      ),
  });

  const ledgerQuery = useQuery({
    queryKey: ["wms-produto-ledger", produtoId, movsPage],
    queryFn: () =>
      wmsApi<{ rows: MovComposite[]; total: number }>(
        `/api/wms/ledger?produto_id=${produtoId}&limit=${MOVS_PAGE_SIZE}&offset=${
          (movsPage - 1) * MOVS_PAGE_SIZE
        }`,
      ),
  });

  const coberturaQuery = useQuery({
    queryKey: ["wms-produto-cobertura", produtoId],
    queryFn: async () => {
      const all = await wmsApi<{ rows: LinhaCobertura[] }>(
        `/api/wms/cobertura`,
      );
      return all.rows.filter((r) => r.produto_id === produtoId);
    },
  });

  const ultimasContagensQuery = useQuery({
    queryKey: ["wms-produto-ultimas-contagens", produtoId],
    queryFn: () =>
      wmsApi<{ rows: UltimaContagemProduto[] }>(
        `/api/wms/produtos/${produtoId}/ultimas-contagens`,
      ),
  });

  const produto = produtoQuery.data;
  const agregado = estoqueQuery.data?.rows[0];
  const linhas = agregado?.itens ?? [];
  const movs = ledgerQuery.data?.rows ?? [];
  const movsTotal = ledgerQuery.data?.total ?? 0;
  const cobertura = coberturaQuery.data?.[0];
  const ultimasContagens = ultimasContagensQuery.data?.rows ?? [];

  const saldo = agregado ? Number(agregado.saldo) : 0;
  const reservado = agregado ? Number(agregado.reservado) : 0;
  const disponivel = agregado ? Number(agregado.disponivel) : 0;
  const custoMedio =
    saldo > 0
      ? linhas.reduce(
          (s, i) => s + Number(i.custo_medio) * Number(i.saldo),
          0,
        ) / saldo
      : 0;

  function openAction(
    kind: "receber" | "ajuste" | "transferir" | "realocar",
  ) {
    if (!produto) return;
    modals.open(kind, { produto });
  }

  const isLoading = produtoQuery.isLoading;

  return (
    <div className="wms-dw-overlay wms-dw-overlay-page" onClick={onClose}>
      <div className="wms-dw wms-dw-page" onClick={(e) => e.stopPropagation()}>
        {isLoading || !produto ? (
          <div className="wms-loading-pane">Carregando produto…</div>
        ) : (
          <>
            <div className="wms-pd-hd">
              <div className="wms-pd-hd-top">
                {produto.imagem_url && (
                  <img
                    src={produto.imagem_url}
                    alt=""
                    loading="lazy"
                    className="wms-thumb wms-thumb-lg wms-thumb-click"
                    style={{ marginRight: 14 }}
                    onClick={() => setLightboxIdx(0)}
                  />
                )}
                <div className="wms-pd-hd-info">
                  <div className="wms-pd-hd-sku">{produto.sku}</div>
                  <h2>{produto.descricao}</h2>
                  <div className="wms-pd-hd-meta">
                    {produto.gtin && (
                      <span>
                        <Icon name="tag" size={11} /> GTIN {produto.gtin}
                      </span>
                    )}
                    {produto.ncm && (
                      <span className="wms-mono">NCM {produto.ncm}</span>
                    )}
                    <span>Unidade {produto.unidade}</span>
                    {cobertura && (
                      <StatusBadge status={cobertura.status_cobertura} />
                    )}
                  </div>
                </div>
                <div className="wms-pd-hd-actions">
                  <button
                    className="wms-btn wms-btn-sm wms-btn-ghost"
                    onClick={() => openAction("receber")}
                  >
                    <Icon name="plus" size={11} />
                    Entrada
                  </button>
                  <button
                    className="wms-btn wms-btn-sm wms-btn-ghost"
                    onClick={() => openAction("ajuste")}
                  >
                    <Icon name="minus" size={11} />
                    Saída/ajuste
                  </button>
                  <button
                    className="wms-btn wms-btn-sm wms-btn-ghost"
                    onClick={() => openAction("transferir")}
                  >
                    <Icon name="arrow-right" size={11} />
                    Transferir
                  </button>
                  <button
                    className="wms-btn wms-btn-sm wms-btn-ghost"
                    onClick={() => openAction("realocar")}
                  >
                    <Icon name="shuffle" size={11} />
                    Realocar
                  </button>
                  <button
                    className="wms-btn-icon wms-btn-icon-lg"
                    onClick={onClose}
                    aria-label="Fechar"
                  >
                    <Icon name="x" />
                  </button>
                </div>
              </div>
              <div className="wms-pd-summary">
                <div className="wms-pd-sum">
                  <div className="wms-pd-sum-lbl">Físico</div>
                  <div className="wms-pd-sum-val wms-mono">
                    {fmtNum(saldo)}
                  </div>
                </div>
                <div className="wms-pd-sum">
                  <div className="wms-pd-sum-lbl">Reservado</div>
                  <div className="wms-pd-sum-val wms-mono wms-td-warn">
                    {fmtNum(reservado)}
                  </div>
                </div>
                <div className="wms-pd-sum wms-pd-sum-strong">
                  <div className="wms-pd-sum-lbl">Disponível</div>
                  <div className="wms-pd-sum-val wms-mono">
                    {fmtNum(disponivel)}
                  </div>
                </div>
                <div className="wms-pd-sum">
                  <div className="wms-pd-sum-lbl">Localizações</div>
                  <div className="wms-pd-sum-val wms-mono">{linhas.length}</div>
                </div>
                <div className="wms-pd-sum">
                  <div className="wms-pd-sum-lbl">Giro/dia</div>
                  <div className="wms-pd-sum-val wms-mono">
                    {cobertura ? Number(cobertura.giro_diario).toFixed(2) : "—"}
                  </div>
                </div>
                <div className="wms-pd-sum">
                  <div className="wms-pd-sum-lbl">Cobertura</div>
                  <div className="wms-pd-sum-val wms-mono">
                    {cobertura?.dias_cobertura != null
                      ? `${Number(cobertura.dias_cobertura).toFixed(0)}d`
                      : "—"}
                  </div>
                </div>
                <div className="wms-pd-sum">
                  <div className="wms-pd-sum-lbl">Valor estoque</div>
                  <div className="wms-pd-sum-val wms-mono">
                    {fmtBRL(saldo * custoMedio)}
                  </div>
                </div>
              </div>

              <div className="wms-pd-tabs">
                {(
                  [
                    { id: "overview", label: "Visão geral" },
                    {
                      id: "estoque",
                      label: produto.eh_kit
                        ? "Estoque (derivado)"
                        : "Estoque por local",
                      count: produto.eh_kit ? undefined : linhas.length,
                    },
                    { id: "movs", label: "Movimentações", count: movs.length },
                    { id: "cobertura", label: "Cobertura" },
                    { id: "fornec", label: "Fornecedores" },
                    {
                      id: "kit",
                      label: produto.eh_kit ? "Composição" : "Kit",
                    },
                    {
                      id: "fotos",
                      label: "Fotos",
                      count: produto.imagens?.length ?? 0,
                    },
                  ] as { id: TabId; label: string; count?: number }[]
                ).map((t) => (
                  <button
                    key={t.id}
                    className={`wms-pd-tab ${tab === t.id ? "is-active" : ""}`}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                    {t.count != null && (
                      <span className="wms-pd-tab-count">{t.count}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="wms-pd-body">
              {tab === "overview" && (
                <Overview
                  produto={produto}
                  linhas={linhas}
                  movs={movs}
                  cobertura={cobertura}
                  custoMedio={custoMedio}
                  reservado={reservado}
                  onTab={setTab}
                />
              )}
              {tab === "estoque" && (
                <EstoquePorLocal
                  linhas={linhas}
                  onAction={openAction}
                />
              )}
              {tab === "movs" && (
                <Movimentacoes
                  movs={movs}
                  contagens={ultimasContagens}
                  total={movsTotal}
                  pageSize={MOVS_PAGE_SIZE}
                  page={movsPage}
                  onPageChange={setMovsPage}
                />
              )}
              {tab === "cobertura" && <Cobertura c={cobertura} />}
              {tab === "fornec" && <Fornecedores produto={produto} />}
              {tab === "kit" && <KitTab produto={produto} />}
              {tab === "fotos" && (
                <Fotos
                  imagens={produto.imagens ?? []}
                  onOpen={(i) => setLightboxIdx(i)}
                />
              )}
            </div>
          </>
        )}
      </div>
      {lightboxIdx !== null && produto && (produto.imagens?.length ?? 0) > 0 && (
        <ProdutoLightbox
          imagens={produto.imagens}
          initialIndex={lightboxIdx}
          sku={produto.sku}
          descricao={produto.descricao}
          onClose={() => setLightboxIdx(null)}
        />
      )}
    </div>
  );
}

function Fotos({
  imagens,
  onOpen,
}: {
  imagens: string[];
  onOpen: (i: number) => void;
}) {
  if (imagens.length === 0) {
    return (
      <div className="wms-exp-empty" style={{ padding: 24 }}>
        Sem fotos cadastradas. As fotos vêm dos anexos do produto no Tiny —
        rode &quot;Sincronizar com Tiny&quot; pra atualizar.
      </div>
    );
  }
  return (
    <div className="wms-photos-grid">
      {imagens.map((src, i) => (
        <button
          key={src + i}
          type="button"
          className="wms-photo-tile"
          onClick={() => onOpen(i)}
          aria-label={`Abrir foto ${i + 1}`}
        >
          <img src={src} alt="" loading="lazy" />
          <span className="wms-photo-tile-idx">{i + 1}</span>
        </button>
      ))}
    </div>
  );
}

function Overview({
  produto,
  linhas,
  movs,
  cobertura,
  custoMedio,
  reservado,
  onTab,
}: {
  produto: Produto;
  linhas: EstoqueLinhaItem[];
  movs: MovComposite[];
  cobertura?: LinhaCobertura;
  custoMedio: number;
  reservado: number;
  onTab: (t: TabId) => void;
}) {
  const todas = [...linhas].sort(
    (a, b) => Number(b.saldo) - Number(a.saldo),
  );
  return (
    <div className="wms-ov-grid">
      <Card
        title="Localização"
        actions={
          <button className="wms-btn-link" onClick={() => onTab("estoque")}>
            Ver detalhes →
          </button>
        }
      >
        {todas.length === 0 && (
          <div className="wms-exp-empty">Sem estoque registrado.</div>
        )}
        {todas.map((l, i) => (
          <div className="wms-ov-loc" key={i}>
            <div className="wms-ov-loc-where">
              <span className="wms-chip-emp">
                {l.empresa.nome.slice(0, 3).toUpperCase()}
              </span>
              <span className="wms-td-mute">{l.galpao.nome}</span>
              <span className="wms-mono">/ {l.localizacao.codigo}</span>
            </div>
            <div className="wms-ov-loc-stock">
              <span className="wms-mono">
                {fmtNum(Number(l.disponivel))}
                <span className="wms-td-mute">
                  {" "}
                  / {fmtNum(Number(l.saldo))}
                </span>
              </span>
            </div>
          </div>
        ))}
      </Card>
      <Card
        title="Atividade recente"
        actions={
          <button className="wms-btn-link" onClick={() => onTab("movs")}>
            Histórico completo →
          </button>
        }
      >
        {movs.length === 0 && (
          <div className="wms-exp-empty">Sem movimentações.</div>
        )}
        {movs.slice(0, 4).map((m) => (
          <LedgerMini key={m.id} m={m} />
        ))}
      </Card>
      <Card title="Saúde do estoque">
        <div className="wms-ov-health-row">
          <span>Status de cobertura</span>
          <StatusBadge status={cobertura?.status_cobertura ?? "sem_giro"} />
        </div>
        <div className="wms-ov-health-row">
          <span>Cobertura atual</span>
          <span className="wms-mono">
            {cobertura?.dias_cobertura != null
              ? `${Number(cobertura.dias_cobertura).toFixed(0)}d`
              : "—"}
          </span>
        </div>
        <div className="wms-ov-health-row">
          <span>Giro 30d</span>
          <span className="wms-mono">
            {cobertura
              ? `${(Number(cobertura.giro_diario) * 30).toFixed(0)} un`
              : "—"}
          </span>
        </div>
        <div className="wms-ov-health-row">
          <span>Reservas ativas</span>
          <span className="wms-mono wms-td-warn">{fmtNum(reservado)}</span>
        </div>
      </Card>
      <Card title="Fiscal & catálogo">
        <div className="wms-ov-meta-grid">
          <div>
            <div className="wms-ov-meta-lbl">SKU</div>
            <div className="wms-mono">{produto.sku}</div>
          </div>
          <div>
            <div className="wms-ov-meta-lbl">NCM</div>
            <div className="wms-mono">{produto.ncm ?? "—"}</div>
          </div>
          <div>
            <div className="wms-ov-meta-lbl">Custo médio</div>
            <div className="wms-mono">{fmtBRL(custoMedio)}</div>
          </div>
          <div>
            <div className="wms-ov-meta-lbl">Unidade</div>
            <div className="wms-mono">{produto.unidade}</div>
          </div>
          <div>
            <div className="wms-ov-meta-lbl">GTIN</div>
            <div className="wms-mono">{produto.gtin ?? "—"}</div>
          </div>
          <div>
            <div className="wms-ov-meta-lbl">Sincronizado</div>
            <div className="wms-td-mute">
              {produto.sincronizado_em
                ? fmtRelative(produto.sincronizado_em)
                : "nunca"}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function EstoquePorLocal({
  linhas,
  onAction,
}: {
  linhas: EstoqueLinhaItem[];
  onAction: (k: "ajuste" | "transferir") => void;
}) {
  if (linhas.length === 0) {
    return (
      <div className="wms-exp-empty" style={{ padding: 24 }}>
        Sem estoque em nenhuma localização.
      </div>
    );
  }
  return (
    <table className="wms-full-tbl">
      <thead>
        <tr>
          <th>Empresa</th>
          <th>Galpão</th>
          <th>Localização</th>
          <th>Tipo</th>
          <th className="wms-tar">Saldo</th>
          <th className="wms-tar">Reservado</th>
          <th className="wms-tar">Disponível</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {linhas.map((l, idx) => (
          <tr key={idx}>
            <td>
              <span className="wms-chip-emp">
                {l.empresa.nome.slice(0, 3).toUpperCase()}
              </span>{" "}
              <span className="wms-td-mute">{l.empresa.nome}</span>
            </td>
            <td>{l.galpao.nome}</td>
            <td>
              <span className="wms-mono">{l.localizacao.codigo}</span>
            </td>
            <td>
              <LocTipoBadge tipo={l.localizacao.tipo} />
            </td>
            <td className="wms-tar wms-mono">{fmtNum(Number(l.saldo))}</td>
            <td className="wms-tar wms-mono wms-td-warn">
              {Number(l.reservado) > 0 ? fmtNum(Number(l.reservado)) : "—"}
            </td>
            <td className="wms-tar wms-mono wms-td-strong">
              {fmtNum(Number(l.disponivel))}
            </td>
            <td className="wms-td-actions">
              <button
                className="wms-btn-icon"
                onClick={() => onAction("ajuste")}
                title="Saída/ajuste"
              >
                <Icon name="minus" size={11} />
              </button>
              <button
                className="wms-btn-icon"
                onClick={() => onAction("transferir")}
                title="Transferir"
              >
                <Icon name="arrow-right" size={11} />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Movimentacoes({
  movs,
  contagens,
  total,
  pageSize,
  page,
  onPageChange,
}: {
  movs: MovComposite[];
  contagens: UltimaContagemProduto[];
  total: number;
  pageSize: number;
  page: number;
  onPageChange: (p: number) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ContagensInventario contagens={contagens} />
      {movs.length === 0 ? (
        <div className="wms-exp-empty" style={{ padding: 24 }}>
          Sem movimentações no ledger.
        </div>
      ) : (
        <>
          <div className="wms-ledger-list">
            {movs.map((m) => (
              <LedgerRow key={m.id} m={m} />
            ))}
          </div>
          <Pagination
            total={total}
            pageSize={pageSize}
            page={page}
            onPageChange={onPageChange}
            label="movimentações"
          />
        </>
      )}
    </div>
  );
}

function ContagensInventario({
  contagens,
}: {
  contagens: UltimaContagemProduto[];
}) {
  if (contagens.length === 0) {
    return (
      <Card title="Conferências de inventário">
        <div className="wms-exp-empty">
          Este produto ainda não foi contado em nenhuma sessão de inventário.
        </div>
      </Card>
    );
  }
  const ultima = contagens[0]; // RPC já ordena por contada_em DESC
  return (
    <Card
      title="Conferências de inventário"
      actions={
        <span className="wms-td-mute" style={{ fontSize: 12 }}>
          Última: {fmtRelative(ultima.contada_em)}
        </span>
      }
    >
      <div
        style={{ display: "flex", flexDirection: "column", gap: 0 }}
      >
        {contagens.map((c) => (
          <ContagemRow
            key={`${c.localizacao_id}-${c.empresa_dona_id}`}
            c={c}
          />
        ))}
      </div>
    </Card>
  );
}

function ContagemRow({ c }: { c: UltimaContagemProduto }) {
  const conferido = Number(c.qty_contada);
  const atual = Number(c.saldo_atual);
  const divergiu = conferido !== atual;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 0",
        borderBottom: "1px solid var(--wms-c-border)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
          flex: 1,
        }}
      >
        <span className="wms-chip-emp">
          {c.empresa_nome.slice(0, 3).toUpperCase()}
        </span>
        <span className="wms-td-mute" style={{ fontSize: 12 }}>
          {c.galpao_nome}
        </span>
        <span className="wms-mono" style={{ fontSize: 13 }}>
          / {c.loc_codigo}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 2,
          fontSize: 12,
        }}
      >
        <div className="wms-mono">
          {fmtNum(conferido)} bipado
          {divergiu && (
            <span className="wms-td-mute"> · atual {fmtNum(atual)}</span>
          )}
        </div>
        <div className="wms-td-mute" style={{ fontSize: 11 }}>
          {c.contada_por_nome ?? "—"} · {fmtRelative(c.contada_em)}
        </div>
      </div>
    </div>
  );
}

function Cobertura({ c }: { c?: LinhaCobertura }) {
  if (!c) {
    return (
      <div className="wms-exp-empty" style={{ padding: 24 }}>
        Sem dados de cobertura para este produto.
      </div>
    );
  }
  const dias = Number(c.dias_cobertura ?? 0);
  const lead = Number(c.lead_time_medio ?? 0);
  return (
    <div className="wms-cob-tab">
      <div className="wms-cob-stats">
        <div className="wms-cob-stat">
          <div className="wms-cob-stat-lbl">Cobertura atual</div>
          <div className="wms-cob-stat-val wms-mono">
            {dias.toFixed(0)} <small>dias</small>
          </div>
        </div>
        <div className="wms-cob-stat">
          <div className="wms-cob-stat-lbl">Lead time</div>
          <div className="wms-cob-stat-val wms-mono">
            {lead || "—"} <small>dias</small>
          </div>
        </div>
        <div className="wms-cob-stat">
          <div className="wms-cob-stat-lbl">Giro 30d</div>
          <div className="wms-cob-stat-val wms-mono">
            {(Number(c.giro_diario) * 30).toFixed(0)} <small>un.</small>
          </div>
        </div>
        <div className="wms-cob-stat">
          <div className="wms-cob-stat-lbl">Status</div>
          <div className="wms-cob-stat-val">
            <StatusBadge status={c.status_cobertura} size="lg" />
          </div>
        </div>
      </div>
      <div className="wms-cob-help">
        {c.status_cobertura === "critico" && (
          <p>
            <strong>Cobertura crítica.</strong> Estoque cobre menos do que o
            lead time — risco de stockout. Considere abrir pedido de compra
            ou empréstimo entre empresas.
          </p>
        )}
        {c.status_cobertura === "atencao" && (
          <p>
            <strong>Atenção.</strong> Cobertura próxima do lead time. Hora de
            programar reposição.
          </p>
        )}
        {c.status_cobertura === "ok" && (
          <p>Cobertura saudável — acima do lead time.</p>
        )}
        {c.status_cobertura === "sem_giro" && (
          <p>Sem vendas nos últimos 30 dias. Avalie liquidação ou redistribuição.</p>
        )}
        {c.status_cobertura === "lead_time_risco" && (
          <p>
            Sem fornecedor preferencial cadastrado — não conseguimos calcular
            lead time real.
          </p>
        )}
      </div>
    </div>
  );
}

interface FornecRow {
  id: string;
  fornecedor_id: string;
  preferencial: boolean;
  lead_time_dias_medio: number | null;
  custo_unitario: number | null;
  qty_minima_pedido: number | null;
  multiplo_compra: number | null;
  codigo_fornecedor: string | null;
  ativo: boolean;
  fornecedor: {
    id: string;
    nome: string;
    cnpj: string | null;
    prefixo_sku: string | null;
  } | null;
}

interface FornecedorLite {
  id: string;
  nome: string;
  prefixo_sku: string | null;
}

function Fornecedores({ produto }: { produto: Produto }) {
  const qc = useQueryClient();
  const fornecQuery = useQuery({
    queryKey: ["wms-produto-fornecedores", produto.id],
    queryFn: () =>
      wmsApi<{ rows: FornecRow[] }>(
        `/api/wms/produto-fornecedores?produto_id=${produto.id}`,
      ),
  });
  const todosFornecQuery = useQuery({
    queryKey: ["wms-fornecedores-all"],
    queryFn: () => wmsApi<FornecedorLite[]>(`/api/wms/fornecedores`),
  });
  const rows = fornecQuery.data?.rows ?? [];
  const todos = todosFornecQuery.data ?? [];
  const jaVinculados = new Set(rows.map((r) => r.fornecedor_id));
  const disponiveis = todos.filter((f) => !jaVinculados.has(f.id));

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["wms-produto-fornecedores", produto.id] });

  const adicionar = useMutation({
    mutationFn: (input: {
      fornecedor_id: string;
      codigo_fornecedor: string | null;
      custo_unitario: number | null;
    }) =>
      wmsApi(`/api/wms/produto-fornecedores`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          produto_id: produto.id,
          fornecedor_id: input.fornecedor_id,
          codigo_fornecedor: input.codigo_fornecedor,
          custo_unitario: input.custo_unitario,
          preferencial: rows.length === 0,
        }),
      }),
    onSuccess: () => {
      toast.success("Fornecedor vinculado");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const atualizar = useMutation({
    mutationFn: (input: {
      id: string;
      patch: Partial<{
        codigo_fornecedor: string | null;
        custo_unitario: number | null;
        qty_minima_pedido: number | null;
        multiplo_compra: number | null;
        lead_time_dias_medio: number;
        preferencial: boolean;
      }>;
    }) =>
      wmsApi(`/api/wms/produto-fornecedores/${input.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input.patch),
      }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  const remover = useMutation({
    mutationFn: (id: string) =>
      wmsApi(`/api/wms/produto-fornecedores/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Fornecedor removido");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <AdicionarFornecedorForm
        disponiveis={disponiveis}
        loading={adicionar.isPending}
        onSubmit={(input) => adicionar.mutate(input)}
      />

      {fornecQuery.isLoading ? (
        <div className="wms-loading-pane">Carregando fornecedores…</div>
      ) : rows.length === 0 ? (
        <div className="wms-exp-empty">
          Nenhum fornecedor vinculado. Use o formulário acima pra adicionar.
        </div>
      ) : (
        rows.map((f) => (
          <FornecedorEditCard
            key={f.id}
            row={f}
            onPatch={(patch) => atualizar.mutate({ id: f.id, patch })}
            onRemove={() => {
              if (confirm(`Remover fornecedor ${f.fornecedor?.nome}?`)) {
                remover.mutate(f.id);
              }
            }}
          />
        ))
      )}
    </div>
  );
}

function AdicionarFornecedorForm({
  disponiveis,
  loading,
  onSubmit,
}: {
  disponiveis: FornecedorLite[];
  loading: boolean;
  onSubmit: (input: {
    fornecedor_id: string;
    codigo_fornecedor: string | null;
    custo_unitario: number | null;
  }) => void;
}) {
  const [fornecedorId, setFornecedorId] = useState("");
  const [codigo, setCodigo] = useState("");
  const [custo, setCusto] = useState("");

  const submit = () => {
    if (!fornecedorId) {
      toast.error("Escolha um fornecedor");
      return;
    }
    onSubmit({
      fornecedor_id: fornecedorId,
      codigo_fornecedor: codigo.trim() || null,
      custo_unitario: custo.trim() ? parseFloat(custo) : null,
    });
    setFornecedorId("");
    setCodigo("");
    setCusto("");
  };

  return (
    <Card title="Adicionar fornecedor">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 120px auto",
          gap: 8,
          alignItems: "end",
        }}
      >
        <div>
          <div className="wms-ov-meta-lbl">Fornecedor</div>
          <select
            className="wms-input"
            value={fornecedorId}
            onChange={(e) => setFornecedorId(e.target.value)}
          >
            <option value="">— selecione —</option>
            {disponiveis.map((f) => (
              <option key={f.id} value={f.id}>
                {f.nome}
                {f.prefixo_sku ? ` (${f.prefixo_sku})` : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className="wms-ov-meta-lbl">Código do produto no fornecedor</div>
          <input
            className="wms-input wms-mono"
            placeholder="ex.: ABC-123"
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
          />
        </div>
        <div>
          <div className="wms-ov-meta-lbl">Custo (R$)</div>
          <input
            className="wms-input wms-mono"
            placeholder="0,00"
            inputMode="decimal"
            value={custo}
            onChange={(e) => setCusto(e.target.value.replace(",", "."))}
          />
        </div>
        <button
          className="wms-btn wms-btn-sm"
          onClick={submit}
          disabled={loading || !fornecedorId}
        >
          <Icon name="plus" size={11} /> Vincular
        </button>
      </div>
    </Card>
  );
}

function FornecedorEditCard({
  row,
  onPatch,
  onRemove,
}: {
  row: FornecRow;
  onPatch: (
    patch: Partial<{
      codigo_fornecedor: string | null;
      custo_unitario: number | null;
      qty_minima_pedido: number | null;
      multiplo_compra: number | null;
      lead_time_dias_medio: number;
      preferencial: boolean;
    }>,
  ) => void;
  onRemove: () => void;
}) {
  return (
    <div
      className="wms-card"
      style={{
        border: row.preferencial
          ? "1px solid var(--wms-c-fg)"
          : "1px solid var(--wms-c-border)",
      }}
    >
      <div className="wms-card-h">
        <div>
          {row.preferencial && (
            <div
              style={{
                fontSize: 10.5,
                textTransform: "uppercase",
                letterSpacing: ".06em",
                color: "var(--wms-c-mute)",
                fontWeight: 600,
              }}
            >
              Fornecedor preferencial
            </div>
          )}
          <h3>{row.fornecedor?.nome ?? "(fornecedor removido)"}</h3>
          {row.fornecedor?.prefixo_sku && (
            <div className="wms-td-mute" style={{ fontSize: 12 }}>
              Prefixo SKU{" "}
              <span className="wms-mono">{row.fornecedor.prefixo_sku}</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!row.preferencial && (
            <button
              className="wms-btn wms-btn-sm wms-btn-ghost"
              onClick={() => onPatch({ preferencial: true })}
              title="Marcar como preferencial"
            >
              <Icon name="check" size={11} /> Tornar preferencial
            </button>
          )}
          <button
            className="wms-btn-icon"
            onClick={onRemove}
            title="Remover fornecedor"
          >
            <Icon name="x" size={11} />
          </button>
        </div>
      </div>
      <div className="wms-card-body">
        <div className="wms-ov-meta-grid">
          <CampoEdit
            label="Código no fornecedor"
            value={row.codigo_fornecedor}
            onSave={(v) => onPatch({ codigo_fornecedor: v || null })}
            mono
            placeholder="—"
          />
          <CampoEdit
            label="Custo unitário"
            value={row.custo_unitario != null ? String(row.custo_unitario) : ""}
            onSave={(v) =>
              onPatch({
                custo_unitario: v.trim()
                  ? parseFloat(v.replace(",", "."))
                  : null,
              })
            }
            mono
            placeholder="0,00"
            display={
              row.custo_unitario != null ? fmtBRL(row.custo_unitario) : "—"
            }
          />
          <CampoEdit
            label="Lead time (dias)"
            value={
              row.lead_time_dias_medio != null
                ? String(row.lead_time_dias_medio)
                : ""
            }
            onSave={(v) => {
              const n = parseInt(v, 10);
              if (Number.isFinite(n) && n >= 0) {
                onPatch({ lead_time_dias_medio: n });
              }
            }}
            mono
            placeholder="14"
          />
          <CampoEdit
            label="Qty mínima"
            value={
              row.qty_minima_pedido != null
                ? String(row.qty_minima_pedido)
                : ""
            }
            onSave={(v) =>
              onPatch({
                qty_minima_pedido: v.trim()
                  ? parseFloat(v.replace(",", "."))
                  : null,
              })
            }
            mono
            placeholder="1"
          />
          <CampoEdit
            label="Múltiplo de compra"
            value={
              row.multiplo_compra != null ? String(row.multiplo_compra) : ""
            }
            onSave={(v) =>
              onPatch({
                multiplo_compra: v.trim()
                  ? parseFloat(v.replace(",", "."))
                  : null,
              })
            }
            mono
            placeholder="1"
          />
          <div>
            <div className="wms-ov-meta-lbl">CNPJ</div>
            <div className="wms-mono">{row.fornecedor?.cnpj ?? "—"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Campo inline editável — clica pra editar, blur/Enter pra salvar. */
function CampoEdit({
  label,
  value,
  onSave,
  mono,
  placeholder,
  display,
}: {
  label: string;
  value: string | null;
  onSave: (v: string) => void;
  mono?: boolean;
  placeholder?: string;
  display?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState(value ?? "");
  // Derive-during-render: sincroniza estado interno quando a prop muda externa
  // (ex: invalidate da query) sem cascading renders via useEffect.
  const [valueFor, setValueFor] = useState(value);
  if (valueFor !== value) {
    setValueFor(value);
    setLocal(value ?? "");
  }
  const cssMono = mono ? " wms-mono" : "";
  return (
    <div>
      <div className="wms-ov-meta-lbl">{label}</div>
      {editing ? (
        <input
          autoFocus
          className={`wms-input${cssMono}`}
          value={local}
          placeholder={placeholder}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (local !== (value ?? "")) onSave(local);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setLocal(value ?? "");
              setEditing(false);
            }
          }}
        />
      ) : (
        <div
          className={`wms${cssMono} wms-link-row`}
          onClick={() => setEditing(true)}
          style={{ cursor: "pointer" }}
          title="Clique pra editar"
        >
          {display ?? value ?? placeholder ?? "—"}
        </div>
      )}
    </div>
  );
}

// ── KIT TAB ───────────────────────────────────────────────────────────────

interface KitComposicaoRow {
  id: string;
  componente_produto_id: string;
  quantidade: number;
  componente: {
    id: string;
    sku: string;
    descricao: string;
    imagem_url: string | null;
    ativo: boolean;
  };
  estoque: {
    disponivel_total: number;
    saldo_total: number;
    reservado_total: number;
    posicoes: Array<{
      empresa: { id: string; nome: string };
      galpao: { id: string; nome: string };
      localizacao: { id: string; codigo: string };
      saldo: number;
      reservado: number;
      disponivel: number;
    }>;
  };
}

interface KitDisponivelInfo {
  disponivel: number;
  gargalo_sku: string | null;
  gargalo_disponivel: number | null;
}

function KitTab({ produto }: { produto: Produto }) {
  const qc = useQueryClient();
  const kitQuery = useQuery({
    queryKey: ["wms-produto-kit", produto.id],
    queryFn: () =>
      wmsApi<{
        composicao: KitComposicaoRow[];
        disponivel: KitDisponivelInfo;
      }>(`/api/wms/produtos/${produto.id}/kit`),
  });

  const upsert = useMutation({
    mutationFn: (input: {
      componente_produto_id: string;
      quantidade: number;
    }) =>
      wmsApi(`/api/wms/produtos/${produto.id}/kit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      toast.success("Componente atualizado");
      qc.invalidateQueries({ queryKey: ["wms-produto-kit", produto.id] });
      qc.invalidateQueries({ queryKey: ["wms-produto", produto.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remover = useMutation({
    mutationFn: (componente_id: string) =>
      wmsApi(
        `/api/wms/produtos/${produto.id}/kit?componente_id=${componente_id}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-produto-kit", produto.id] });
      qc.invalidateQueries({ queryKey: ["wms-produto", produto.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const composicao = kitQuery.data?.composicao ?? [];
  const disp = kitQuery.data?.disponivel;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card title="Composição do kit">
        <p className="wms-td-mute" style={{ fontSize: 13, marginTop: 0 }}>
          Kits são SKUs virtuais — o estoque é derivado da quantidade dos
          componentes. Não é possível dar entrada direta de saldo num kit.
        </p>
        <AdicionarComponenteForm
          jaVinculados={new Set(composicao.map((c) => c.componente_produto_id))}
          kitId={produto.id}
          loading={upsert.isPending}
          onSubmit={upsert.mutate}
        />
      </Card>

      {produto.eh_kit && disp && (
        <Card title="Estoque derivado">
          <div className="wms-ov-meta-grid">
            <div>
              <div className="wms-ov-meta-lbl">Disponível (kits)</div>
              <div
                className="wms-mono"
                style={{ fontSize: 20, fontWeight: 700 }}
              >
                {fmtNum(disp.disponivel)}
              </div>
            </div>
            <div>
              <div className="wms-ov-meta-lbl">Gargalo</div>
              <div className="wms-mono">{disp.gargalo_sku ?? "—"}</div>
              {disp.gargalo_disponivel != null && (
                <div className="wms-td-mute" style={{ fontSize: 12 }}>
                  {fmtNum(disp.gargalo_disponivel)} un. do gargalo no estoque
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {kitQuery.isLoading ? (
        <div className="wms-loading-pane">Carregando composição…</div>
      ) : composicao.length === 0 ? (
        <div className="wms-exp-empty">
          {produto.eh_kit
            ? "Kit sem componentes — adicione acima pra começar."
            : "Este SKU ainda não é um kit. Ao adicionar o primeiro componente, ele vira automaticamente um kit."}
        </div>
      ) : (
        <table className="wms-full-tbl">
          <thead>
            <tr>
              <th style={{ width: 36 }}></th>
              <th>SKU</th>
              <th>Componente</th>
              <th style={{ width: 260 }}>Estoque · Localização</th>
              <th className="wms-tar" style={{ width: 120 }}>
                Qty/kit
              </th>
              <th style={{ width: 48 }}></th>
            </tr>
          </thead>
          <tbody>
            {composicao.map((c) => (
              <ComponenteRow
                key={c.id}
                row={c}
                kitId={produto.id}
                onQtyChange={(qty) =>
                  upsert.mutate({
                    componente_produto_id: c.componente_produto_id,
                    quantidade: qty,
                  })
                }
                onRemove={() => {
                  if (
                    confirm(`Remover ${c.componente.sku} da composição do kit?`)
                  ) {
                    remover.mutate(c.componente_produto_id);
                  }
                }}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AdicionarComponenteForm({
  jaVinculados,
  kitId,
  loading,
  onSubmit,
}: {
  jaVinculados: Set<string>;
  kitId: string;
  loading: boolean;
  onSubmit: (input: {
    componente_produto_id: string;
    quantidade: number;
  }) => void;
}) {
  const [q, setQ] = useState("");
  const [selecionado, setSelecionado] = useState<{
    id: string;
    sku: string;
    descricao: string;
  } | null>(null);
  const [qty, setQty] = useState("1");
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  const [dropdownRect, setDropdownRect] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const buscaQuery = useQuery({
    queryKey: ["wms-produtos-busca-componente", q],
    queryFn: () =>
      wmsApi<{
        rows: Array<{ id: string; sku: string; descricao: string; eh_kit: boolean }>;
      }>(
        `/api/wms/produtos?q=${encodeURIComponent(q)}&limit=10&offset=0`,
      ),
    enabled: q.length >= 2 && !selecionado,
  });

  const submit = () => {
    if (!selecionado) return;
    const n = parseFloat(qty.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Quantidade inválida");
      return;
    }
    onSubmit({ componente_produto_id: selecionado.id, quantidade: n });
    setSelecionado(null);
    setQ("");
    setQty("1");
  };

  const candidatos = (buscaQuery.data?.rows ?? []).filter(
    (p) => p.id !== kitId && !jaVinculados.has(p.id) && !p.eh_kit,
  );

  const showDropdown = !selecionado && q.length >= 2 && candidatos.length > 0;

  useLayoutEffect(() => {
    if (!showDropdown) return;
    const update = () => {
      const el = inputWrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setDropdownRect({ top: r.bottom + 2, left: r.left, width: r.width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [showDropdown, candidatos.length]);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 100px auto",
        gap: 8,
        alignItems: "end",
      }}
    >
      <div ref={inputWrapRef} style={{ position: "relative" }}>
        <div className="wms-ov-meta-lbl">Buscar componente (SKU ou nome)</div>
        {selecionado ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              border: "1px solid var(--wms-c-border)",
              borderRadius: 4,
            }}
          >
            <span className="wms-mono">{selecionado.sku}</span>
            <span className="wms-td-mute" style={{ flex: 1 }}>
              {selecionado.descricao}
            </span>
            <button
              className="wms-btn-icon"
              onClick={() => setSelecionado(null)}
              title="Limpar seleção"
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        ) : (
          <input
            className="wms-input"
            placeholder="SKU ou descrição…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        )}
        {showDropdown &&
          dropdownRect &&
          typeof document !== "undefined" &&
          createPortal(
            <div className="wms-root" style={{ display: "contents" }}>
              <div
                className="wms-picker-list"
                style={{
                  position: "fixed",
                  top: dropdownRect.top,
                  left: dropdownRect.left,
                  width: dropdownRect.width,
                  zIndex: 9999,
                }}
              >
                {candidatos.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="wms-picker-item"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setSelecionado({
                        id: p.id,
                        sku: p.sku,
                        descricao: p.descricao,
                      });
                      setQ("");
                    }}
                  >
                    <span className="wms-mono">{p.sku}</span>
                    <span className="wms-picker-desc">{p.descricao}</span>
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )}
      </div>
      <div>
        <div className="wms-ov-meta-lbl">Qty / kit</div>
        <input
          className="wms-input wms-mono"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          inputMode="decimal"
        />
      </div>
      <button
        className="wms-btn"
        onClick={submit}
        disabled={loading || !selecionado}
      >
        <Icon name="plus" size={11} /> Adicionar
      </button>
    </div>
  );
}

function ComponenteRow({
  row,
  kitId: _kitId,
  onQtyChange,
  onRemove,
}: {
  row: KitComposicaoRow;
  kitId: string;
  onQtyChange: (qty: number) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState(String(row.quantidade));
  return (
    <tr>
      <td>
        {row.componente.imagem_url && (
          <img
            src={row.componente.imagem_url}
            alt=""
            loading="lazy"
            className="wms-thumb wms-thumb-sm"
          />
        )}
      </td>
      <td className="wms-mono">{row.componente.sku}</td>
      <td className="wms-td-desc">{row.componente.descricao}</td>
      <td>
        {row.estoque.posicoes.length === 0 ? (
          <span className="wms-td-mute" style={{ fontSize: 12 }}>
            sem saldo
          </span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div>
              <span className="wms-mono" style={{ fontWeight: 600 }}>
                {fmtNum(row.estoque.disponivel_total)}
              </span>
              <span
                className="wms-td-mute"
                style={{ fontSize: 11.5, marginLeft: 6 }}
              >
                {row.estoque.posicoes.length === 1
                  ? "em 1 loc"
                  : `em ${row.estoque.posicoes.length} locs`}
                {row.estoque.reservado_total > 0
                  ? ` · ${fmtNum(row.estoque.reservado_total)} reserv.`
                  : ""}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 1,
                fontSize: 11.5,
                color: "var(--wms-c-mute)",
              }}
            >
              {row.estoque.posicoes.slice(0, 3).map((p, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span className="wms-mono" style={{ color: "var(--wms-c-fg-2)" }}>
                    {p.galpao.nome} · {p.localizacao.codigo}
                  </span>
                  <span className="wms-mono">{fmtNum(p.disponivel)}</span>
                </div>
              ))}
              {row.estoque.posicoes.length > 3 && (
                <div style={{ fontSize: 11 }}>
                  +{row.estoque.posicoes.length - 3} outras
                </div>
              )}
            </div>
          </div>
        )}
      </td>
      <td className="wms-tar">
        {editing ? (
          <input
            autoFocus
            className="wms-input wms-mono"
            style={{ width: 90, textAlign: "right" }}
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={() => {
              setEditing(false);
              const n = parseFloat(local.replace(",", "."));
              if (Number.isFinite(n) && n > 0 && n !== Number(row.quantidade)) {
                onQtyChange(n);
              } else {
                setLocal(String(row.quantidade));
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setLocal(String(row.quantidade));
                setEditing(false);
              }
            }}
          />
        ) : (
          <span
            className="wms-mono wms-link-row"
            onClick={() => setEditing(true)}
            style={{ cursor: "pointer" }}
            title="Clique pra editar"
          >
            {fmtNum(Number(row.quantidade))}
          </span>
        )}
      </td>
      <td className="wms-td-actions">
        <button
          className="wms-btn-icon"
          onClick={onRemove}
          title="Remover componente"
        >
          <Icon name="x" size={11} />
        </button>
      </td>
    </tr>
  );
}

function LedgerMini({ m }: { m: MovComposite }) {
  const tipos = {
    E: { lbl: "Entrada", cls: "ok", sign: "+" },
    S: { lbl: "Saída", cls: "danger", sign: "−" },
    R: { lbl: "Reserva", cls: "info", sign: "◷" },
    L: { lbl: "Liberação", cls: "mute", sign: "◶" },
  } as const;
  const t = tipos[m.tipo as keyof typeof tipos];
  return (
    <div className="wms-lm">
      <span className={`wms-lm-tipo wms-lm-${t.cls}`}>{t.sign}</span>
      <div className="wms-lm-body">
        <div className="wms-lm-top">
          <span className="wms-lm-qty wms-mono">
            {m.tipo === "E" || m.tipo === "S"
              ? `${t.sign}${fmtNum(Number(m.quantidade))}`
              : fmtNum(Number(m.quantidade))}
          </span>
          <span className="wms-lm-origem">{m.origem_tipo}</span>
          <span className="wms-lm-time">{fmtRelative(m.criado_em)}</span>
        </div>
        <div className="wms-lm-obs">
          {m.observacoes ?? `${m.empresa?.nome ?? ""} · ${m.localizacao?.codigo ?? ""}`}
        </div>
      </div>
    </div>
  );
}

export function LedgerRow({ m }: { m: MovComposite }) {
  const tipos = {
    E: { lbl: "Entrada", cls: "ok", sign: "+" },
    S: { lbl: "Saída", cls: "danger", sign: "−" },
    R: { lbl: "Reserva", cls: "info", sign: "◷" },
    L: { lbl: "Liberação", cls: "mute", sign: "◶" },
  } as const;
  const t = tipos[m.tipo as keyof typeof tipos];
  return (
    <div className="wms-lr">
      <div className="wms-lr-when">
        <div className="wms-lr-time">{fmtDateTime(m.criado_em)}</div>
        <div className="wms-lr-rel wms-td-mute">
          {fmtRelative(m.criado_em)}
        </div>
      </div>
      <div className={`wms-lr-tipo wms-lr-${t.cls}`}>
        <span>{t.sign}</span>
        <em>{t.lbl}</em>
      </div>
      <div className="wms-lr-qty wms-mono">
        {fmtNum(Number(m.quantidade))}
      </div>
      <div className="wms-lr-mid">
        <div className="wms-lr-prod">
          <span className="wms-mono">{m.produto?.sku ?? "—"}</span>{" "}
          <span className="wms-td-mute">{m.produto?.descricao ?? ""}</span>
        </div>
        <div className="wms-lr-where wms-td-mute">
          {m.empresa?.nome ?? ""} · {m.galpao?.nome ?? ""} ·{" "}
          <span className="wms-mono">{m.localizacao?.codigo ?? ""}</span>
        </div>
        {m.custo_unitario != null && (
          <div className="wms-lr-where wms-td-mute">
            <span className="wms-mono">
              {fmtBRL(Number(m.custo_unitario))}
            </span>{" "}
            <span style={{ opacity: 0.7 }}>×</span>{" "}
            <span className="wms-mono">{fmtNum(Number(m.quantidade))}</span>{" "}
            <span style={{ opacity: 0.7 }}>=</span>{" "}
            <span className="wms-mono">
              {fmtBRL(
                Number(m.custo_unitario) * Number(m.quantidade),
              )}
            </span>
          </div>
        )}
        {m.observacoes && <div className="wms-lr-obs">{m.observacoes}</div>}
      </div>
      <div className="wms-lr-saldo">
        <div className="wms-lr-saldo-lbl">saldo</div>
        <div className="wms-mono">
          <span className="wms-td-mute">
            {fmtNum(Number(m.saldo_anterior))}
          </span>{" "}
          → <strong>{fmtNum(Number(m.saldo_posterior))}</strong>
        </div>
      </div>
      <div>
        <span className="wms-badge wms-badge-mute">{m.origem_tipo}</span>
      </div>
    </div>
  );
}
