"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { PageHeader, Icon, useAutoFocusRef } from "@/components/wms/ui/wms-ui";

type TipoBusca = "auto" | "sku" | "oem" | "nome";

interface OemResultado {
  codigo: string;
  marca?: string | null;
}

interface ResultadoBusca {
  sku: string;
  descricao: string;
  gtin?: string | null;
  ncm?: string | null;
  marca?: string | null;
  oem_correspondente?: string | null;
  score?: number;
  oems?: OemResultado[];
  veiculos?: unknown[];
}

interface RespostaBusca {
  query: string;
  total: number;
  tipo_detectado: string;
  resultados: ResultadoBusca[];
}

export default function WmsCrossPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tipo, setTipo] = useState<TipoBusca>("auto");
  const inputRef = useRef<HTMLInputElement>(null);
  useAutoFocusRef(inputRef);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isLoading, isError, error } = useQuery<RespostaBusca>({
    queryKey: ["wms-cross-search", debouncedQuery, tipo],
    queryFn: async () => {
      const r = await sisoFetch(
        `/api/wms/cross/search?q=${encodeURIComponent(debouncedQuery)}&tipo=${tipo}`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: debouncedQuery.trim().length >= 2,
  });

  const isSkuLike = /^[A-Z0-9.\-]{4,30}$/i.test(query.trim());

  return (
    <>
      <PageHeader
        title="Cross"
        subtitle="Busca universal por SKU, OEM ou nome — edição de catálogo cruzado"
      />

      <div className="wms-search-wrap" style={{ maxWidth: 640 }}>
        <Icon name="search" size={14} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar SKU, OEM ou nome do produto..."
        />
        {query && (
          <button
            className="wms-search-clear"
            onClick={() => setQuery("")}
            aria-label="Limpar"
          >
            <Icon name="x" size={11} />
          </button>
        )}
      </div>

      <div className="wms-seg" style={{ marginTop: 12 }}>
        <button
          className={`wms-seg-btn ${tipo === "auto" ? "is-active" : ""}`}
          onClick={() => setTipo("auto")}
        >
          Auto
        </button>
        <button
          className={`wms-seg-btn ${tipo === "sku" ? "is-active" : ""}`}
          onClick={() => setTipo("sku")}
        >
          SKU
        </button>
        <button
          className={`wms-seg-btn ${tipo === "oem" ? "is-active" : ""}`}
          onClick={() => setTipo("oem")}
        >
          OEM
        </button>
        <button
          className={`wms-seg-btn ${tipo === "nome" ? "is-active" : ""}`}
          onClick={() => setTipo("nome")}
        >
          Nome
        </button>
      </div>

      {debouncedQuery.trim().length < 2 && (
        <div className="wms-empty-block" style={{ marginTop: 24 }}>
          <h3>Comece a digitar</h3>
          <p>
            Busca SKU exato, OEM cruzado ou descrição parcial. Pílulas acima
            especializam.
          </p>
        </div>
      )}

      {debouncedQuery.trim().length >= 2 && isLoading && (
        <div className="wms-loading-pane">Buscando...</div>
      )}

      {isError && (
        <div className="wms-td-danger" style={{ marginTop: 16 }}>
          Erro: {(error as Error).message}
        </div>
      )}

      {data && data.total === 0 && (
        <div className="wms-empty-block" style={{ marginTop: 24 }}>
          <h3>Nenhum resultado pra &quot;{query}&quot;</h3>
          <p>Tente uma pílula diferente acima.</p>
          {isSkuLike && (
            <button
              className="wms-btn wms-btn-ghost"
              onClick={() =>
                router.push(
                  `/wms/cross/${encodeURIComponent(query.trim())}?force=1`,
                )
              }
            >
              <Icon name="rotate" size={11} /> Forçar consulta no Tiny
            </button>
          )}
        </div>
      )}

      {data && data.total > 0 && (
        <div style={{ marginTop: 16 }}>
          <div
            className="wms-td-mute"
            style={{ marginBottom: 8, fontSize: 11.5 }}
          >
            {data.total} resultado{data.total === 1 ? "" : "s"} · detectado como{" "}
            <strong>{data.tipo_detectado}</strong>
          </div>
          <div className="wms-tbl">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Descrição</th>
                  <th>Marca</th>
                  <th>GTIN</th>
                  <th>OEMs</th>
                  <th>Match</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.resultados.map((r) => {
                  const oems = r.oems ?? [];
                  return (
                    <tr
                      key={r.sku}
                      className="wms-tr-clickable"
                      onClick={() =>
                        router.push(`/wms/cross/${encodeURIComponent(r.sku)}`)
                      }
                    >
                      <td className="wms-mono">{r.sku}</td>
                      <td className="wms-td-desc">{r.descricao}</td>
                      <td>{r.marca || "—"}</td>
                      <td className="wms-mono wms-td-mute">{r.gtin || "—"}</td>
                      <td>
                        {oems
                          .slice(0, 3)
                          .map((o) => o.codigo)
                          .join(", ") || "—"}
                        {oems.length > 3 && ` +${oems.length - 3}`}
                      </td>
                      <td>
                        {r.oem_correspondente && (
                          <span className="wms-mono">
                            {r.oem_correspondente}
                          </span>
                        )}
                      </td>
                      <td>
                        <Icon name="chevron-r" size={11} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
