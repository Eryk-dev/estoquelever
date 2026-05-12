"use client";

import { useState, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { PageHeader, Icon, fmtNum } from "@/components/wms/ui/wms-ui";

interface OemDetalhe {
  codigo: string;
  marca?: string | null;
}

interface VeiculoDetalhe {
  id: string;
  marca: string;
  modelo: string;
  ano_inicio?: number | null;
  ano_fim?: number | null;
  motorizacao?: string | null;
}

interface DetalheProduto {
  sku: string;
  descricao: string;
  gtin: string | null;
  ncm: string | null;
  marca: string | null;
  imagem_url: string | null;
  oems: OemDetalhe[];
  veiculos: VeiculoDetalhe[];
  referencia_at?: string | null;
}

interface EstoqueGalpao {
  saldo: number;
  reservado: number;
  disponivel: number;
  localizacoes?: string[];
}

export default function WmsCrossDetalhePage() {
  const params = useParams();
  const sp = useSearchParams();
  const queryClient = useQueryClient();
  const sku = decodeURIComponent(
    (params?.sku as string | undefined) ?? "",
  );
  const force = sp?.get("force") === "1";

  // Force refetch on mount se ?force=1
  useEffect(() => {
    if (force && sku) {
      sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/refetch`,
        { method: "POST" },
      )
        .then(() =>
          queryClient.invalidateQueries({
            queryKey: ["wms-cross-detalhe", sku],
          }),
        )
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [force, sku]);

  const detalheQuery = useQuery<DetalheProduto>({
    queryKey: ["wms-cross-detalhe", sku],
    queryFn: async () => {
      const r = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!sku,
  });

  const estoqueQuery = useQuery<{
    estoque_por_galpao: Record<string, EstoqueGalpao>;
  }>({
    queryKey: ["wms-cross-estoque", sku],
    queryFn: async () => {
      const r = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/estoque`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!sku,
  });

  const refetchTinyMut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/refetch`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      toast.success("Sincronizado com Tiny");
      queryClient.invalidateQueries({
        queryKey: ["wms-cross-detalhe", sku],
      });
      queryClient.invalidateQueries({
        queryKey: ["wms-cross-estoque", sku],
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addOemMut = useMutation({
    mutationFn: async (codigo: string) => {
      const r = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/oems`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codigo }),
        },
      );
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      return json as { ok: boolean; aviso?: string };
    },
    onSuccess: (data) => {
      if (data.aviso) toast.warning(`Adicionado. Aviso: ${data.aviso}`);
      else toast.success("OEM adicionado");
      queryClient.invalidateQueries({
        queryKey: ["wms-cross-detalhe", sku],
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeOemMut = useMutation({
    mutationFn: async (codigo: string) => {
      const r = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/oems/${encodeURIComponent(codigo)}`,
        { method: "DELETE" },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    },
    onSuccess: () => {
      toast.success("OEM removido");
      queryClient.invalidateQueries({
        queryKey: ["wms-cross-detalhe", sku],
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addVeicMut = useMutation({
    mutationFn: async (payload: {
      marca: string;
      modelo: string;
      ano_inicio?: number;
      ano_fim?: number;
      motorizacao?: string;
    }) => {
      const r = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/veiculos`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    },
    onSuccess: () => {
      toast.success("Veículo adicionado");
      queryClient.invalidateQueries({
        queryKey: ["wms-cross-detalhe", sku],
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeVeicMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/veiculos/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    },
    onSuccess: () => {
      toast.success("Veículo removido");
      queryClient.invalidateQueries({
        queryKey: ["wms-cross-detalhe", sku],
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [novoOem, setNovoOem] = useState("");
  const [novoVeic, setNovoVeic] = useState({
    marca: "",
    modelo: "",
    ano_inicio: "",
    ano_fim: "",
    motorizacao: "",
  });

  if (detalheQuery.isLoading) {
    return <div className="wms-loading-pane">Carregando…</div>;
  }
  if (detalheQuery.isError) {
    return (
      <div className="wms-td-danger">
        Erro: {(detalheQuery.error as Error).message}
      </div>
    );
  }

  const d = detalheQuery.data!;
  const estoque = estoqueQuery.data?.estoque_por_galpao ?? {};

  return (
    <>
      <PageHeader
        title={d.sku}
        subtitle={d.descricao}
        backHref="/wms/cross"
        backLabel="Voltar à busca"
      >
        <button
          className="wms-btn wms-btn-ghost"
          disabled={refetchTinyMut.isPending}
          onClick={() => refetchTinyMut.mutate()}
        >
          <Icon name="rotate" size={12} />{" "}
          {refetchTinyMut.isPending ? "Sincronizando..." : "Atualizar do Tiny"}
        </button>
      </PageHeader>

      {/* Cabeçalho do produto */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "120px 1fr",
          gap: 16,
          marginBottom: 24,
          background: "var(--wms-c-panel)",
          border: "1px solid var(--wms-c-border)",
          borderRadius: "var(--wms-r-3)",
          padding: 14,
        }}
      >
        {d.imagem_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={d.imagem_url}
            alt=""
            style={{
              width: 120,
              height: 120,
              objectFit: "contain",
              borderRadius: "var(--wms-r-2)",
              background: "var(--wms-c-faint)",
            }}
          />
        ) : (
          <div
            style={{
              width: 120,
              height: 120,
              background: "var(--wms-c-faint)",
              borderRadius: "var(--wms-r-2)",
            }}
          />
        )}
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
            {d.descricao}
          </h2>
          <div
            style={{
              marginTop: 6,
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              fontSize: 12,
            }}
          >
            <span>
              <span className="wms-td-mute">SKU: </span>
              <span className="wms-mono">{d.sku}</span>
            </span>
            <span>
              <span className="wms-td-mute">GTIN: </span>
              <span className="wms-mono">{d.gtin || "—"}</span>
            </span>
            <span>
              <span className="wms-td-mute">NCM: </span>
              <span className="wms-mono">{d.ncm || "—"}</span>
            </span>
            <span>
              <span className="wms-td-mute">Marca: </span>
              {d.marca || "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Estoque por galpão */}
      <h2 className="wms-sec-h">Estoque por galpão</h2>
      <div className="wms-tbl" style={{ marginBottom: 24 }}>
        <table>
          <thead>
            <tr>
              <th>Galpão</th>
              <th className="wms-tar">Saldo</th>
              <th className="wms-tar">Reservado</th>
              <th className="wms-tar">Disponível</th>
              <th>Localizações</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(estoque).map(([galpao, e]) => (
              <tr key={galpao}>
                <td>
                  <span
                    className={`wms-pcard-chip is-galpao is-${galpao.toLowerCase()}`}
                  >
                    {galpao}
                  </span>
                </td>
                <td className="wms-tar wms-mono">{fmtNum(e.saldo)}</td>
                <td
                  className={`wms-tar wms-mono ${e.reservado > 0 ? "wms-td-warn" : "wms-td-mute"}`}
                >
                  {fmtNum(e.reservado)}
                </td>
                <td className="wms-tar wms-mono wms-td-strong">
                  {fmtNum(e.disponivel)}
                </td>
                <td className="wms-mono wms-td-mute">
                  {(e.localizacoes || []).join(", ") || "—"}
                </td>
              </tr>
            ))}
            {Object.keys(estoque).length === 0 && (
              <tr>
                <td colSpan={5} className="wms-td-empty">
                  {estoqueQuery.isLoading
                    ? "Carregando..."
                    : "Sem estoque registrado"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* OEMs */}
      <h2 className="wms-sec-h">OEMs ({d.oems.length})</h2>
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <input
            className="wms-input wms-mono"
            placeholder="Bipe ou cole código OEM..."
            value={novoOem}
            onChange={(e) => setNovoOem(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && novoOem.trim()) {
                addOemMut.mutate(novoOem.trim());
                setNovoOem("");
              }
            }}
          />
          <button
            className="wms-btn wms-btn-primary"
            disabled={!novoOem.trim() || addOemMut.isPending}
            onClick={() => {
              addOemMut.mutate(novoOem.trim());
              setNovoOem("");
            }}
          >
            <Icon name="plus" size={11} /> Adicionar
          </button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {d.oems.map((o) => (
            <span
              key={o.codigo}
              className="wms-pcard-chip"
              style={{ fontSize: 11 }}
            >
              <span className="wms-mono">{o.codigo}</span>
              {o.marca && (
                <span className="wms-td-mute" style={{ marginLeft: 4 }}>
                  {o.marca}
                </span>
              )}
              <button
                className="wms-btn-icon"
                style={{ marginLeft: 4, height: 18, width: 18 }}
                onClick={() => removeOemMut.mutate(o.codigo)}
                aria-label="Remover OEM"
              >
                <Icon name="x" size={9} />
              </button>
            </span>
          ))}
          {d.oems.length === 0 && (
            <span className="wms-td-mute" style={{ fontSize: 12 }}>
              Nenhum OEM cadastrado.
            </span>
          )}
        </div>
      </div>

      {/* Veículos */}
      <h2 className="wms-sec-h">
        Compatibilidade veicular ({d.veiculos.length})
      </h2>
      <div style={{ marginBottom: 24 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr) auto",
            gap: 6,
            marginBottom: 8,
          }}
        >
          <input
            className="wms-input"
            placeholder="Marca"
            value={novoVeic.marca}
            onChange={(e) =>
              setNovoVeic({ ...novoVeic, marca: e.target.value })
            }
          />
          <input
            className="wms-input"
            placeholder="Modelo"
            value={novoVeic.modelo}
            onChange={(e) =>
              setNovoVeic({ ...novoVeic, modelo: e.target.value })
            }
          />
          <input
            className="wms-input"
            placeholder="Ano início"
            type="number"
            value={novoVeic.ano_inicio}
            onChange={(e) =>
              setNovoVeic({ ...novoVeic, ano_inicio: e.target.value })
            }
          />
          <input
            className="wms-input"
            placeholder="Ano fim"
            type="number"
            value={novoVeic.ano_fim}
            onChange={(e) =>
              setNovoVeic({ ...novoVeic, ano_fim: e.target.value })
            }
          />
          <input
            className="wms-input"
            placeholder="Motorização"
            value={novoVeic.motorizacao}
            onChange={(e) =>
              setNovoVeic({ ...novoVeic, motorizacao: e.target.value })
            }
          />
          <button
            className="wms-btn wms-btn-primary"
            disabled={
              !novoVeic.marca.trim() ||
              !novoVeic.modelo.trim() ||
              addVeicMut.isPending
            }
            onClick={() => {
              const payload: {
                marca: string;
                modelo: string;
                ano_inicio?: number;
                ano_fim?: number;
                motorizacao?: string;
              } = {
                marca: novoVeic.marca.trim(),
                modelo: novoVeic.modelo.trim(),
              };
              if (novoVeic.ano_inicio) {
                payload.ano_inicio = Number(novoVeic.ano_inicio);
              }
              if (novoVeic.ano_fim) {
                payload.ano_fim = Number(novoVeic.ano_fim);
              }
              if (novoVeic.motorizacao.trim()) {
                payload.motorizacao = novoVeic.motorizacao.trim();
              }
              addVeicMut.mutate(payload);
              setNovoVeic({
                marca: "",
                modelo: "",
                ano_inicio: "",
                ano_fim: "",
                motorizacao: "",
              });
            }}
            aria-label="Adicionar veículo"
          >
            <Icon name="plus" size={11} />
          </button>
        </div>
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th>Marca</th>
                <th>Modelo</th>
                <th>Ano início</th>
                <th>Ano fim</th>
                <th>Motorização</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {d.veiculos.map((v) => (
                <tr key={v.id}>
                  <td>{v.marca}</td>
                  <td>{v.modelo}</td>
                  <td className="wms-mono">{v.ano_inicio || "—"}</td>
                  <td className="wms-mono">{v.ano_fim || "—"}</td>
                  <td>{v.motorizacao || "—"}</td>
                  <td>
                    <button
                      className="wms-btn-icon"
                      onClick={() => removeVeicMut.mutate(v.id)}
                      aria-label="Remover veículo"
                    >
                      <Icon name="trash" size={11} />
                    </button>
                  </td>
                </tr>
              ))}
              {d.veiculos.length === 0 && (
                <tr>
                  <td colSpan={6} className="wms-td-empty">
                    Nenhum veículo cadastrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
