"use client";
import { useCallback, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useRouter, useSearchParams } from "next/navigation";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Icon,
  PageHeader,
  fmtRelative,
} from "@/components/wms/ui/wms-ui";
import { ProdutoDrawer } from "@/components/wms/produto-drawer";
import type { Produto } from "@/lib/wms/types";

export default function ProdutosPage() {
  const [q, setQ] = useState("");
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const drawerId = searchParams?.get("produto") ?? null;

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
    queryKey: ["wms-produtos", q],
    queryFn: () =>
      wmsApi<{ rows: Produto[]; total: number }>(
        `/api/wms/produtos?q=${encodeURIComponent(q)}`,
      ),
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
            onChange={(e) => setQ(e.target.value)}
            placeholder="SKU, descrição ou GTIN…"
          />
          {q && (
            <button className="wms-search-clear" onClick={() => setQ("")}>
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
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
            {q ? "Nenhum produto encontrado" : "Nenhum produto cadastrado"}
          </h3>
          <p>
            {q
              ? `Tente outra busca por SKU, descrição ou GTIN.`
              : "Sincronize com o Tiny para popular o catálogo."}
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Descrição</th>
                <th>GTIN</th>
                <th>NCM</th>
                <th>Sincronizado</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="wms-tr-clickable">
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
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawerId && (
        <ProdutoDrawer produtoId={drawerId} onClose={closeDrawer} />
      )}
    </>
  );
}
