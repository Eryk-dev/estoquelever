"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { PageHeader, StatusBadge } from "@/components/wms/ui/wms-ui";
import { usePermissoes } from "@/lib/auth-context";
import { sisoFetch } from "@/lib/auth-context";
import { CrossFila } from "@/components/wms/cross/cross-fila";

type Aba = "buscar" | "fila";

interface ResultadoBusca {
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  status_cross: "confirmado" | "sugestao" | "sem_cross";
}

export default function CrossPage() {
  const { can } = usePermissoes();
  const [aba, setAba] = useState<Aba>("buscar");
  const [q, setQ] = useState("");
  const debounced = useDebounce(q, 300);

  const busca = useQuery<{ resultados: ResultadoBusca[] }>({
    queryKey: ["wms-cross-busca", debounced],
    queryFn: async ({ signal }) => {
      const r = await sisoFetch(`/api/wms/cross/search?q=${encodeURIComponent(debounced)}`, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: debounced.trim().length >= 2,
  });

  const resultados = busca.data?.resultados ?? [];
  const contadores = useMemo(() => {
    const c = { confirmado: 0, sugestao: 0, sem_cross: 0 };
    for (const r of resultados) c[r.status_cross]++;
    return c;
  }, [resultados]);

  return (
    <>
      <PageHeader title="Cross" subtitle="Dicionário de peças equivalentes">
        <div style={{ display: "flex", gap: 8 }}>
          <button className={`wms-btn ${aba === "buscar" ? "wms-btn-primary" : "wms-btn-ghost"}`} onClick={() => setAba("buscar")}>Buscar</button>
          {can("vendas.aprovar_troca") && (
            <button className={`wms-btn ${aba === "fila" ? "wms-btn-primary" : "wms-btn-ghost"}`} onClick={() => setAba("fila")}>Fila de validação</button>
          )}
        </div>
      </PageHeader>

      {aba === "fila" ? (
        <CrossFila />
      ) : (
        <>
          <input className="wms-input" placeholder="SKU, OEM ou nome…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%", marginBottom: 12 }} />
          {debounced.trim().length >= 2 && (
            <div style={{ display: "flex", gap: 12, marginBottom: 12, color: "var(--wms-c-muted)" }}>
              <span>✓ confirmadas: {contadores.confirmado}</span>
              <span>● aguardando: {contadores.sugestao}</span>
              <span>○ sem cross: {contadores.sem_cross}</span>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
            {resultados.map((r) => (
              <Link key={r.sku} href={`/wms/cross/${encodeURIComponent(r.sku)}`} className="wms-card" style={{ padding: 10, textDecoration: "none" }}>
                {r.imagem_url && <img src={r.imagem_url} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6 }} />}
                <div className="wms-mono" style={{ marginTop: 6 }}>{r.sku}</div>
                <div style={{ fontSize: 12, color: "var(--wms-c-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.descricao}</div>
                <div style={{ marginTop: 6 }}>
                  <StatusBadge status={r.status_cross === "sem_cross" ? "sem cross" : r.status_cross} />
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function useDebounce<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
