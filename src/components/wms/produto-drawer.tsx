"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Card,
  Icon,
  StatusBadge,
  LocTipoBadge,
  fmtBRL,
  fmtDateTime,
  fmtNum,
  fmtRelative,
} from "@/components/wms/ui/wms-ui";
import { useWmsModals } from "@/components/wms/wms-shell";
import type { Produto, Movimentacao } from "@/lib/wms/types";
import type { LinhaCobertura } from "@/lib/wms/cobertura";

type TabId = "overview" | "estoque" | "movs" | "cobertura" | "fornec";

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
    queryKey: ["wms-produto-ledger", produtoId],
    queryFn: () =>
      wmsApi<{ rows: MovComposite[] }>(
        `/api/wms/ledger?produto_id=${produtoId}&limit=200`,
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

  const produto = produtoQuery.data;
  const agregado = estoqueQuery.data?.rows[0];
  const linhas = agregado?.itens ?? [];
  const movs = ledgerQuery.data?.rows ?? [];
  const cobertura = coberturaQuery.data?.[0];

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

  function openAction(kind: "receber" | "ajuste" | "transferir") {
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
                      label: "Estoque por local",
                      count: linhas.length,
                    },
                    { id: "movs", label: "Movimentações", count: movs.length },
                    { id: "cobertura", label: "Cobertura" },
                    { id: "fornec", label: "Fornecedores" },
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
              {tab === "movs" && <Movimentacoes movs={movs} />}
              {tab === "cobertura" && <Cobertura c={cobertura} />}
              {tab === "fornec" && <Fornecedores produto={produto} />}
            </div>
          </>
        )}
      </div>
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
  const top3 = [...linhas]
    .sort((a, b) => Number(b.saldo) - Number(a.saldo))
    .slice(0, 3);
  return (
    <div className="wms-ov-grid">
      <Card
        title="Onde está"
        actions={
          <button className="wms-btn-link" onClick={() => onTab("estoque")}>
            Ver tudo →
          </button>
        }
      >
        {top3.length === 0 && (
          <div className="wms-exp-empty">Sem estoque registrado.</div>
        )}
        {top3.map((l, i) => (
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

function Movimentacoes({ movs }: { movs: MovComposite[] }) {
  if (movs.length === 0) {
    return (
      <div className="wms-exp-empty" style={{ padding: 24 }}>
        Sem movimentações.
      </div>
    );
  }
  return (
    <div className="wms-ledger-list">
      {movs.map((m) => (
        <LedgerRow key={m.id} m={m} />
      ))}
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

function Fornecedores({ produto }: { produto: Produto }) {
  const fornecQuery = useQuery({
    queryKey: ["wms-produto-fornecedores", produto.id],
    queryFn: () =>
      wmsApi<{ rows: FornecRow[] }>(
        `/api/wms/produto-fornecedores?produto_id=${produto.id}`,
      ),
  });
  const rows = fornecQuery.data?.rows ?? [];
  if (rows.length === 0) {
    return (
      <div className="wms-exp-empty" style={{ padding: 24 }}>
        Nenhum fornecedor vinculado a este produto.
      </div>
    );
  }
  return (
    <div>
      {rows.map((f) => (
        <div
          key={f.id}
          className={`wms-card ${f.preferencial ? "" : ""}`}
          style={{
            marginBottom: 12,
            border: f.preferencial
              ? "1px solid var(--wms-c-fg)"
              : "1px solid var(--wms-c-border)",
          }}
        >
          <div className="wms-card-h">
            <div>
              {f.preferencial && (
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
              <h3>{f.fornecedor?.nome}</h3>
            </div>
          </div>
          <div className="wms-card-body">
            <div className="wms-ov-meta-grid">
              <div>
                <div className="wms-ov-meta-lbl">Lead time</div>
                <div className="wms-mono">
                  {f.lead_time_medio ?? "—"} dias
                </div>
              </div>
              <div>
                <div className="wms-ov-meta-lbl">Custo unitário</div>
                <div className="wms-mono">{fmtBRL(f.custo_unitario)}</div>
              </div>
              <div>
                <div className="wms-ov-meta-lbl">Qty mínima</div>
                <div className="wms-mono">{f.qty_minima_pedido ?? "—"}</div>
              </div>
              <div>
                <div className="wms-ov-meta-lbl">Múltiplo de compra</div>
                <div className="wms-mono">{f.multiplo_compra ?? "—"}</div>
              </div>
              <div>
                <div className="wms-ov-meta-lbl">Prefixo SKU</div>
                <div className="wms-mono">
                  {f.fornecedor?.prefixo_sku ?? "—"}
                </div>
              </div>
              <div>
                <div className="wms-ov-meta-lbl">CNPJ</div>
                <div className="wms-mono">{f.fornecedor?.cnpj ?? "—"}</div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

interface FornecRow {
  id: string;
  preferencial: boolean;
  lead_time_medio: number | null;
  custo_unitario: number | null;
  qty_minima_pedido: number | null;
  multiplo_compra: number | null;
  fornecedor?: {
    id: string;
    nome: string;
    cnpj: string | null;
    prefixo_sku: string | null;
  };
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
