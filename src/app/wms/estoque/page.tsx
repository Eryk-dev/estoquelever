"use client";
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams, useRouter } from "next/navigation";
import { wmsApi } from "@/lib/wms/api-client";
import {
  PageHeader,
  Icon,
  Kpi,
  StatusBadge,
  fmtBRL,
  fmtNum,
} from "@/components/wms/ui/wms-ui";
import { useWmsModals } from "@/components/wms/wms-shell";
import { ProdutoDrawer } from "@/components/wms/produto-drawer";
import { ProdutoLightbox } from "@/components/wms/produto-lightbox";
import type { LinhaCobertura } from "@/lib/wms/cobertura";

interface EstoqueItem {
  saldo: number;
  reservado: number;
  disponivel: number;
  custo_medio: number;
  atualizado_em: string;
  produto: {
    id: string;
    sku: string;
    descricao: string;
    imagem_url: string | null;
    imagens: string[];
  };
  empresa: { id: string; nome: string };
  galpao: { id: string; nome: string };
  localizacao: { id: string; codigo: string; tipo: string };
}

interface EstoqueAgregado {
  chave: string;
  nome: string;
  saldo: number;
  reservado: number;
  disponivel: number;
  itens: EstoqueItem[];
}

export default function EstoquePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Drawer state vive na URL (?produto=ID) — sobrevive a F5 e dá link
  // compartilhável. Cmd+K e clique na tabela usam o mesmo mecanismo.
  const drawerProdutoId = searchParams?.get("produto") ?? null;

  const [q, setQ] = useState("");
  const [filterGalpao, setFilterGalpao] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"saldo" | "atualizacao">("saldo");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{
    imagens: string[];
    sku: string;
    descricao: string;
  } | null>(null);
  const modals = useWmsModals();

  const openDrawer = useCallback(
    (id: string) => {
      const params = new URLSearchParams(
        Array.from(searchParams?.entries() ?? []),
      );
      params.set("produto", id);
      router.push(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const closeDrawer = useCallback(() => {
    const params = new URLSearchParams(
      Array.from(searchParams?.entries() ?? []),
    );
    params.delete("produto");
    const qs = params.toString();
    router.push(qs ? `?${qs}` : "?", { scroll: false });
  }, [router, searchParams]);

  const estoqueQuery = useQuery({
    queryKey: ["wms-estoque", "produto"],
    queryFn: () =>
      wmsApi<{ rows: EstoqueAgregado[] }>(`/api/wms/estoque?view=produto`),
  });

  const coberturaQuery = useQuery({
    queryKey: ["wms-cobertura-all"],
    queryFn: () =>
      wmsApi<{ rows: LinhaCobertura[] }>(`/api/wms/cobertura`),
  });

  // Map cobertura por produto
  const coberturaMap = useMemo(() => {
    const m = new Map<string, LinhaCobertura>();
    for (const r of coberturaQuery.data?.rows ?? []) {
      // Pode haver múltiplos por produto (galpão/empresa) — agrega o pior
      const cur = m.get(r.produto_id);
      if (
        !cur ||
        statusRank(r.status_cobertura) < statusRank(cur.status_cobertura)
      ) {
        m.set(r.produto_id, r);
      }
    }
    return m;
  }, [coberturaQuery.data]);

  const galpoes = useMemo(() => {
    const set = new Map<string, string>();
    for (const r of estoqueQuery.data?.rows ?? []) {
      for (const i of r.itens) set.set(i.galpao.id, i.galpao.nome);
    }
    return Array.from(set, ([id, nome]) => ({ id, nome }));
  }, [estoqueQuery.data]);

  const rows = useMemo(() => {
    let result = (estoqueQuery.data?.rows ?? []).map((r) => {
      const sku = r.itens[0]?.produto.sku ?? "";
      const descricao = r.itens[0]?.produto.descricao ?? r.nome;
      const imagemUrl = r.itens[0]?.produto.imagem_url ?? null;
      const imagens = r.itens[0]?.produto.imagens ?? [];
      const cobertura = coberturaMap.get(r.chave);
      const custoMedio =
        r.itens.reduce(
          (s, i) => s + Number(i.custo_medio) * Number(i.saldo),
          0,
        ) / Math.max(r.saldo, 1);
      const atualizadoEm = r.itens.reduce((max, i) => {
        const t = i.atualizado_em ? new Date(i.atualizado_em).getTime() : 0;
        return t > max ? t : max;
      }, 0);
      return {
        produtoId: r.chave,
        sku,
        descricao,
        imagemUrl,
        imagens,
        saldo: Number(r.saldo),
        reservado: Number(r.reservado),
        disponivel: Number(r.disponivel),
        itens: r.itens,
        cobertura,
        custoMedio,
        atualizadoEm,
      };
    });

    const ql = q.trim().toLowerCase();
    if (ql) {
      result = result.filter(
        (r) =>
          r.sku.toLowerCase().includes(ql) ||
          r.descricao.toLowerCase().includes(ql) ||
          r.itens.some((i) =>
            i.localizacao.codigo.toLowerCase().includes(ql),
          ),
      );
    }
    if (filterGalpao !== "all") {
      result = result.filter((r) =>
        r.itens.some((i) => i.galpao.id === filterGalpao),
      );
    }
    if (filterStatus !== "all") {
      result = result.filter(
        (r) => r.cobertura?.status_cobertura === filterStatus,
      );
    }
    if (sortBy === "atualizacao") {
      result = [...result].sort((a, b) => b.atualizadoEm - a.atualizadoEm);
    } else {
      result = [...result].sort((a, b) => b.saldo - a.saldo);
    }
    return result;
  }, [
    estoqueQuery.data,
    coberturaMap,
    q,
    filterGalpao,
    filterStatus,
    sortBy,
  ]);

  const totalSaldo = rows.reduce((s, r) => s + r.saldo, 0);
  const totalReservado = rows.reduce((s, r) => s + r.reservado, 0);
  const totalDisp = totalSaldo - totalReservado;
  const totalValor = rows.reduce((s, r) => s + r.saldo * r.custoMedio, 0);
  const criticos = rows.filter(
    (r) => r.cobertura?.status_cobertura === "critico",
  ).length;

  return (
    <>
      <PageHeader
        title="Estoque"
        subtitle={`${rows.length} produtos · ${fmtNum(totalSaldo)} unidades · ${fmtBRL(
          totalValor,
        )} em estoque`}
        backHref="/wms"
        backLabel="Voltar ao WMS"
      >
        <button
          className="wms-btn wms-btn-ghost"
          onClick={() => modals.open("ajuste")}
        >
          <Icon name="sliders" size={12} />
          Ajustar
        </button>
        <button
          className="wms-btn wms-btn-primary"
          onClick={() => modals.open("receber")}
        >
          <Icon name="plus" size={12} />
          Receber mercadoria
        </button>
      </PageHeader>

      <div className="wms-kpis">
        <Kpi label="Físico total" value={fmtNum(totalSaldo)} />
        <Kpi
          label="Reservado"
          value={fmtNum(totalReservado)}
          sub={`${((totalReservado / Math.max(totalSaldo, 1)) * 100).toFixed(1)}% do físico`}
        />
        <Kpi label="Disponível" value={fmtNum(totalDisp)} />
        <Kpi label="Valor em estoque" value={fmtBRL(totalValor)} />
        <Kpi
          label="Cobertura crítica"
          value={fmtNum(criticos)}
          sub="produtos abaixo do lead time"
          danger={criticos > 0}
        />
      </div>

      <div className="wms-toolbar">
        <div className="wms-search-wrap">
          <Icon name="search" size={13} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar SKU, descrição ou localização (ex: SP-03-02)…"
          />
          {q && (
            <button className="wms-search-clear" onClick={() => setQ("")}>
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
        {galpoes.length > 1 && (
          <div className="wms-seg">
            <button
              className={`wms-seg-btn ${filterGalpao === "all" ? "is-active" : ""}`}
              onClick={() => setFilterGalpao("all")}
            >
              Todos galpões
            </button>
            {galpoes.map((g) => (
              <button
                key={g.id}
                className={`wms-seg-btn ${filterGalpao === g.id ? "is-active" : ""}`}
                onClick={() => setFilterGalpao(g.id)}
              >
                {g.nome}
              </button>
            ))}
          </div>
        )}
        <select
          className="wms-select"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          style={{ width: 200 }}
        >
          <option value="all">Cobertura: todas</option>
          <option value="critico">Crítico</option>
          <option value="atencao">Atenção</option>
          <option value="ok">OK</option>
          <option value="sem_giro">Sem giro</option>
          <option value="lead_time_risco">Sem fornecedor</option>
        </select>
        <select
          className="wms-select"
          value={sortBy}
          onChange={(e) =>
            setSortBy(e.target.value as "saldo" | "atualizacao")
          }
          style={{ width: 200 }}
        >
          <option value="saldo">Ordenar: saldo</option>
          <option value="atualizacao">Ordenar: data atualização</option>
        </select>
      </div>

      <div className="wms-tbl">
        <table>
          <thead>
            <tr>
              <th style={{ width: 28 }}></th>
              <th style={{ width: 44 }}></th>
              <th>SKU</th>
              <th>Produto</th>
              <th className="wms-tar">Físico</th>
              <th className="wms-tar">Reservado</th>
              <th className="wms-tar">Disponível</th>
              <th className="wms-tar">Locais</th>
              <th>Cobertura</th>
              <th className="wms-tar">Custo médio</th>
              <th style={{ width: 110 }}></th>
            </tr>
          </thead>
          <tbody>
            {estoqueQuery.isLoading && (
              <tr>
                <td colSpan={11} className="wms-td-empty">
                  Carregando estoque…
                </td>
              </tr>
            )}
            {estoqueQuery.isError && (
              <tr>
                <td colSpan={11} className="wms-td-empty wms-td-danger">
                  Erro: {(estoqueQuery.error as Error).message}
                </td>
              </tr>
            )}
            {!estoqueQuery.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={11} className="wms-td-empty">
                  Nenhum produto encontrado.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const isExpanded = expanded === r.produtoId;
              return (
                <ExpandableRow
                  key={r.produtoId}
                  row={r}
                  expanded={isExpanded}
                  onToggle={() =>
                    setExpanded(isExpanded ? null : r.produtoId)
                  }
                  onOpenProduto={() => openDrawer(r.produtoId)}
                  onOpenLightbox={() => {
                    const imgs =
                      r.imagens.length > 0
                        ? r.imagens
                        : r.imagemUrl
                          ? [r.imagemUrl]
                          : [];
                    if (imgs.length > 0) {
                      setLightbox({
                        imagens: imgs,
                        sku: r.sku,
                        descricao: r.descricao,
                      });
                    }
                  }}
                  onAction={(kind) => {
                    const produto = {
                      id: r.produtoId,
                      sku: r.sku,
                      descricao: r.descricao,
                      gtin: null,
                      imagem_url: r.imagemUrl,
                      imagens: r.imagens,
                      unidade: "UN",
                      ncm: null,
                      cest: null,
                      origem_fiscal: null,
                      sincronizado_em: null,
                      ativo: true,
                      criado_em: "",
                      atualizado_em: "",
                    };
                    modals.open(kind, { produto });
                  }}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {drawerProdutoId && (
        <ProdutoDrawer produtoId={drawerProdutoId} onClose={closeDrawer} />
      )}

      {lightbox && (
        <ProdutoLightbox
          imagens={lightbox.imagens}
          sku={lightbox.sku}
          descricao={lightbox.descricao}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
}

function ExpandableRow({
  row,
  expanded,
  onToggle,
  onOpenProduto,
  onOpenLightbox,
  onAction,
}: {
  row: {
    produtoId: string;
    sku: string;
    descricao: string;
    imagemUrl: string | null;
    imagens: string[];
    saldo: number;
    reservado: number;
    disponivel: number;
    itens: EstoqueItem[];
    cobertura?: LinhaCobertura;
    custoMedio: number;
    atualizadoEm: number;
  };
  expanded: boolean;
  onToggle: () => void;
  onOpenProduto: () => void;
  onOpenLightbox: () => void;
  onAction: (kind: "receber" | "ajuste" | "transferir") => void;
}) {
  return (
    <>
      <tr
        className={`wms-tr-clickable ${expanded ? "is-expanded" : ""}`}
        onClick={onToggle}
      >
        <td>
          <button
            className="wms-tr-expand"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <Icon name={expanded ? "chevron-d" : "chevron-r"} size={11} />
          </button>
        </td>
        <td>
          {row.imagemUrl && (
            <img
              src={row.imagemUrl}
              alt=""
              loading="lazy"
              className="wms-thumb wms-thumb-sm wms-thumb-click"
              onClick={(e) => {
                e.stopPropagation();
                onOpenLightbox();
              }}
            />
          )}
        </td>
        <td className="wms-mono">
          <a
            className="wms-link-row"
            onClick={(e) => {
              e.stopPropagation();
              onOpenProduto();
            }}
          >
            {row.sku}
          </a>
        </td>
        <td className="wms-td-desc">
          <a
            className="wms-link-row"
            onClick={(e) => {
              e.stopPropagation();
              onOpenProduto();
            }}
          >
            {row.descricao}
          </a>
        </td>
        <td className="wms-tar wms-mono">{fmtNum(row.saldo)}</td>
        <td
          className={`wms-tar wms-mono ${
            row.reservado > 0 ? "wms-td-warn" : "wms-td-mute"
          }`}
        >
          {fmtNum(row.reservado)}
        </td>
        <td className="wms-tar wms-mono wms-td-strong">
          {fmtNum(row.disponivel)}
        </td>
        <td className="wms-tar wms-td-mute">{row.itens.length}</td>
        <td>
          {row.cobertura ? (
            <div className="wms-cov-cell">
              <StatusBadge status={row.cobertura.status_cobertura} />
              {row.cobertura.dias_cobertura != null && (
                <span className="wms-cov-dias">
                  {Number(row.cobertura.dias_cobertura).toFixed(0)}d
                </span>
              )}
            </div>
          ) : (
            <span className="wms-td-mute">—</span>
          )}
        </td>
        <td className="wms-tar wms-mono wms-td-mute">
          {fmtBRL(row.custoMedio)}
        </td>
        <td className="wms-td-actions">
          <button
            className="wms-btn-icon"
            title="Receber"
            onClick={(e) => {
              e.stopPropagation();
              onAction("receber");
            }}
          >
            <Icon name="plus" size={11} />
          </button>
          <button
            className="wms-btn-icon"
            title="Ajustar"
            onClick={(e) => {
              e.stopPropagation();
              onAction("ajuste");
            }}
          >
            <Icon name="minus" size={11} />
          </button>
          <button
            className="wms-btn-icon"
            title="Transferir"
            onClick={(e) => {
              e.stopPropagation();
              onAction("transferir");
            }}
          >
            <Icon name="arrow-right" size={11} />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="wms-tr-expanded">
          <td></td>
          <td colSpan={10}>
            <div className="wms-exp">
              <div className="wms-exp-grid">
                <div className="wms-exp-col">
                  <div className="wms-exp-h">
                    Distribuição por localização
                  </div>
                  <table className="wms-mini-tbl">
                    <thead>
                      <tr>
                        <th>Empresa</th>
                        <th>Galpão</th>
                        <th>Localização</th>
                        <th className="wms-tar">Saldo</th>
                        <th className="wms-tar">Reserv.</th>
                        <th className="wms-tar">Disp.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {row.itens.map((i, idx) => (
                        <tr key={idx}>
                          <td>
                            <span className="wms-chip-emp">
                              {i.empresa.nome.slice(0, 3).toUpperCase()}
                            </span>
                          </td>
                          <td className="wms-td-mute">{i.galpao.nome}</td>
                          <td className="wms-mono">{i.localizacao.codigo}</td>
                          <td className="wms-tar wms-mono">
                            {fmtNum(Number(i.saldo))}
                          </td>
                          <td
                            className={`wms-tar wms-mono ${
                              Number(i.reservado) > 0 ? "wms-td-warn" : ""
                            }`}
                          >
                            {Number(i.reservado) > 0
                              ? fmtNum(Number(i.reservado))
                              : "—"}
                          </td>
                          <td className="wms-tar wms-mono wms-td-strong">
                            {fmtNum(Number(i.disponivel))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="wms-exp-col">
                  <div className="wms-exp-h">Ações rápidas</div>
                  <div className="wms-exp-actions">
                    <button
                      className="wms-btn wms-btn-sm wms-btn-ghost"
                      onClick={onOpenProduto}
                    >
                      Abrir produto →
                    </button>
                    <button
                      className="wms-btn wms-btn-sm wms-btn-ghost"
                      onClick={() => onAction("receber")}
                    >
                      Entrada
                    </button>
                    <button
                      className="wms-btn wms-btn-sm wms-btn-ghost"
                      onClick={() => onAction("ajuste")}
                    >
                      Saída/ajuste
                    </button>
                    <button
                      className="wms-btn wms-btn-sm wms-btn-ghost"
                      onClick={() => onAction("transferir")}
                    >
                      Transferir
                    </button>
                  </div>
                  <div
                    className="wms-exp-h"
                    style={{ marginTop: 14 }}
                  >
                    Resumo
                  </div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                    <div>
                      <span className="wms-td-mute">Físico:</span>{" "}
                      <strong className="wms-mono">
                        {fmtNum(row.saldo)}
                      </strong>
                    </div>
                    <div>
                      <span className="wms-td-mute">Reservado:</span>{" "}
                      <span className="wms-mono wms-td-warn">
                        {fmtNum(row.reservado)}
                      </span>
                    </div>
                    <div>
                      <span className="wms-td-mute">Disponível:</span>{" "}
                      <strong className="wms-mono">
                        {fmtNum(row.disponivel)}
                      </strong>
                    </div>
                    <div>
                      <span className="wms-td-mute">Custo médio:</span>{" "}
                      <span className="wms-mono">
                        {fmtBRL(row.custoMedio)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function statusRank(s: string | null | undefined): number {
  switch (s) {
    case "critico":
      return 0;
    case "lead_time_risco":
      return 1;
    case "atencao":
      return 2;
    case "ok":
      return 3;
    case "sem_giro":
      return 4;
    default:
      return 5;
  }
}
