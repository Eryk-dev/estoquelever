"use client";

import { use, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch, useAuth, usePermissoes } from "@/lib/auth-context";
import { PageHeader, StatusBadge, Modal, Field, Icon } from "@/components/wms/ui/wms-ui";
import { ProdutoCombo } from "@/components/wms/ui/modals";
import type { Produto } from "@/lib/wms/types";
import { getMarketplaceName } from "@/lib/domain-helpers";
import {
  classificarVendaItem,
  quantidadeProcessadaVenda,
  resumirItensVenda,
} from "@/lib/wms/vendas-trace";

interface PedidoDetalhe {
  id: string;
  numero: string;
  data: string;
  filial_origem: string | null;
  cliente_nome: string;
  cliente_cpf_cnpj: string | null;
  nome_ecommerce: string | null;
  id_pedido_ecommerce: string | null;
  status: string;
  status_separacao: string | null;
  vendedor_id: string | null;
  vendedor_nome: string | null;
  origem_pedido: "webhook" | "manual";
  canal_venda: string | null;
  criado_em: string;
  marcadores: string[];
  separacao_full: boolean;
  fechado_em: string | null;
  full_etiqueta_total: number | null;
  full_etiqueta_anexada_em: string | null;
  processado_em: string | null;
  embalagem_concluida_em: string | null;
  separacao_iniciada_em: string | null;
  separacao_concluida_em: string | null;
}

interface ItemMovimento {
  id: string;
  tipo: string;
  quantidade: number;
  tipo_link: string | null;
  origem_tipo: string;
  localizacao_codigo: string | null;
  localizacao_tipo: string | null;
  galpao_nome: string | null;
  operador_nome: string | null;
  criado_em: string;
  estornado: boolean;
  motivo: string | null;
}

interface ItemDetalhe {
  id: string | number;
  sku: string;
  descricao: string;
  imagem_url: string | null;
  gtin: string | null;
  quantidade_pedida: number;
  quantidade_pega: number | null;
  quantidade_bipada: number;
  quantidade_encaixotada: number;
  quantidade_baixada_movimentos?: number;
  bipado_completo: boolean;
  bipado_em: string | null;
  bipado_por_nome: string | null;
  separacao_marcado: boolean;
  separacao_marcado_em: string | null;
  separacao_parcial: boolean;
  parcial_motivo: string | null;
  parcial_em: string | null;
  parcial_por_nome: string | null;
  estoque_saida_lancada: boolean;
  mov_saida_id: string | null;
  compra_status: string | null;
  compra_quantidade_solicitada: number | null;
  compra_quantidade_recebida: number | null;
  comprado_em: string | null;
  recebido_em: string | null;
  ordem_full: number | null;
  linha: number | null;
  movimentos: ItemMovimento[];
  movimentos_compartilhados_produto?: ItemMovimento[];
}

interface HistEvento {
  id: string;
  evento: string;
  usuario_nome: string | null;
  detalhes: Record<string, unknown>;
  criado_em: string;
}

interface DetalheResponse {
  pedido: PedidoDetalhe;
  itens: ItemDetalhe[];
  historico: HistEvento[];
}

interface UsuarioOpt {
  id: string;
  nome: string;
  cargos: string[];
}

