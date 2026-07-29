"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useSearchParams, useRouter } from "next/navigation";
import { wmsApi } from "@/lib/wms/api-client";
import type { Produto } from "@/lib/wms/types";
import {
  PageHeader,
  Icon,
  Kpi,
  Pagination,
  StatusBadge,
  fmtBRL,
  fmtNum,
} from "@/components/wms/ui/wms-ui";
import { useWmsModals } from "@/components/wms/wms-shell";
import { ProdutoDrawer } from "@/components/wms/produto-drawer";
import { ProdutoLightbox } from "@/components/wms/produto-lightbox";
import type { LinhaCobertura } from "@/lib/wms/cobertura";
import { useAuth } from "@/lib/auth-context";

interface EstoqueItem {
  id: string;
  saldo: number;
  reservado: number;
  disponivel: number;
  atualizado_em: string;
  produto: {
    id: string;
    sku: string;
    descricao: string;
    imagem_url: string | null;
    imagens: string[];
  };
  galpao: { id: string; nome: string };
  localizacao: { id: string; codigo: string; tipo: string };
}

interface EstoqueAgregado {
  chave: string;
  nome: string;
  saldo: number;
  reservado: number;
  disponivel: number;
  // 3D: custo médio é global por SKU. Vem direto do agregado em view=produto.
  custo_medio: number;
  itens: EstoqueItem[];
}

