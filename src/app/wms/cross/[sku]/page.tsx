"use client";

import { use, useEffect, useState } from "react";
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
interface OndeComprarLinha {
  sku: string;
  origem: "proprio" | "equivalente";
  fornecedorId: string | null;
  nome: string;
  codigo_fornecedor: string | null;
  custo_unitario: number | null;
  galpao_id: string | null;
  galpao_nome: string | null;
  preferencial: boolean;
}
interface Ficha {
  produto: { sku: string; descricao: string | null; imagem_url: string | null; oem: string[] | null };
  nossoEstoquePorGalpao: Record<string, { saldo: number; reservado: number; disponivel: number }>;
  equivalentes: Equivalente[];
  ondeComprar: OndeComprarLinha[];
}
interface ResultadoBusca {
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  status_cross: "confirmado" | "sugestao" | "sem_cross";
  match?: { tipo: "codigo_fornecedor" | "oem"; valor: string; fornecedor?: string | null };
}

function useDebounce<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function CrossFichaPage({ params }: { params: Promise<{ sku: string }> }) {
  const { sku } = use(params);
  const skuDec = decodeURIComponent(sku);
  const { can } = usePermissoes();
  const qc = useQueryClient();

  const q = useQuery<Ficha>({
    queryKey: ["wms-cross-ficha", skuDec],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/cross/produtos/${encodeURIComponent(skuDec)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
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

      {/* NOSSO ESTOQUE */}
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

      {/* OEM */}
      <OemEditor
        key={(q.data?.produto.oem ?? []).join("|")}
        sku={skuDec}
        oem={q.data?.produto.oem ?? []}
        editavel={can("produtos.editar")}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["wms-cross-ficha", skuDec] });
          qc.invalidateQueries({ queryKey: ["wms-cross-fila"] });
        }}
      />

      {/* LIGAR PEÇA (picker por sku/oem/código) */}
      {can("produtos.editar") && (
        <LigarPicker
          sku={skuDec}
          onLigado={() => qc.invalidateQueries({ queryKey: ["wms-cross-ficha", skuDec] })}
        />
      )}

      {/* ONDE COMPRAR (pool: próprio + equivalentes confirmados) */}
      <section className="wms-card" style={{ padding: 16, marginBottom: 16 }}>
        <strong>Onde comprar</strong>
        <div style={{ fontSize: 12, color: "var(--wms-c-muted)", margin: "2px 0 10px" }}>
          fornecedores deste SKU + dos equivalentes confirmados
        </div>
        {(q.data?.ondeComprar ?? []).length === 0 ? (
          <div className="wms-exp-empty">Nenhum fornecedor cadastrado pra este grupo.</div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {(q.data?.ondeComprar ?? []).map((l, i) => (
              <div
                key={`${l.sku}-${l.fornecedorId ?? l.nome}-${i}`}
                style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "6px 0", borderTop: i ? "1px solid var(--wms-c-border)" : "none" }}
              >
                <span style={{ fontWeight: 600 }}>{l.nome}</span>
                {l.preferencial && <span className="wms-badge wms-badge-ok">preferencial</span>}
                {l.codigo_fornecedor && <span className="wms-mono wms-chip" title="código no fornecedor">{l.codigo_fornecedor}</span>}
                {l.galpao_nome && <span className="wms-chip">{l.galpao_nome}</span>}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: "var(--wms-c-muted)" }}>
                  {l.origem === "proprio" ? "deste item" : `via ${l.sku}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* EQUIVALENTES */}
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

function OemEditor({
  sku,
  oem,
  editavel,
  onSaved,
}: {
  sku: string;
  oem: string[];
  editavel: boolean;
  onSaved: () => void;
}) {
  const [lista, setLista] = useState<string[]>(oem);
  const [novo, setNovo] = useState("");
  // `lista` re-inicializa via `key` no parent (remount quando o oem salvo muda).

  const salvar = useMutation({
    mutationFn: async (codigos: string[]) => {
      const r = await sisoFetch(`/api/wms/cross/produtos/${encodeURIComponent(sku)}/oem`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oem: codigos }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("OEM salvo");
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const add = () => {
    const v = novo.trim();
    if (!v || lista.includes(v)) return;
    setLista([...lista, v]);
    setNovo("");
  };
  const remove = (v: string) => setLista(lista.filter((x) => x !== v));
  const dirty = lista.join("|") !== oem.join("|");

  if (!editavel && lista.length === 0) return null;

  return (
    <section className="wms-card" style={{ padding: 16, marginBottom: 16 }}>
      <strong>Código original (OEM)</strong>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>
        {lista.length === 0 && <span style={{ fontSize: 13, color: "var(--wms-c-muted)" }}>Nenhum OEM cadastrado.</span>}
        {lista.map((v) => (
          <span key={v} className="wms-chip wms-mono" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {v}
            {editavel && (
              <button onClick={() => remove(v)} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--wms-c-muted)", padding: 0 }} title="remover">×</button>
            )}
          </span>
        ))}
      </div>
      {editavel && (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="wms-input"
            placeholder="ex.: 4B0260403R"
            value={novo}
            onChange={(e) => setNovo(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          />
          <button className="wms-btn wms-btn-ghost" onClick={add} disabled={!novo.trim()}>Adicionar</button>
          <button className="wms-btn wms-btn-primary" onClick={() => salvar.mutate(lista)} disabled={!dirty || salvar.isPending}>Salvar OEM</button>
        </div>
      )}
    </section>
  );
}

function LigarPicker({ sku, onLigado }: { sku: string; onLigado: () => void }) {
  const [busca, setBusca] = useState("");
  const debounced = useDebounce(busca, 300);

  const res = useQuery<{ resultados: ResultadoBusca[] }>({
    queryKey: ["wms-cross-busca-ligar", debounced],
    queryFn: async ({ signal }) => {
      const r = await sisoFetch(`/api/wms/cross/search?q=${encodeURIComponent(debounced)}`, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: debounced.trim().length >= 2,
  });

  const ligar = useMutation({
    mutationFn: async (alvo: string) => {
      const r = await sisoFetch(`/api/wms/cross/ligar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku_a: sku, sku_b: alvo }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success("Palpite criado — entra na fila de validação");
      setBusca("");
      onLigado();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resultados = (res.data?.resultados ?? []).filter((r) => r.sku !== sku);

  return (
    <section className="wms-card" style={{ padding: 16, marginBottom: 16 }}>
      <strong>Ligar peça</strong>
      <div style={{ fontSize: 12, color: "var(--wms-c-muted)", margin: "2px 0 8px" }}>
        busca por SKU, código original (OEM) ou código de fornecedor
      </div>
      <input
        className="wms-input"
        placeholder="SKU, OEM ou código do fornecedor…"
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        style={{ width: "100%" }}
      />
      {debounced.trim().length >= 2 && (
        <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
          {res.isLoading && <div style={{ fontSize: 13, color: "var(--wms-c-muted)" }}>Buscando…</div>}
          {!res.isLoading && resultados.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--wms-c-muted)" }}>Nada encontrado.</div>
          )}
          {resultados.map((r) => (
            <button
              key={r.sku}
              onClick={() => ligar.mutate(r.sku)}
              disabled={ligar.isPending}
              style={{ display: "flex", gap: 10, alignItems: "center", textAlign: "left", border: "1px solid var(--wms-c-border)", borderRadius: 8, background: "var(--wms-c-surface)", padding: 8, cursor: "pointer" }}
            >
              {r.imagem_url && <img src={r.imagem_url} alt="" width={36} height={36} style={{ objectFit: "cover", borderRadius: 6 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="wms-mono">{r.sku}</div>
                <div style={{ fontSize: 12, color: "var(--wms-c-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.descricao}</div>
                {r.match && (
                  <div style={{ fontSize: 11, color: "var(--wms-c-muted)" }}>
                    via {r.match.tipo === "oem" ? "OEM" : (r.match.fornecedor ?? "fornecedor")} {r.match.valor}
                  </div>
                )}
              </div>
              {r.status_cross !== "sem_cross" && <StatusBadge status={r.status_cross} />}
              <span className="wms-btn wms-btn-primary wms-btn-sm">Ligar</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
