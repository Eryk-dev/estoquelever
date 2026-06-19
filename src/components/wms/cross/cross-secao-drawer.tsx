"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";
import { StatusBadge, fmtNum } from "@/components/wms/ui/wms-ui";

interface EquivalenteFicha {
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  status: "sugestao" | "confirmado" | "bloqueado";
  estoquePorGalpao: Record<string, { disponivel: number }>;
}

interface FichaResp {
  produto: { sku: string; descricao: string | null };
  equivalentes: EquivalenteFicha[];
}

export function CrossSecaoDrawer({ sku }: { sku: string }) {
  const { can } = usePermissoes();
  const q = useQuery<FichaResp>({
    queryKey: ["wms-cross-ficha", sku],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/cross/produtos/${encodeURIComponent(sku)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  if (q.isLoading) return <div className="wms-exp-empty" style={{ padding: 24 }}>Carregando…</div>;
  const eqs = q.data?.equivalentes ?? [];

  return (
    <div className="wms-cross-secao" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <strong>Equivalentes ({eqs.length})</strong>
        <div style={{ display: "flex", gap: 8 }}>
          <Link className="wms-btn wms-btn-ghost" href={`/wms/cross/${encodeURIComponent(sku)}`}>
            Abrir ficha →
          </Link>
        </div>
      </div>

      {eqs.length === 0 ? (
        <div className="wms-exp-empty">Sem cross. {can("produtos.editar") && "Ligue uma peça na ficha."}</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {eqs.map((e) => {
            const total = Object.values(e.estoquePorGalpao).reduce((s, g) => s + (g.disponivel ?? 0), 0);
            return (
              <div key={e.sku} className="wms-card" style={{ display: "flex", gap: 12, alignItems: "center", padding: 8 }}>
                {e.imagem_url && <img src={e.imagem_url} alt="" width={40} height={40} style={{ objectFit: "cover", borderRadius: 6 }} />}
                <div style={{ flex: 1 }}>
                  <div className="wms-mono">{e.sku}</div>
                  <div style={{ fontSize: 12, color: "var(--wms-c-muted)" }}>{e.descricao}</div>
                </div>
                <StatusBadge status={e.status} />
                <div className="wms-mono" title="nosso disponível (ledger)">{fmtNum(total)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
