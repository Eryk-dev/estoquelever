"use client";
import { Fragment, useCallback, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useRouter, useSearchParams } from "next/navigation";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Icon,
  PageHeader,
  Pagination,
  fmtRelative,
} from "@/components/wms/ui/wms-ui";
import { ProdutoDrawer } from "@/components/wms/produto-drawer";
import { ProdutoLightbox } from "@/components/wms/produto-lightbox";
import type { Produto } from "@/lib/wms/types";

type TipoFiltro = "todos" | "kit" | "simples";
type SincFiltro = "tudo" | "24h" | "7d" | "30d" | "sem";

export default function ProdutosPage() {
  const [q, setQ] = useState("");
  const [tipoFiltro, setTipoFiltro] = useState<TipoFiltro>("todos");
  const [sincFiltro, setSincFiltro] = useState<SincFiltro>("tudo");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;
  const [lightbox, setLightbox] = useState<{
    imagens: string[];
    sku: string;
    descricao: string;
  } | null>(null);
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const drawerId = searchParams?.get("produto") ?? null;

  // Wrapper que reseta a página ao trocar a busca (evita ficar em página
  // vazia após buscar termo com poucos resultados).
  const handleSearchChange = (value: string) => {
    setQ(value);
    setPage(1);
  };

  const handleTipoChange = (value: TipoFiltro) => {
    setTipoFiltro(value);
    setPage(1);
  };

  const handleSincChange = (value: SincFiltro) => {
    setSincFiltro(value);
    setPage(1);
  };

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

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["wms-produtos", q, page, tipoFiltro, sincFiltro],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("q", q);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      params.set("incluir_kits_por_componente", q ? "true" : "false");
      if (tipoFiltro === "kit") params.set("eh_kit", "true");
      else if (tipoFiltro === "simples") params.set("eh_kit", "false");
      if (sincFiltro === "sem") {
        params.set("sem_sincronia", "true");
      } else if (sincFiltro !== "tudo") {
        const horas = sincFiltro === "24h" ? 24 : sincFiltro === "7d" ? 24 * 7 : 24 * 30;
        const desde = new Date(Date.now() - horas * 3600 * 1000).toISOString();
        params.set("sincronizado_apos", desde);
      }
      return wmsApi<{
        rows: Produto[];
        total: number;
        kits_por_componente?: number;
      }>(`/api/wms/produtos?${params.toString()}`);
    },
  });

  const sync = useMutation({
    mutationFn: (id: string) =>
      wmsApi<{ ok: true }>(`/api/wms/produtos/${id}/sync`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Sincronizado");
      queryClient.invalidateQueries({ queryKey: ["wms-produtos"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = data?.rows ?? [];
  const kitsExtras = data?.kits_por_componente ?? 0;
  const dividerAt = kitsExtras > 0 ? rows.length - kitsExtras : -1;

  return (
    <>
      <PageHeader
        title="Catálogo de produtos"
        subtitle={`siso_produtos · sincronizado com Tiny${
          data?.total != null ? ` · ${data.total} registros` : ""
        }`}
      />

      <div className="wms-toolbar">
        <div className="wms-search-wrap">
          <Icon name="search" size={13} />
          <input
            value={q}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="SKU, descrição, GTIN, localização ou cód. fornecedor…"
          />
          {q && (
            <button
              className="wms-search-clear"
              onClick={() => handleSearchChange("")}
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
        <select
          className="wms-select"
          value={tipoFiltro}
          onChange={(e) => handleTipoChange(e.target.value as TipoFiltro)}
          style={{ width: 170 }}
        >
          <option value="todos">Tipo: todos</option>
          <option value="kit">Kits</option>
          <option value="simples">Produtos simples</option>
        </select>
        <select
          className="wms-select"
          value={sincFiltro}
          onChange={(e) => handleSincChange(e.target.value as SincFiltro)}
          style={{ width: 200 }}
        >
          <option value="tudo">Sincronização: tudo</option>
          <option value="24h">Últimas 24h</option>
          <option value="7d">Últimos 7 dias</option>
          <option value="30d">Últimos 30 dias</option>
          <option value="sem">Sem sincronia</option>
        </select>
      </div>

      {isLoading && (
        <div className="wms-loading-pane">Carregando catálogo…</div>
      )}
      {isError && (
        <div className="wms-empty-block">
          <h3>Erro</h3>
          <p>{(error as Error).message}</p>
        </div>
      )}
      {!isLoading && rows.length === 0 && (
        <div className="wms-empty-block">
          <h3>
            {q || tipoFiltro !== "todos" || sincFiltro !== "tudo"
              ? "Nenhum produto encontrado"
              : "Nenhum produto cadastrado"}
          </h3>
          <p>
            {q || tipoFiltro !== "todos" || sincFiltro !== "tudo"
              ? "Tente afrouxar os filtros ou a busca."
              : "Sincronize com o Tiny para popular o catálogo."}
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th style={{ width: 44 }}></th>
                <th>SKU</th>
                <th>Descrição</th>
                <th>GTIN</th>
                <th>NCM</th>
                <th>Sincronizado</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, idx) => (
                <Fragment key={p.id}>
                {idx === dividerAt && (
                  <tr>
                    <td colSpan={7} style={{
                      padding: "8px 12px",
                      background: "var(--wms-c-panel-2)",
                      fontSize: 11.5,
                      textTransform: "uppercase",
                      letterSpacing: ".06em",
                      color: "var(--wms-c-mute)",
                      fontWeight: 600,
                      borderTop: "1px solid var(--wms-c-border)",
                      borderBottom: "1px solid var(--wms-c-border)",
                    }}>
                      Kits que contêm “{q}” como componente
                    </td>
                  </tr>
                )}
                <tr className="wms-tr-clickable">
                  <td>
                    {p.imagem_url && (
                      <img
                        src={p.imagem_url}
                        alt=""
                        loading="lazy"
                        className="wms-thumb wms-thumb-sm wms-thumb-click"
                        onClick={(e) => {
                          e.stopPropagation();
                          setLightbox({
                            imagens:
                              p.imagens && p.imagens.length > 0
                                ? p.imagens
                                : [p.imagem_url!],
                            sku: p.sku,
                            descricao: p.descricao,
                          });
                        }}
                      />
                    )}
                  </td>
                  <td className="wms-mono">
                    <a
                      className="wms-link-row"
                      onClick={() => openDrawer(p.id)}
                    >
                      {p.sku}
                    </a>
                  </td>
                  <td className="wms-td-desc">
                    <a
                      className="wms-link-row"
                      onClick={() => openDrawer(p.id)}
                    >
                      {p.descricao}
                    </a>
                  </td>
                  <td className="wms-mono wms-td-mute">{p.gtin ?? "—"}</td>
                  <td className="wms-mono wms-td-mute">{p.ncm ?? "—"}</td>
                  <td className="wms-td-mute" style={{ fontSize: 12 }}>
                    {p.sincronizado_em
                      ? fmtRelative(p.sincronizado_em)
                      : "nunca"}
                  </td>
                  <td className="wms-td-actions">
                    <button
                      type="button"
                      className="wms-btn-icon"
                      title="Sincronizar com Tiny"
                      disabled={sync.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        sync.mutate(p.id);
                      }}
                    >
                      <Icon name="rotate" size={11} />
                    </button>
                    <button
                      type="button"
                      className="wms-btn-icon"
                      title="Abrir detalhe"
                      onClick={() => openDrawer(p.id)}
                    >
                      <Icon name="chevron-r" size={11} />
                    </button>
                  </td>
                </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        total={data?.total ?? 0}
        pageSize={PAGE_SIZE}
        page={page}
        onPageChange={setPage}
        label="produtos"
      />

      {drawerId && (
        <ProdutoDrawer produtoId={drawerId} onClose={closeDrawer} />
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
