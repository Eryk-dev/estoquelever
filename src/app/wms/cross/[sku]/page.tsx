"use client";

import { useState, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";
import { PageHeader, Icon, fmtNum } from "@/components/wms/ui/wms-ui";
import { TIER_LABEL } from "@/lib/wms/trocas-equivalencia-regra";

type TierQualidade = "original" | "primeira_linha" | "segunda_linha";
type ParVerificacao = "verificado" | "bloqueado" | null;

interface EquivalenteRapido {
  sku: string;
  nome: string;
  fornecedor: string | null;
  marca: string | null;
  imagem_url: string | null;
  localizacao: string | null;
  origem: "oem" | "link" | "oem+link" | "cadeia";
  verificacao: ParVerificacao;
  tier_qualidade: TierQualidade | null;
}

interface EquivalentesRapidosResp {
  sku: string;
  tier_qualidade: TierQualidade | null;
  equivalentes: EquivalenteRapido[];
}

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
  const { can } = usePermissoes();
  const podeEditar = can("produtos.editar");
  const sku = decodeURIComponent(
    (params?.sku as string | undefined) ?? "",
  );
  const force = sp?.get("force") === "1";

  // Force refetch on mount se ?force=1
  useEffect(() => {
    if (force && sku) {
      sisoFetch(
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}/refetch`,
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
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}`,
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
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}/estoque`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!sku,
  });

  const equivalentesQuery = useQuery<EquivalentesRapidosResp>({
    queryKey: ["wms-cross-equivalentes-rapidos", sku],
    queryFn: async () => {
      const r = await sisoFetch(
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}/equivalentes-rapidos`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!sku,
  });

  const tierMut = useMutation({
    mutationFn: async (tier: TierQualidade | null) => {
      const r = await sisoFetch(
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}/tier`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier }),
        },
      );
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    onSuccess: () => {
      toast.success("Classificação atualizada");
      queryClient.invalidateQueries({
        queryKey: ["wms-cross-equivalentes-rapidos", sku],
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const verificarMut = useMutation({
    mutationFn: async (args: {
      skuAlvo: string;
      status: "verificado" | "bloqueado";
    }) => {
      const r = await sisoFetch(
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}/verificacao`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sku_alvo: args.skuAlvo, status: args.status }),
        },
      );
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    onSuccess: (_d, vars) => {
      toast.success(
        vars.status === "verificado"
          ? "Par marcado como verificado"
          : "Par bloqueado",
      );
      queryClient.invalidateQueries({
        queryKey: ["wms-cross-equivalentes-rapidos", sku],
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removerVerificacaoMut = useMutation({
    mutationFn: async (skuAlvo: string) => {
      const r = await sisoFetch(
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}/verificacao/${encodeURIComponent(skuAlvo)}`,
        { method: "DELETE" },
      );
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    onSuccess: () => {
      toast.success("Curadoria removida");
      queryClient.invalidateQueries({
        queryKey: ["wms-cross-equivalentes-rapidos", sku],
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const refetchTinyMut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch(
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}/refetch`,
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
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}/oems`,
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
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}/oems/${encodeURIComponent(codigo)}`,
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
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}/veiculos`,
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
        `/api/wms/cross/produtos/${encodeURIComponent(sku)}/veiculos/${encodeURIComponent(id)}`,
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
  const tierAtual = equivalentesQuery.data?.tier_qualidade ?? null;
  const equivalentes = equivalentesQuery.data?.equivalentes ?? [];

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

          {/* Classificação de qualidade (tier) */}
          <div
            style={{
              marginTop: 10,
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <span className="wms-td-mute" style={{ fontSize: 12 }}>
              Qualidade:
            </span>
            {tierAtual ? (
              <span
                className={`wms-badge ${
                  tierAtual === "original"
                    ? "wms-badge-ok"
                    : tierAtual === "primeira_linha"
                      ? "wms-badge-info"
                      : "wms-badge-warn"
                }`}
              >
                {TIER_LABEL[tierAtual]}
              </span>
            ) : (
              <span className="wms-badge wms-badge-mute">Sem classificação</span>
            )}
            {podeEditar && (
              <select
                className="wms-select"
                style={{ width: "auto", minWidth: 160 }}
                value={tierAtual ?? ""}
                disabled={tierMut.isPending}
                onChange={(e) =>
                  tierMut.mutate(
                    e.target.value
                      ? (e.target.value as TierQualidade)
                      : null,
                  )
                }
              >
                <option value="">Sem classificação</option>
                <option value="original">{TIER_LABEL.original}</option>
                <option value="primeira_linha">
                  {TIER_LABEL.primeira_linha}
                </option>
                <option value="segunda_linha">
                  {TIER_LABEL.segunda_linha}
                </option>
              </select>
            )}
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
            disabled={!novoOem.trim() || addOemMut.isPending || !podeEditar}
            title={!podeEditar ? "Sem permissão pra editar OEM" : ""}
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
                disabled={!podeEditar}
                title={!podeEditar ? "Sem permissão pra remover OEM" : "Remover OEM"}
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

      {/* Equivalências (curadoria) */}
      <h2 className="wms-sec-h">Equivalências (curadoria) ({equivalentes.length})</h2>
      <div className="wms-tbl" style={{ marginBottom: 24 }}>
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Produto</th>
              <th>Qualidade</th>
              <th>Curadoria</th>
              {podeEditar && <th className="wms-tar">Ações</th>}
            </tr>
          </thead>
          <tbody>
            {equivalentes.map((eq) => (
              <tr key={eq.sku}>
                <td className="wms-mono">{eq.sku}</td>
                <td>{eq.nome}</td>
                <td>
                  {eq.tier_qualidade ? (
                    <span className="wms-badge wms-badge-mute">
                      {TIER_LABEL[eq.tier_qualidade]}
                    </span>
                  ) : (
                    <span className="wms-td-mute">—</span>
                  )}
                </td>
                <td>
                  {eq.verificacao === "verificado" && (
                    <span className="wms-badge wms-badge-ok">
                      <Icon name="check" size={10} /> Verificado
                    </span>
                  )}
                  {eq.verificacao === "bloqueado" && (
                    <span className="wms-badge wms-badge-danger">
                      <Icon name="x" size={10} /> Bloqueado
                    </span>
                  )}
                  {eq.verificacao === null && (
                    <span className="wms-badge wms-badge-mute">
                      Não verificado
                    </span>
                  )}
                </td>
                {podeEditar && (
                  <td className="wms-tar">
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        justifyContent: "flex-end",
                        flexWrap: "wrap",
                      }}
                    >
                      {eq.verificacao !== "verificado" && (
                        <button
                          className="wms-btn wms-btn-sm wms-btn-ghost"
                          disabled={verificarMut.isPending}
                          onClick={() =>
                            verificarMut.mutate({
                              skuAlvo: eq.sku,
                              status: "verificado",
                            })
                          }
                        >
                          <Icon name="check" size={11} /> Verificar
                        </button>
                      )}
                      {eq.verificacao !== "bloqueado" && (
                        <button
                          className="wms-btn wms-btn-sm wms-btn-ghost"
                          disabled={verificarMut.isPending}
                          onClick={() =>
                            verificarMut.mutate({
                              skuAlvo: eq.sku,
                              status: "bloqueado",
                            })
                          }
                        >
                          <Icon name="x" size={11} /> Bloquear
                        </button>
                      )}
                      {eq.verificacao !== null && (
                        <button
                          className="wms-btn wms-btn-sm wms-btn-ghost"
                          disabled={removerVerificacaoMut.isPending}
                          onClick={() => removerVerificacaoMut.mutate(eq.sku)}
                        >
                          <Icon name="trash" size={11} /> Remover
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {equivalentes.length === 0 && (
              <tr>
                <td colSpan={podeEditar ? 5 : 4} className="wms-td-empty">
                  {equivalentesQuery.isLoading
                    ? "Carregando..."
                    : "Nenhuma equivalência encontrada (sem OEM compartilhado nem link)."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
              addVeicMut.isPending ||
              !podeEditar
            }
            title={!podeEditar ? "Sem permissão pra adicionar veículo" : ""}
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
                      disabled={!podeEditar}
                      title={!podeEditar ? "Sem permissão pra remover veículo" : "Remover veículo"}
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
