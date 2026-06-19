"use client";

import { use, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader, StatusBadge, fmtNum } from "@/components/wms/ui/wms-ui";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";

interface Equivalente {
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  status: "sugestao" | "confirmado" | "bloqueado";
  estoquePorGalpao: Record<string, { saldo: number; reservado: number; disponivel: number }>;
}
interface Ficha {
  produto: { sku: string; descricao: string | null; imagem_url: string | null };
  nossoEstoquePorGalpao: Record<string, { saldo: number; reservado: number; disponivel: number }>;
  equivalentes: Equivalente[];
}

export default function CrossFichaPage({ params }: { params: Promise<{ sku: string }> }) {
  const { sku } = use(params);
  const skuDec = decodeURIComponent(sku);
  const { can } = usePermissoes();
  const qc = useQueryClient();
  const [novoSku, setNovoSku] = useState("");

  const q = useQuery<Ficha>({
    queryKey: ["wms-cross-ficha", skuDec],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/cross/produtos/${encodeURIComponent(skuDec)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  const ligar = useMutation({
    mutationFn: async (alvo: string) => {
      const r = await sisoFetch(`/api/wms/cross/ligar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku_a: skuDec, sku_b: alvo }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Palpite criado — entra na fila de validação");
      setNovoSku("");
      qc.invalidateQueries({ queryKey: ["wms-cross-ficha", skuDec] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const ledgerTotal = (m: Record<string, { disponivel: number }>) =>
    Object.values(m).reduce((s, g) => s + (g.disponivel ?? 0), 0);

  return (
    <>
      <PageHeader
        title={`Cross · ${skuDec}`}
        subtitle={q.data?.produto.descricao ?? ""}
        backHref="/wms/cross"
        backLabel="Cross"
      />

      {/* NOSSO ESTOQUE — bloco próprio */}
      <section className="wms-card" style={{ padding: 16, marginBottom: 16 }}>
        <strong>Nosso estoque (ledger)</strong>
        <div className="wms-mono" style={{ fontSize: 22 }}>
          {q.data ? fmtNum(ledgerTotal(q.data.nossoEstoquePorGalpao)) : "—"} disponível
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
          {Object.entries(q.data?.nossoEstoquePorGalpao ?? {}).map(([g, v]) => (
            <span key={g} className="wms-chip">{g}: {fmtNum(v.disponivel)}</span>
          ))}
        </div>
      </section>

      {can("produtos.editar") && (
        <section className="wms-card" style={{ padding: 16, marginBottom: 16 }}>
          <strong>Ligar peça</strong>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              className="wms-input"
              placeholder="SKU equivalente"
              value={novoSku}
              onChange={(e) => setNovoSku(e.target.value)}
            />
            <button className="wms-btn wms-btn-primary" disabled={!novoSku.trim() || ligar.isPending} onClick={() => ligar.mutate(novoSku.trim())}>
              Ligar
            </button>
          </div>
        </section>
      )}

      <section>
        <strong>Equivalentes ({q.data?.equivalentes.length ?? 0})</strong>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          {(q.data?.equivalentes ?? []).map((e) => (
            <div key={e.sku} className="wms-card" style={{ display: "flex", gap: 12, alignItems: "center", padding: 10 }}>
              {e.imagem_url && <img src={e.imagem_url} alt="" width={48} height={48} style={{ objectFit: "cover", borderRadius: 6 }} />}
              <div style={{ flex: 1 }}>
                <div className="wms-mono">{e.sku}</div>
                <div style={{ fontSize: 12, color: "var(--wms-c-muted)" }}>{e.descricao}</div>
              </div>
              <StatusBadge status={e.status} />
              <div className="wms-mono" title="nosso disponível (ledger)">{fmtNum(ledgerTotal(e.estoquePorGalpao))}</div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