export default function VendaDetalhePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { user } = useAuth();
  const { canAny } = usePermissoes();
  const qc = useQueryClient();
  const cargos = useMemo(() => user?.cargos ?? (user?.cargo ? [user.cargo] : []), [user]);
  const canReassign = cargos.includes("admin") || cargos.some((c) => c.startsWith("operador"));
  // Cancelar venda requer permissão de operações de armazém (qualquer perm
  // de operacoes.* ou inventario.executar/supervisionar — alinhado com
  // requireWarehouseAccess no backend).
  const podeCancelarOperacional = canAny(
    "operacoes.transferir",
    "operacoes.replenishment",
    "operacoes.devolucoes",
    "operacoes.receber",
    "operacoes.guarda",
    "operacoes.ajuste_manual",
    "inventario.executar",
    "inventario.supervisionar",
  );
  const [reassignOpen, setReassignOpen] = useState(false);
  const [cancelarOpen, setCancelarOpen] = useState(false);
  const [cancelarMotivo, setCancelarMotivo] = useState("");
  // Editor de itens do Full (só quando separacao_full && !fechado_em).
  const [addProduto, setAddProduto] = useState<Produto | null>(null);
  const [addQty, setAddQty] = useState(1);
  const [editBusy, setEditBusy] = useState(false);
  const [fullZplFile, setFullZplFile] = useState<File | null>(null);
  const [fullZplConfirmado, setFullZplConfirmado] = useState(false);
  const [fullZplBusy, setFullZplBusy] = useState(false);
  const [expandedItemIds, setExpandedItemIds] = useState<Set<string>>(
    () => new Set(),
  );

  const { data, isLoading, isError, refetch } = useQuery<DetalheResponse>({
    queryKey: ["venda-detalhe", id],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/vendas/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error("Falha ao carregar pedido");
      return r.json();
    },
  });

  const [cancelando, setCancelando] = useState(false);

  const anexarEReordenarZpl = async () => {
    if (!fullZplFile || !fullZplConfirmado) return;
    setFullZplBusy(true);
    try {
      const zpl = await fullZplFile.text();
      const r = await sisoFetch(`/api/wms/full/${encodeURIComponent(id)}/etiqueta-zpl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zpl, confirmar_mesma_ordem: true }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        error?: string;
        zpl?: string;
        total?: number;
      };
      if (!r.ok || !body.zpl) {
        toast.error(body.error ?? `Erro HTTP ${r.status}`);
        return;
      }
      const blob = new Blob([body.zpl], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `FULL-${pedido?.numero ?? id}-ordenado.zpl`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`${body.total} etiquetas conferidas, reordenadas e anexadas`);
      setFullZplFile(null);
      setFullZplConfirmado(false);
      await refetch();
    } finally {
      setFullZplBusy(false);
    }
  };
  const submitCancelar = async () => {
    const motivo = cancelarMotivo.trim();
    if (motivo.length < 3) {
      toast.error("Motivo precisa de ao menos 3 caracteres");
      return;
    }
    setCancelando(true);
    try {
      // Full cancela pela rota própria (estorna S de nf_venda + libera R); a de
      // venda só estorna venda_manual e não pegaria os picks do Full.
      const cancelUrl = data?.pedido.separacao_full
        ? `/api/wms/full/${encodeURIComponent(id)}/cancelar`
        : `/api/wms/vendas/${encodeURIComponent(id)}/cancelar`;
      const r = await sisoFetch(cancelUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        toast.error(j.error ?? `Erro HTTP ${r.status}`);
        return;
      }
      const result = (await r.json().catch(() => ({}))) as {
        itens_para_devolver_manual?: unknown[];
      };
      const devolucoes = result.itens_para_devolver_manual?.length ?? 0;
      if (devolucoes > 0) {
        toast.warning(
          `Venda cancelada. ${devolucoes} ${
            devolucoes === 1 ? "item precisa" : "itens precisam"
          } voltar ao estoque pela fila de devoluções.`,
          { duration: 10000 },
        );
      } else {
        toast.success(
          data?.pedido.separacao_full ? "Full cancelado" : "Venda cancelada",
        );
      }
      setCancelarOpen(false);
      setCancelarMotivo("");
      refetch();
      qc.invalidateQueries({ queryKey: ["vendas-lista"] });
      qc.invalidateQueries({ queryKey: ["wms-estoque"] });
      qc.invalidateQueries({ queryKey: ["wms-ledger"] });
    } finally {
      setCancelando(false);
    }
  };

  // ── Editor de itens do Full ──────────────────────────────────────────────
  async function editFull(method: string, path: string, body?: unknown, okMsg?: string): Promise<boolean> {
    setEditBusy(true);
    try {
      const r = await sisoFetch(`/api/wms/full/${encodeURIComponent(id)}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        toast.error(j.error ?? `Erro HTTP ${r.status}`);
        return false;
      }
      if (okMsg) toast.success(okMsg);
      await refetch();
      qc.invalidateQueries({ queryKey: ["wms-estoque"] });
      return true;
    } finally {
      setEditBusy(false);
    }
  }
  const addItemFull = async () => {
    if (!addProduto || addQty <= 0) return;
    const ok = await editFull("POST", "/itens", { produto_id: addProduto.id, quantidade: addQty }, "Item adicionado");
    if (ok) {
      setAddProduto(null);
      setAddQty(1);
    }
  };
  const removeItemFull = (itemId: string | number) => editFull("DELETE", `/itens/${itemId}`, undefined, "Item removido");
  const setQtyFull = (itemId: string | number, quantidade: number) =>
    editFull("PATCH", `/itens/${itemId}`, { quantidade }, "Quantidade atualizada");

  if (isLoading) {
    return (
      <div className="wms-sales-detail-loading" aria-label="Carregando pedido">
        <span />
        <span />
        <span />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="wms-sales-state">
        <span className="wms-sales-state-icon is-error">
          <Icon name="alert" size={18} />
        </span>
        <strong>Não foi possível abrir este pedido</strong>
        <p>A consulta falhou ou o pedido não está mais disponível.</p>
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          onClick={() => refetch()}
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  const { pedido, itens, historico } = data;
  // Editor de itens: só num Full aberto (não fechado, não cancelado) e com perm.
  const fullEditavel =
    pedido.separacao_full &&
    !pedido.fechado_em &&
    pedido.status !== "cancelado" &&
    podeCancelarOperacional;
  const podeCancelarPedido =
    podeCancelarOperacional ||
    (!pedido.separacao_full &&
      !!user?.id &&
      pedido.vendedor_id === user.id);
  const podeCancelarStatus = pedido.status !== "cancelado";
  const statusSeparacaoAtivo = ["em_separacao", "separado", "embalado", "conferido"].includes(
    pedido.status_separacao ?? "",
  );
  const origemLabel =
    pedido.origem_pedido === "manual"
      ? "Manual"
      : (getMarketplaceName(pedido.nome_ecommerce ?? "") || pedido.nome_ecommerce || "—");
  const resumo = resumirItensVenda(itens);
  const progresso =
    resumo.unidades_total > 0
      ? Math.round(
          (resumo.unidades_processadas / resumo.unidades_total) * 100,
        )
      : 0;
  const toggleItemTrace = (itemId: string | number) => {
    const key = String(itemId);
    setExpandedItemIds((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="wms-sales-detail">
      <PageHeader
        title={`#${pedido.numero}`}
        subtitle={
          pedido.separacao_full
            ? "Envio de estoque ao Mercado Livre Full"
            : `${pedido.cliente_nome} · ${origemLabel}`
        }
        backHref="/wms/vendas"
        backLabel="Vendas diretas"
      >
        <span
          className={`wms-sales-origin ${
            pedido.separacao_full ? "is-full" : ""
          }`}
        >
          {pedido.separacao_full ? "FULL" : origemLabel}
        </span>
        <StatusBadge status={pedido.status_separacao ?? pedido.status} />
        {podeCancelarStatus && podeCancelarPedido && (
          <button
            type="button"
            className="wms-btn wms-btn-danger"
            onClick={() => {
              setCancelarMotivo("");
              setCancelarOpen(true);
            }}
            title={
              statusSeparacaoAtivo
                ? "Itens já separados serão reconciliados ou enviados para devolução"
                : `Cancelar ${pedido.separacao_full ? "envio Full" : "venda"}`
            }
          >
            <Icon name="x" size={11} />
            Cancelar
          </button>
        )}
      </PageHeader>

      <div className="wms-sales-detail-scroll">
        <section className="wms-sales-detail-hero">
          <div className="wms-sales-detail-progress">
            <div>
              <span>Progresso dos itens</span>
              <strong>
                {resumo.unidades_processadas.toLocaleString("pt-BR")} de{" "}
                {resumo.unidades_total.toLocaleString("pt-BR")} unidades
              </strong>
            </div>
            <b>{progresso}%</b>
            <span className="wms-sales-progress-track">
              <i style={{ width: `${Math.min(100, progresso)}%` }} />
            </span>
          </div>
          <div className="wms-sales-detail-kpis">
            <div>
              <span>Itens</span>
              <strong>{resumo.itens_total}</strong>
              <small>{resumo.itens_processados} concluídos</small>
            </div>
            <div>
              <span>Com atenção</span>
              <strong
                className={
                  resumo.itens_com_excecao > 0 ? "is-warning" : undefined
                }
              >
                {resumo.itens_com_excecao}
              </strong>
              <small>parcial ou compra</small>
            </div>
            <div>
              <span>Criado em</span>
              <strong>{formatDateTimeFull(pedido.criado_em, "date")}</strong>
              <small>{formatDateTimeFull(pedido.criado_em, "time")}</small>
            </div>
            <div>
              <span>Galpão</span>
              <strong>{pedido.filial_origem ?? "—"}</strong>
              <small>{pedido.separacao_full ? "origem do Full" : "separação"}</small>
            </div>
          </div>
        </section>

        {pedido.separacao_full && (
          <section className="wms-card" style={{ padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 16 }}>Etiqueta Mercado Livre do Full</h2>
                <p className="wms-td-mute" style={{ margin: "4px 0 0" }}>
                  Anexe o ZPL completo. O sistema exige a mesma quantidade de unidades e reordena os blocos pela localização do estoque.
                </p>
                {pedido.full_etiqueta_anexada_em && (
                  <small className="wms-td-mute">
                    Último arquivo: {pedido.full_etiqueta_total ?? 0} etiquetas · {new Date(pedido.full_etiqueta_anexada_em).toLocaleString("pt-BR")}
                  </small>
                )}
              </div>
              <input
                type="file"
                accept=".zpl,.txt,application/octet-stream,text/plain"
                onChange={(e) => {
                  setFullZplFile(e.target.files?.[0] ?? null);
                  setFullZplConfirmado(false);
                }}
              />
            </div>
            {fullZplFile && (
              <div className="wms-hint-card wms-hint-danger" style={{ marginTop: 12 }}>
                <Icon name="alert" />
                <label style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={fullZplConfirmado}
                    onChange={(e) => setFullZplConfirmado(e.target.checked)}
                    style={{ marginRight: 8 }}
                  />
                  Tenho certeza de que coloquei os itens no WMS na mesma ordem em que as etiquetas aparecem neste arquivo do Full.
                </label>
                <button
                  type="button"
                  className="wms-btn wms-btn-primary"
                  disabled={!fullZplConfirmado || fullZplBusy}
                  onClick={() => void anexarEReordenarZpl()}
                >
                  {fullZplBusy ? "Conferindo…" : "Confirmar, reordenar e baixar"}
                </button>
              </div>
            )}
          </section>
        )}

        <div className="wms-sales-detail-grid">
          <main className="wms-sales-items-panel">
            <header className="wms-sales-panel-head">
              <div>
                <span>Rastreabilidade item a item</span>
                <h2>{pedido.separacao_full ? "Linhas do envio Full" : "Itens do pedido"}</h2>
              </div>
              {pedido.separacao_full && pedido.fechado_em && (
                <span className="wms-sales-closed-note">
                  Full fechado · reabra na Separação Full para editar
                </span>
              )}
            </header>

            <div className="wms-sales-item-list">
              {itens.map((item, index) => {
                const stage = classificarVendaItem(item);
                const processada = quantidadeProcessadaVenda(item);
                const itemProgress =
                  item.quantidade_pedida > 0
                    ? Math.round((processada / item.quantidade_pedida) * 100)
                    : 0;
                const expanded = expandedItemIds.has(String(item.id));
                const latestLocation = [...item.movimentos]
                  .reverse()
                  .find((movimento) => movimento.localizacao_codigo);
                const sharedMovimentos =
                  item.movimentos_compartilhados_produto ?? [];

                return (
                  <article
                    key={item.id}
                    className={`wms-sales-item ${
                      stage.tone === "warn" ? "has-warning" : ""
                    }`}
                  >
                    <div className="wms-sales-item-main">
                      <span className="wms-sales-item-order">
                        {pedido.separacao_full
                          ? String(item.ordem_full ?? index + 1).padStart(2, "0")
                          : String(index + 1).padStart(2, "0")}
                      </span>
                      <div className="wms-sales-item-image">
                        {item.imagem_url ? (
                          // Catálogo aceita hosts externos heterogêneos; o
                          // proxy do next/image não tem allowlist segura aqui.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={item.imagem_url} alt={item.descricao} />
                        ) : (
                          <Icon name="box" size={18} />
                        )}
                      </div>
                      <div className="wms-sales-item-product">
                        <div>
                          <code>{item.sku}</code>
                          <span
                            className={`wms-sales-item-stage is-${stage.tone}`}
                          >
                            {stage.label}
                          </span>
                        </div>
                        <strong>{item.descricao}</strong>
                        <small>
                          {item.gtin ? `GTIN ${item.gtin}` : "GTIN não informado"}
                          {latestLocation?.localizacao_codigo
                            ? ` · última loc ${latestLocation.localizacao_codigo}`
                            : ""}
                        </small>
                      </div>
                      <div className="wms-sales-item-qty">
                        <span>Processado</span>
                        <strong>
                          {processada.toLocaleString("pt-BR")} /{" "}
                          {Number(item.quantidade_pedida).toLocaleString("pt-BR")}
                        </strong>
                        <span className="wms-sales-progress-track">
                          <i
                            style={{ width: `${Math.min(100, itemProgress)}%` }}
                          />
                        </span>
                      </div>
                      {fullEditavel && (
                        <div className="wms-sales-item-edit">
                          <FullItemQtyCell
                            value={item.quantidade_pedida}
                            disabled={editBusy}
                            onCommit={(value) => setQtyFull(item.id, value)}
                          />
                          <button
                            type="button"
                            className="wms-btn-icon"
                            disabled={editBusy}
                            onClick={() => removeItemFull(item.id)}
                            aria-label={`Remover ${item.sku}`}
                            title="Remover item e reconciliar estoque"
                          >
                            <Icon name="trash" size={12} />
                          </button>
                        </div>
                      )}
                      <button
                        type="button"
                        className="wms-sales-item-expand"
                        onClick={() => toggleItemTrace(item.id)}
                        aria-expanded={expanded}
                      >
                        {expanded ? "Ocultar trilha" : "Ver trilha"}
                        <Icon
                          name={expanded ? "chevron-u" : "chevron-d"}
                          size={11}
                        />
                      </button>
                    </div>

                    {stage.tone === "warn" && (
                      <div className="wms-sales-item-alert">
                        <Icon name="alert" size={12} />
                        <span>
                          {item.separacao_parcial
                            ? item.parcial_motivo ||
                              `${processada} de ${item.quantidade_pedida} unidades separadas`
                            : `Item aguardando compra${
                                item.compra_quantidade_solicitada
                                  ? ` de ${item.compra_quantidade_solicitada} unidades`
                                  : ""
                              }`}
                        </span>
                      </div>
                    )}

                    {expanded && (
                      <div className="wms-sales-item-trace">
                        <div className="wms-sales-item-facts">
                          <span>
                            <small>Pedido</small>
                            <strong>
                              {Number(item.quantidade_pedida).toLocaleString("pt-BR")} un.
                            </strong>
                          </span>
                          <span>
                            <small>Processado</small>
                            <strong>
                              {processada.toLocaleString("pt-BR")} un.
                            </strong>
                          </span>
                          <span>
                            <small>Conferido</small>
                            <strong>
                              {Number(item.quantidade_bipada ?? 0).toLocaleString("pt-BR")} un.
                            </strong>
                          </span>
                          <span>
                            <small>Encaixotado</small>
                            <strong>
                              {Number(item.quantidade_encaixotada ?? 0).toLocaleString("pt-BR")} un.
                            </strong>
                          </span>
                        </div>

                        {item.movimentos.length > 0 ? (
                          <ol className="wms-sales-movement-list">
                            {item.movimentos.map((movimento) => (
                              <li
                                key={movimento.id}
                                className={movimento.estornado ? "is-reversed" : ""}
                              >
                                <span
                                  className={`wms-sales-movement-type is-${movimento.tipo.toLowerCase()}`}
                                >
                                  {movimento.tipo}
                                </span>
                                <div>
                                  <strong>{movementLabel(movimento)}</strong>
                                  <span>
                                    {movimento.quantidade.toLocaleString("pt-BR")} un.
                                    {movimento.localizacao_codigo
                                      ? ` · ${movimento.localizacao_codigo}`
                                      : ""}
                                    {movimento.galpao_nome
                                      ? ` · ${movimento.galpao_nome}`
                                      : ""}
                                  </span>
                                </div>
                                <time
                                  dateTime={movimento.criado_em}
                                  title={formatDateTimeFull(movimento.criado_em)}
                                >
                                  {formatDateTimeFull(movimento.criado_em)}
                                  {movimento.operador_nome && (
                                    <small>{movimento.operador_nome}</small>
                                  )}
                                </time>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <div className="wms-sales-trace-empty">
                            <Icon name="history" size={14} />
                            Ainda não há movimentação de estoque para este item.
                          </div>
                        )}

                        {sharedMovimentos.length > 0 && (
                          <>
                            <div className="wms-sales-trace-empty">
                              <Icon name="alert" size={14} />
                              Reserva ou movimentação compartilhada entre linhas
                              deste SKU — sem rateio individual presumido.
                            </div>
                            <ol className="wms-sales-movement-list">
                              {sharedMovimentos.map(
                                (movimento) => (
                                  <li
                                    key={`shared-${movimento.id}`}
                                    className={
                                      movimento.estornado ? "is-reversed" : ""
                                    }
                                  >
                                    <span
                                      className={`wms-sales-movement-type is-${movimento.tipo.toLowerCase()}`}
                                    >
                                      {movimento.tipo}
                                    </span>
                                    <div>
                                      <strong>
                                        {movementLabel(movimento)} · compartilhada
                                      </strong>
                                      <span>
                                        {movimento.quantidade.toLocaleString(
                                          "pt-BR",
                                        )}{" "}
                                        un.
                                        {movimento.localizacao_codigo
                                          ? ` · ${movimento.localizacao_codigo}`
                                          : ""}
                                        {movimento.galpao_nome
                                          ? ` · ${movimento.galpao_nome}`
                                          : ""}
                                      </span>
                                    </div>
                                    <time
                                      dateTime={movimento.criado_em}
                                      title={formatDateTimeFull(
                                        movimento.criado_em,
                                      )}
                                    >
                                      {formatDateTimeFull(movimento.criado_em)}
                                      {movimento.operador_nome && (
                                        <small>
                                          {movimento.operador_nome}
                                        </small>
                                      )}
                                    </time>
                                  </li>
                                ),
                              )}
                            </ol>
                          </>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>

            {fullEditavel && (
              <div className="wms-sales-add-full-item">
                <div>
                  <span>Adicionar linha ao Full</span>
                  <strong>O estoque será reservado ao incluir o item.</strong>
                </div>
                <div className="wms-sales-add-full-fields">
                  <ProdutoCombo value={addProduto} onChange={setAddProduto} />
                  <input
                    type="number"
                    min={1}
                    value={addQty}
                    onChange={(event) =>
                      setAddQty(parseInt(event.target.value, 10) || 0)
                    }
                    className="wms-input"
                    aria-label="Quantidade"
                  />
                  <button
                    type="button"
                    className="wms-btn wms-btn-primary"
                    disabled={editBusy || !addProduto || addQty <= 0}
                    onClick={addItemFull}
                  >
                    <Icon name="plus" size={11} />
                    Adicionar
                  </button>
                </div>
              </div>
            )}
          </main>

          <aside className="wms-sales-detail-aside">
            <section className="wms-sales-aside-card">
              <header>
                <span>Pedido</span>
                <h2>Dados e responsabilidade</h2>
              </header>
              <dl className="wms-sales-order-facts">
                <div>
                  <dt>Vendedor</dt>
                  <dd>
                    {pedido.vendedor_nome ?? "Não atribuído"}
                    {canReassign && (
                      <button
                        type="button"
                        className="wms-btn-link"
                        onClick={() => setReassignOpen(true)}
                      >
                        <Icon name="edit" size={10} />
                        Editar
                      </button>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Cliente / destino</dt>
                  <dd>
                    {pedido.separacao_full
                      ? "Mercado Livre Full"
                      : pedido.cliente_nome || "—"}
                  </dd>
                </div>
                <div>
                  <dt>Canal</dt>
                  <dd>{pedido.canal_venda ?? origemLabel}</dd>
                </div>
                <div>
                  <dt>CPF / CNPJ</dt>
                  <dd>{pedido.cliente_cpf_cnpj ?? "—"}</dd>
                </div>
                {pedido.id_pedido_ecommerce && (
                  <div>
                    <dt>ID marketplace</dt>
                    <dd className="wms-mono">{pedido.id_pedido_ecommerce}</dd>
                  </div>
                )}
                <div>
                  <dt>Criação</dt>
                  <dd>{formatDateTimeFull(pedido.criado_em)}</dd>
                </div>
              </dl>
            </section>

            <section className="wms-sales-aside-card">
              <header>
                <span>Histórico</span>
                <h2>Linha do tempo do pedido</h2>
              </header>
              {historico.length > 0 ? (
                <ol className="wms-sales-history">
                  {historico.map((evento) => (
                    <li key={evento.id}>
                      <i />
                      <div>
                        <strong>{historyLabel(evento.evento)}</strong>
                        <span>
                          {formatDateTimeFull(evento.criado_em)}
                          {evento.usuario_nome
                            ? ` · ${evento.usuario_nome}`
                            : ""}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="wms-sales-aside-empty">
                  Nenhum evento registrado.
                </p>
              )}
            </section>
          </aside>
        </div>
      </div>

      {reassignOpen && (
        <ReassignModal
          pedidoId={id}
          atualVendedorId={pedido.vendedor_id}
          onClose={() => setReassignOpen(false)}
          onSaved={() => {
            setReassignOpen(false);
            refetch();
            qc.invalidateQueries({ queryKey: ["vendas-lista"] });
          }}
        />
      )}

      {cancelarOpen && (
        <Modal
          title={pedido.separacao_full ? "Cancelar envio Full" : "Cancelar venda"}
          subtitle={`#${pedido.numero} · ${
            pedido.separacao_full ? "Mercado Livre Full" : pedido.cliente_nome
          }`}
          width={520}
          onClose={() => !cancelando && setCancelarOpen(false)}
          footer={
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="wms-btn wms-btn-ghost"
                disabled={cancelando}
                onClick={() => setCancelarOpen(false)}
              >
                Voltar
              </button>
              <button
                type="button"
                className="wms-btn wms-btn-danger"
                disabled={cancelando || cancelarMotivo.trim().length < 3}
                onClick={submitCancelar}
              >
                <Icon name="x" size={11} />
                {cancelando ? "Cancelando…" : "Confirmar cancelamento"}
              </button>
            </div>
          }
        >
          {statusSeparacaoAtivo && (
            <div className="wms-sales-cancel-warning">
              <Icon name="alert" size={13} />
              <div>
                <strong>Este pedido já entrou na operação.</strong>
                <span>
                  {pedido.separacao_full
                    ? "As saídas já feitas serão estornadas e as reservas abertas serão liberadas."
                    : "Itens já retirados irão para a fila de devoluções; reservas ainda abertas serão liberadas."}
                </span>
              </div>
            </div>
          )}
          <p className="wms-sales-cancel-copy">
            O cancelamento mantém toda a trilha do pedido e reconcilia o
            estoque conforme o que já foi processado.
          </p>
          <label className="wms-field-lbl" htmlFor="venda-cancelar-motivo">
            Motivo do cancelamento
            <span className="wms-req">*</span>
          </label>
          <textarea
            id="venda-cancelar-motivo"
            className="wms-textarea"
            value={cancelarMotivo}
            onChange={(e) => setCancelarMotivo(e.target.value)}
            placeholder="Ex.: cliente desistiu, pedido duplicado ou envio incorreto"
            rows={3}
            autoFocus
            disabled={cancelando}
          />
        </Modal>
      )}
    </div>
  );
}

function formatDateTimeFull(
  iso: string | null,
  part?: "date" | "time",
): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  if (part === "date") {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(date);
  }
  if (part === "time") {
    return new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function movementLabel(movimento: ItemMovimento): string {
  const byLink: Record<string, string> = {
    saida: "Saída confirmada no estoque",
    liberacao_reserva: "Reserva consumida no pick",
    ajuste_loc_zerou: "Ajuste de localização esgotada",
  };
  const byType: Record<string, string> = {
    R: "Estoque reservado",
    L: "Reserva liberada",
    S: "Saída registrada",
    E: "Entrada registrada",
  };
  const label =
    (movimento.tipo_link ? byLink[movimento.tipo_link] : undefined) ??
    byType[movimento.tipo] ??
    "Movimentação de estoque";
  return movimento.estornado ? `${label} · estornada` : label;
}

function historyLabel(evento: string): string {
  const labels: Record<string, string> = {
    venda_criada_manual: "Venda criada",
    full_criado: "Envio Full criado",
    separacao_iniciada: "Separação iniciada",
    separacao_concluida: "Separação concluída",
    parcial_loc_zerou: "Localização marcada como esgotada",
    realocacao_sem_cobertura_galpao: "Sem cobertura no galpão",
    enviado_validacao_oc_pos_zerou: "Item enviado para validação de compra",
    oc_item_desfazer_encontrado: "Validação de item desfeita",
    full_editado: "Envio Full alterado",
    cancelado: "Pedido cancelado",
  };
  if (labels[evento]) return labels[evento];
  const sentence = evento.replaceAll("_", " ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

// Qty editável do item Full — commita no blur/Enter só quando muda pra valor
// válido (>0); reverte input inválido. O PATCH atrás reconcilia estoque.
function FullItemQtyCell({
  value,
  disabled,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  onCommit: (q: number) => void;
}) {
  // Sincroniza o input quando a prop muda (após refetch) sem useEffect — padrão
  // React de "ajustar state no render" (evita set-state-in-effect).
  const [v, setV] = useState(String(value));
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setV(String(value));
  }
  const commit = () => {
    const q = parseInt(v, 10);
    if (!Number.isFinite(q) || q <= 0) {
      setV(String(value));
      return;
    }
    if (q !== value) onCommit(q);
  };
  return (
    <input
      type="number"
      min={1}
      value={v}
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="wms-input"
      style={{ width: 64, textAlign: "right" }}
    />
  );
}

function ReassignModal({
  pedidoId,
  atualVendedorId,
  onClose,
  onSaved,
}: {
  pedidoId: string;
  atualVendedorId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [vendedorId, setVendedorId] = useState(atualVendedorId ?? "");
  const [enviando, setEnviando] = useState(false);

  const { data: vendedores } = useQuery<UsuarioOpt[]>({
    queryKey: ["reassign-vendedores"],
    queryFn: async () => {
      const r = await sisoFetch("/api/wms/admin/usuarios");
      if (!r.ok) return [];
      const j = (await r.json()) as { usuarios?: UsuarioOpt[] };
      return (j.usuarios ?? []).filter((u) => u.cargos?.includes("vendedor"));
    },
  });

  const submit = async () => {
    setEnviando(true);
    try {
      const r = await sisoFetch(`/api/wms/vendas/${encodeURIComponent(pedidoId)}/vendedor`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendedor_id: vendedorId || null }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { erro?: string };
        toast.error(j.erro ?? "Erro ao atribuir vendedor");
        return;
      }
      toast.success("Vendedor atribuído");
      onSaved();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal
      title="Atribuir vendedor"
      onClose={onClose}
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="wms-btn" onClick={onClose} disabled={enviando}>
            Cancelar
          </button>
          <button className="wms-btn wms-btn-primary" onClick={submit} disabled={enviando}>
            Salvar
          </button>
        </div>
      }
    >
      <Field label="Vendedor">
        <select
          value={vendedorId}
          onChange={(e) => setVendedorId(e.target.value)}
          className="wms-input"
        >
          <option value="">— sem vendedor —</option>
          {(vendedores ?? []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.nome}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}
