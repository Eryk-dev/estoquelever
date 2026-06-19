"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ProdutoComparador, type LadoComparacao } from "@/components/wms/produto-lightbox";
import { sisoFetch } from "@/lib/auth-context";

interface ProdLado {
  sku: string;
  descricao: string | null;
  imagens: string[] | null;
  imagem_url: string | null;
}
interface FilaItem {
  id: number;
  sku_a: string;
  sku_b: string;
  fonte: string;
  a: ProdLado | null;
  b: ProdLado | null;
  oem_compartilhado?: string[];
}

function imgs(p: ProdLado | null): string[] {
  if (!p) return [];
  if (p.imagens && p.imagens.length) return p.imagens;
  return p.imagem_url ? [p.imagem_url] : [];
}

function Pane({ rotulo, prod }: { rotulo: string; prod: ProdLado | null }) {
  const fotos = imgs(prod);
  return (
    <div className="wms-card" style={{ padding: 12, flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "var(--wms-c-muted)", marginBottom: 6 }}>{rotulo}</div>
      {fotos[0] ? (
        <img src={fotos[0]} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "contain", borderRadius: 6, background: "var(--wms-c-faint)" }} />
      ) : (
        <div style={{ width: "100%", aspectRatio: "1", borderRadius: 6, background: "var(--wms-c-faint)" }} />
      )}
      <div className="wms-mono" style={{ marginTop: 8 }}>{prod?.sku ?? "—"}</div>
      <div style={{ fontSize: 12, color: "var(--wms-c-muted)" }}>{prod?.descricao ?? ""}</div>
    </div>
  );
}

export function CrossFila() {
  const qc = useQueryClient();
  const [i, setI] = useState(0);
  const [ampliar, setAmpliar] = useState(false);

  const q = useQuery<{ itens: FilaItem[] }>({
    queryKey: ["wms-cross-fila"],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/cross/fila`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  const itens = q.data?.itens ?? [];
  const atual = itens[i];

  const decidir = useMutation({
    mutationFn: async (acao: "confirmar" | "bloquear") => {
      if (!atual) return;
      const r = await sisoFetch(`/api/wms/cross/${atual.id}/decidir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acao }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: (_d, acao) => {
      toast.success(acao === "confirmar" ? "Confirmado ✓" : "Bloqueado 🚫");
      qc.invalidateQueries({ queryKey: ["wms-cross-fila"] });
      qc.invalidateQueries({ queryKey: ["wms-cross-ficha"] });
      setI((n) => n); // mantém índice; a lista encolhe
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pular = () => setI((n) => Math.min(n + 1, itens.length - 1));

  // Atalhos: ✓ = → / Enter; ✗ = ←; pular = espaço. Desligados com o zoom aberto.
  useEffect(() => {
    const h = (ev: KeyboardEvent) => {
      if (!atual || decidir.isPending || ampliar) return;
      if (ev.key === "ArrowRight" || ev.key === "Enter") decidir.mutate("confirmar");
      else if (ev.key === "ArrowLeft") decidir.mutate("bloquear");
      else if (ev.key === " ") { ev.preventDefault(); pular(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [atual, decidir.isPending, ampliar]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isLoading) return <div className="wms-exp-empty" style={{ padding: 24 }}>Carregando…</div>;
  if (itens.length === 0) return <div className="wms-exp-empty" style={{ padding: 24 }}>Fila vazia — nada pra validar.</div>;
  if (!atual) return <div className="wms-exp-empty" style={{ padding: 24 }}>Fim da fila.</div>;

  const esquerda: LadoComparacao = { rotulo: "Peça A", sku: atual.sku_a, descricao: atual.a?.descricao ?? "", imagens: imgs(atual.a) };
  const direita: LadoComparacao = { rotulo: "Peça B", sku: atual.sku_b, descricao: atual.b?.descricao ?? "", imagens: imgs(atual.b) };

  return (
    <div className="wms-cross-fila">
      <div style={{ marginBottom: 8, color: "var(--wms-c-muted)" }}>
        {i + 1} / {itens.length} · ligado por: {atual.fonte}
      </div>

      {atual.oem_compartilhado && atual.oem_compartilhado.length > 0 && (
        <div style={{ marginBottom: 8, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--wms-c-muted)" }}>compartilham OEM:</span>
          {atual.oem_compartilhado.map((o) => (
            <span key={o} className="wms-chip wms-mono">{o}</span>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        <Pane rotulo="Peça A" prod={atual.a} />
        <Pane rotulo="Peça B" prod={atual.b} />
      </div>

      <div style={{ display: "flex", gap: 12, justifyContent: "center", alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
        <button className="wms-btn wms-btn-danger" disabled={decidir.isPending} onClick={() => decidir.mutate("bloquear")}>✗ Não (←)</button>
        <button className="wms-btn wms-btn-ghost" onClick={() => setAmpliar(true)}>Ampliar fotos</button>
        <button className="wms-btn wms-btn-ghost" onClick={pular}>Pular (espaço)</button>
        <button className="wms-btn wms-btn-primary" disabled={decidir.isPending} onClick={() => decidir.mutate("confirmar")}>✓ É a mesma (→)</button>
      </div>

      {ampliar && (
        <ProdutoComparador esquerda={esquerda} direita={direita} onClose={() => setAmpliar(false)} />
      )}
    </div>
  );
}