export default function EstoquePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Drawer state vive na URL (?produto=ID) — sobrevive a F5 e dá link
  // compartilhável. Cmd+K e clique na tabela usam o mesmo mecanismo.
  const drawerProdutoId = searchParams?.get("produto") ?? null;

  // Galpão filter vem só da sidebar (auth-context). Sem pílula inline pra
  // evitar duas fontes de verdade.
  const { activeGalpaoId } = useAuth();
  const filterGalpao = activeGalpaoId ?? "all";

  const [q, setQ] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"saldo" | "atualizacao">("saldo");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;
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

  // Prefetch das queries do drawer no hover (uma vez por id). Keys/fns idênticas
  // às do ProdutoDrawer pra o open() acertar o cache.
  const queryClient = useQueryClient();
  const prefetchedProduto = useRef(new Set<string>());
  const prefetchProduto = useCallback(
    (id: string) => {
      if (prefetchedProduto.current.has(id)) return;
      prefetchedProduto.current.add(id);
      void queryClient.prefetchQuery({
        queryKey: ["wms-produto", id],
        queryFn: () => wmsApi(`/api/wms/produtos/${id}`),
      });
      void queryClient.prefetchQuery({
        queryKey: ["wms-produto-estoque", id],
        queryFn: () =>
          wmsApi(`/api/wms/estoque?view=produto&produto_id=${id}`),
      });
    },
    [queryClient],
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

  // Busca paralela em `siso_produtos` quando há query (≥2 chars). Cobre 3
  // casos que o cache de saldo (`siso_estoque` filtrado por saldo>0) não
  // pega sozinho:
  //   • Kit que casa pelo próprio SKU/descrição (kit nunca tem linha em
  //     siso_estoque — saldo é derivado dos componentes).
  //   • Kit cujos componentes casam com `q` (mostrado como "kits que
  //     contêm X como componente").
  //   • Produto simples que casa mas está zerado — operador precisa ver
  //     pra confirmar fisicamente a ausência.
  const buscaQuery = useQuery({
    queryKey: ["wms-estoque-busca-produtos", q],
    queryFn: () =>
      wmsApi<{
        rows: Produto[];
        total: number;
        kits_por_componente?: number;
        equivalentes_cross?: number;
      }>(
        `/api/wms/produtos?q=${encodeURIComponent(q)}&limit=20&offset=0&incluir_kits_por_componente=true&incluir_equivalentes_cross=true`,
      ),
    enabled: q.trim().length >= 2,
    // Cada caractere digitado muda a queryKey — sem placeholder os resultados
    // somem/piscam a cada tecla. Mantém os anteriores enquanto busca.
    placeholderData: keepPreviousData,
  });
  // `rows` da API: matches diretos primeiro, depois kits-por-componente,
  // depois equivalentes-cross. Os counts no fim indicam quantas linhas são de
  // cada bloco — fatiamos de trás pra frente.
  const matchesDiretos = useMemo<Produto[]>(() => {
    const d = buscaQuery.data;
    if (!d) return [];
    const extras = (d.kits_por_componente ?? 0) + (d.equivalentes_cross ?? 0);
    return d.rows.slice(0, d.rows.length - extras);
  }, [buscaQuery.data]);
  const kitsDiretos = useMemo<Produto[]>(
    () => matchesDiretos.filter((p) => p.eh_kit),
    [matchesDiretos],
  );
  const kitsViaComponente = useMemo<Produto[]>(() => {
    const d = buscaQuery.data;
    const k = d?.kits_por_componente ?? 0;
    if (!d || k === 0) return [];
    const e = d.equivalentes_cross ?? 0;
    return d.rows.slice(d.rows.length - e - k, d.rows.length - e);
  }, [buscaQuery.data]);
  const equivalentesCross = useMemo<Produto[]>(() => {
    const d = buscaQuery.data;
    const e = d?.equivalentes_cross ?? 0;
    if (!d || e === 0) return [];
    return d.rows.slice(d.rows.length - e);
  }, [buscaQuery.data]);

  // Map cobertura por produto. Quando filtra por galpão, considera só
  // cobertura desse galpão; caso contrário agrega o pior status do produto.
  const coberturaMap = useMemo(() => {
    const m = new Map<string, LinhaCobertura>();
    for (const r of coberturaQuery.data?.rows ?? []) {
      if (filterGalpao !== "all" && r.galpao_id !== filterGalpao) continue;
      const cur = m.get(r.produto_id);
      if (
        !cur ||
        statusRank(r.status_cobertura) < statusRank(cur.status_cobertura)
      ) {
        m.set(r.produto_id, r);
      }
    }
    return m;
  }, [coberturaQuery.data, filterGalpao]);

  // Estoque agregado por produtoId (chave). Usado pelas linhas de equivalente,
  // que não estão em `rows` (SKU != busca) mas têm estoque no cache global.
  const estoqueAggMap = useMemo(() => {
    const m = new Map<string, EstoqueAgregado>();
    for (const r of estoqueQuery.data?.rows ?? []) m.set(r.chave, r);
    return m;
  }, [estoqueQuery.data]);

  const stockForProduto = useCallback(
    (produtoId: string) => {
      const agg = estoqueAggMap.get(produtoId);
      if (!agg) return null;
      const itens =
        filterGalpao === "all"
          ? agg.itens
          : agg.itens.filter((i) => i.galpao.id === filterGalpao);
      if (itens.length === 0) return null;
      const saldo = itens.reduce((s, i) => s + Number(i.saldo), 0);
      const reservado = itens.reduce((s, i) => s + Number(i.reservado), 0);
      const disponivel = itens.reduce((s, i) => s + Number(i.disponivel), 0);
      return { saldo, reservado, disponivel, locais: itens.length };
    },
    [estoqueAggMap, filterGalpao],
  );

  const rows = useMemo(() => {
    let result = (estoqueQuery.data?.rows ?? []).map((r) => {
      const sku = r.itens[0]?.produto.sku ?? "";
      const descricao = r.itens[0]?.produto.descricao ?? r.nome;
      const imagemUrl = r.itens[0]?.produto.imagem_url ?? null;
      const imagens = r.itens[0]?.produto.imagens ?? [];
      const cobertura = coberturaMap.get(r.chave);
      // 3D: custo médio é global por SKU — vem do agregado.
      const custoMedio = Number(r.custo_medio ?? 0);
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
      // Filtra E re-totaliza por galpão. Caso contrário a linha mostraria
      // o agregado cross-galpão mesmo com pílula CWB/SP selecionada.
      result = result
        .map((r) => {
          const itens = r.itens.filter((i) => i.galpao.id === filterGalpao);
          if (itens.length === 0) return null;
          const saldo = itens.reduce((s, i) => s + Number(i.saldo), 0);
          const reservado = itens.reduce(
            (s, i) => s + Number(i.reservado),
            0,
          );
          const disponivel = itens.reduce(
            (s, i) => s + Number(i.disponivel),
            0,
          );
          // 3D: custo médio global do produto — não muda ao filtrar galpão.
          const custoMedio = r.custoMedio;
          const atualizadoEm = itens.reduce((max, i) => {
            const t = i.atualizado_em
              ? new Date(i.atualizado_em).getTime()
              : 0;
            return t > max ? t : max;
          }, 0);
          return {
            ...r,
            itens,
            saldo,
            reservado,
            disponivel,
            custoMedio,
            atualizadoEm,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
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

  // Produtos simples que casaram com `q` mas não estão em `rows` (não têm
  // saldo no escopo filtrado — galpão/status/busca). Renderizados como
  // linhas "Sem estoque" pro operador confirmar fisicamente.
  const produtosSemEstoque = useMemo<Produto[]>(() => {
    if (matchesDiretos.length === 0) return [];
    const comEstoqueIds = new Set(rows.map((r) => r.produtoId));
    return matchesDiretos.filter((p) => !p.eh_kit && !comEstoqueIds.has(p.id));
  }, [matchesDiretos, rows]);

  // Indica se a busca trouxe ALGO renderizável (kit/sem-estoque), pra não
  // mostrar "Nenhum produto encontrado" quando os extras existem.
  const buscaTemExtras =
    kitsDiretos.length > 0 ||
    kitsViaComponente.length > 0 ||
    equivalentesCross.length > 0 ||
    produtosSemEstoque.length > 0;

  const totalRows = rows.length;
  // Derive-during-render: se a página atual está além do total filtrado,
  // volta pra 1 sem disparar useEffect (padrão recomendado pelo React).
  const maxPage = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  const currentPage = Math.min(page, maxPage);
  const pagedRows = useMemo(
    () => rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [rows, currentPage],
  );

  const totalSaldo = rows.reduce((s, r) => s + r.saldo, 0);
  const totalReservado = rows.reduce((s, r) => s + r.reservado, 0);
  const totalDisp = totalSaldo - totalReservado;
  const totalValor = rows.reduce((s, r) => s + r.saldo * r.custoMedio, 0);
  const criticos = rows.filter(
    (r) => r.cobertura?.status_cobertura === "critico",
  ).length;

  // Quando o filtro narrowou pra 1 produto, mostra custo médio global no
  // subtitle do header — é informação chave pra esse modo de leitura.
  const subtitle =
    rows.length === 1
      ? `${rows[0].sku} · ${fmtNum(rows[0].saldo)} un · custo médio ${fmtBRL(
          rows[0].custoMedio,
        )} · ${fmtBRL(rows[0].saldo * rows[0].custoMedio)} em estoque`
      : `${rows.length} produtos · ${fmtNum(totalSaldo)} unidades · ${fmtBRL(
          totalValor,
        )} em estoque`;

  return (
    <>
      <PageHeader
        title="Estoque"
        subtitle={subtitle}
        backHref="/wms"
        backLabel="Voltar ao WMS"
      >
        <button
          className="wms-btn wms-btn-ghost"
          onClick={() => router.push("/wms/estoque/sem-anuncio")}
        >
          <Icon name="search" size={12} />
          Conferir anúncios ML
        </button>
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
            {estoqueQuery.isLoading &&
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={`skel-${i}`}>
                  <td colSpan={11} style={{ padding: "4px 8px" }}>
                    <div className="wms-skel wms-skel-row" />
                  </td>
                </tr>
              ))}
            {estoqueQuery.isError && (
              <tr>
                <td colSpan={11} className="wms-td-empty wms-td-danger">
                  Erro: {(estoqueQuery.error as Error).message}
                </td>
              </tr>
            )}
            {!estoqueQuery.isLoading &&
              rows.length === 0 &&
              !buscaTemExtras && (
                <tr>
                  <td colSpan={11} className="wms-td-empty">
                    Nenhum produto encontrado.
                  </td>
                </tr>
              )}
            {kitsDiretos.length > 0 && currentPage === 1 && (
              <>
                <SectionHeaderRow>Kits encontrados</SectionHeaderRow>
                {kitsDiretos.map((kit) => (
                  <KitLiteRow
                    key={`kit-direct-${kit.id}`}
                    kit={kit}
                    onOpenDrawer={openDrawer}
                    onHover={prefetchProduto}
                  />
                ))}
              </>
            )}
            {pagedRows.map((r) => {
              const isExpanded = expanded === r.produtoId;
              return (
                <ExpandableRow
                  key={r.produtoId}
                  row={r}
                  expanded={isExpanded}
                  onToggle={() =>
                    setExpanded(isExpanded ? null : r.produtoId)
                  }
                  onHover={() => prefetchProduto(r.produtoId)}
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
                      eh_kit: false,
                      criado_em: "",
                      atualizado_em: "",
                    };
                    modals.open(kind, { produto });
                  }}
                />
              );
            })}
            {equivalentesCross.length > 0 && currentPage === 1 && (
              <>
                <SectionHeaderRow>
                  Equivalentes (cross) de “{q}”
                </SectionHeaderRow>
                {equivalentesCross.map((eq) => (
                  <EquivalenteRow
                    key={`equiv-${eq.id}`}
                    produto={eq}
                    stock={stockForProduto(eq.id)}
                    onOpenDrawer={openDrawer}
                    onHover={prefetchProduto}
                  />
                ))}
              </>
            )}
            {produtosSemEstoque.length > 0 && currentPage === 1 && (
              <>
                <SectionHeaderRow>
                  Sem estoque — confirme fisicamente
                </SectionHeaderRow>
                {produtosSemEstoque.map((p) => (
                  <SemEstoqueRow
                    key={`zero-${p.id}`}
                    produto={p}
                    onOpenDrawer={openDrawer}
                    onHover={prefetchProduto}
                  />
                ))}
              </>
            )}
            {kitsViaComponente.length > 0 && currentPage === 1 && (
              <>
                <SectionHeaderRow>
                  Kits que contêm “{q}” como componente
                </SectionHeaderRow>
                {kitsViaComponente.map((kit) => (
                  <KitLiteRow
                    key={`kit-comp-${kit.id}`}
                    kit={kit}
                    onOpenDrawer={openDrawer}
                    onHover={prefetchProduto}
                  />
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        total={totalRows}
        pageSize={PAGE_SIZE}
        page={currentPage}
        onPageChange={setPage}
        label="produtos"
      />

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
  onHover,
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
  onHover: () => void;
  onOpenProduto: () => void;
  onOpenLightbox: () => void;
  onAction: (kind: "receber" | "ajuste" | "transferir" | "etiquetas") => void;
}) {
  return (
    <>
      <tr
        className={`wms-tr-clickable ${expanded ? "is-expanded" : ""}`}
        onClick={onToggle}
        onMouseEnter={onHover}
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
                    <button
                      className="wms-btn wms-btn-sm wms-btn-ghost"
                      onClick={() => onAction("etiquetas")}
                    >
                      <Icon name="printer" size={11} />
                      Imprimir etiquetas
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

function SectionHeaderRow({ children }: { children: React.ReactNode }) {
  return (
    <tr>
      <td
        colSpan={11}
        style={{
          padding: "8px 12px",
          background: "var(--wms-c-panel-2)",
          fontSize: 11.5,
          textTransform: "uppercase",
          letterSpacing: ".06em",
          color: "var(--wms-c-mute)",
          fontWeight: 600,
          borderTop: "1px solid var(--wms-c-border)",
          borderBottom: "1px solid var(--wms-c-border)",
        }}
      >
        {children}
      </td>
    </tr>
  );
}

function KitLiteRow({
  kit,
  onOpenDrawer,
  onHover,
}: {
  kit: Produto;
  onOpenDrawer: (id: string) => void;
  onHover?: (id: string) => void;
}) {
  return (
    <tr
      className="wms-tr-clickable"
      onClick={() => onOpenDrawer(kit.id)}
      onMouseEnter={() => onHover?.(kit.id)}
    >
      <td></td>
      <td>
        {kit.imagem_url && (
          <img
            src={kit.imagem_url}
            alt=""
            loading="lazy"
            className="wms-thumb wms-thumb-sm"
          />
        )}
      </td>
      <td className="wms-mono">
        <a className="wms-link-row">{kit.sku}</a>
      </td>
      <td className="wms-td-desc">
        <span className="wms-badge wms-badge-info" style={{ marginRight: 6 }}>
          Kit
        </span>
        <a className="wms-link-row">{kit.descricao}</a>
      </td>
      <td
        className="wms-tar wms-mono wms-td-mute"
        title="Kit virtual — sem saldo próprio"
      >
        —
      </td>
      <td className="wms-tar wms-mono wms-td-mute">—</td>
      <td
        className="wms-tar wms-mono wms-td-mute"
        title="Veja o detalhe pra disponibilidade derivada"
      >
        —
      </td>
      <td className="wms-tar wms-td-mute">—</td>
      <td className="wms-td-mute" style={{ fontSize: 12 }}>
        Disponibilidade derivada dos componentes
      </td>
      <td className="wms-tar wms-td-mute">—</td>
      <td className="wms-td-actions">
        <button
          className="wms-btn-icon"
          title="Abrir detalhe do kit"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDrawer(kit.id);
          }}
        >
          <Icon name="chevron-r" size={11} />
        </button>
      </td>
    </tr>
  );
}

function SemEstoqueRow({
  produto,
  onOpenDrawer,
  onHover,
}: {
  produto: Produto;
  onOpenDrawer: (id: string) => void;
  onHover?: (id: string) => void;
}) {
  return (
    <tr
      className="wms-tr-clickable"
      onClick={() => onOpenDrawer(produto.id)}
      onMouseEnter={() => onHover?.(produto.id)}
    >
      <td></td>
      <td>
        {produto.imagem_url && (
          <img
            src={produto.imagem_url}
            alt=""
            loading="lazy"
            className="wms-thumb wms-thumb-sm"
          />
        )}
      </td>
      <td className="wms-mono">
        <a className="wms-link-row">{produto.sku}</a>
      </td>
      <td className="wms-td-desc">
        <a className="wms-link-row">{produto.descricao}</a>
      </td>
      <td className="wms-tar wms-mono wms-td-mute">0</td>
      <td className="wms-tar wms-mono wms-td-mute">0</td>
      <td className="wms-tar wms-mono wms-td-mute">0</td>
      <td className="wms-tar wms-td-mute">0</td>
      <td>
        <span className="wms-badge wms-badge-warn">Sem estoque</span>
      </td>
      <td className="wms-tar wms-td-mute">—</td>
      <td className="wms-td-actions">
        <button
          className="wms-btn-icon"
          title="Abrir produto"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDrawer(produto.id);
          }}
        >
          <Icon name="chevron-r" size={11} />
        </button>
      </td>
    </tr>
  );
}

function EquivalenteRow({
  produto,
  stock,
  onOpenDrawer,
  onHover,
}: {
  produto: Produto;
  stock: {
    saldo: number;
    reservado: number;
    disponivel: number;
    locais: number;
  } | null;
  onOpenDrawer: (id: string) => void;
  onHover?: (id: string) => void;
}) {
  const semEstoque = !stock || stock.saldo === 0;
  return (
    <tr
      className="wms-tr-clickable"
      onClick={() => onOpenDrawer(produto.id)}
      onMouseEnter={() => onHover?.(produto.id)}
    >
      <td></td>
      <td>
        {produto.imagem_url && (
          <img
            src={produto.imagem_url}
            alt=""
            loading="lazy"
            className="wms-thumb wms-thumb-sm"
          />
        )}
      </td>
      <td className="wms-mono">
        <a className="wms-link-row">{produto.sku}</a>
      </td>
      <td className="wms-td-desc">
        <span className="wms-badge wms-badge-cross" style={{ marginRight: 6 }}>
          Equivalente
        </span>
        <a className="wms-link-row">{produto.descricao}</a>
      </td>
      <td className="wms-tar wms-mono">{stock ? fmtNum(stock.saldo) : "0"}</td>
      <td
        className={`wms-tar wms-mono ${
          stock && stock.reservado > 0 ? "wms-td-warn" : "wms-td-mute"
        }`}
      >
        {stock ? fmtNum(stock.reservado) : "0"}
      </td>
      <td className="wms-tar wms-mono wms-td-strong">
        {stock ? fmtNum(stock.disponivel) : "0"}
      </td>
      <td className="wms-tar wms-td-mute">{stock ? stock.locais : 0}</td>
      <td>
        {semEstoque ? (
          <span className="wms-badge wms-badge-warn">Sem estoque</span>
        ) : (
          <span className="wms-td-mute">—</span>
        )}
      </td>
      <td className="wms-tar wms-td-mute">—</td>
      <td className="wms-td-actions">
        <button
          className="wms-btn-icon"
          title="Abrir produto"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDrawer(produto.id);
          }}
        >
          <Icon name="chevron-r" size={11} />
        </button>
      </td>
    </tr>
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
