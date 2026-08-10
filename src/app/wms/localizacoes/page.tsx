"use client";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Icon,
  PageHeader,
  Pagination,
  LocTipoBadge,
  Field,
} from "@/components/wms/ui/wms-ui";
import { Portal } from "@/components/wms/ui/portal";
import type { Localizacao, TipoLocalizacao } from "@/lib/wms/types";
import { useAuth, usePermissoes } from "@/lib/auth-context";

const TIPOS: TipoLocalizacao[] = [
  "picking",
  "overstock",
  "recebimento",
  "expedicao",
  "quarentena",
];

type Modo = "individual" | "lote";

type LoteForm = {
  prefixo: string;
  h_inicio: number;
  h_fim: number;
  v_inicio: number;
  v_fim: number;
  tipo: TipoLocalizacao;
};

type LoteResponse = {
  total: number;
  criadas: number;
  ja_existiam: number;
  amostra: { primeiras: string[]; ultimas: string[] };
};

type SaldoLinha = {
  produto_id: string;
  saldo: number;
  sku: string | null;
  descricao: string | null;
};

type SaldosResponse = {
  rows: SaldoLinha[];
  total_qty: number;
  total_linhas: number;
};

const LOTE_DEFAULT: LoteForm = {
  prefixo: "",
  h_inicio: 1,
  h_fim: 10,
  v_inicio: 1,
  v_fim: 10,
  tipo: "picking",
};

export default function LocalizacoesPage() {
  const queryClient = useQueryClient();
  const { activeGalpaoId, activeGalpaoPodeEditar } = useAuth();
  const { can } = usePermissoes();
  const podeEditar = can("localizacoes.editar") && activeGalpaoPodeEditar;
  const podeImprimir = can("operacoes.imprimir");
  const galpaoId = activeGalpaoId ?? "";
  const [showForm, setShowForm] = useState(false);
  const [modo, setModo] = useState<Modo>("individual");
  const [page, setPage] = useState(1);
  const [busca, setBusca] = useState("");
  const PAGE_SIZE = 100;
  const [novo, setNovo] = useState({
    codigo: "",
    descricao: "",
    tipo: "picking" as TipoLocalizacao,
  });
  const [lote, setLote] = useState<LoteForm>(LOTE_DEFAULT);
  const [preview, setPreview] = useState<LoteResponse | null>(null);
  const [excluindo, setExcluindo] = useState<Localizacao | null>(null);
  const [destinoSubsId, setDestinoSubsId] = useState<string>("");
  const [editandoTipoId, setEditandoTipoId] = useState<string | null>(null);

  useEffect(() => {
    setPage(1);
  }, [activeGalpaoId]);

  useEffect(() => {
    setPage(1);
  }, [busca]);

  const locsQuery = useQuery({
    queryKey: ["wms-locs", galpaoId],
    queryFn: () =>
      wmsApi<{ rows: Localizacao[] }>(
        `/api/wms/localizacoes?galpao_id=${galpaoId}`,
      ),
    enabled: !!galpaoId,
  });

  const criar = useMutation({
    mutationFn: () =>
      wmsApi<Localizacao>("/api/wms/localizacoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ galpao_id: galpaoId, ...novo }),
      }),
    onSuccess: () => {
      toast.success("Localização criada");
      setNovo({ codigo: "", descricao: "", tipo: "picking" });
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["wms-locs", galpaoId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const fecharForm = () => {
    setShowForm(false);
    setPreview(null);
    setLote(LOTE_DEFAULT);
    setModo("individual");
  };

  const visualizar = useMutation({
    mutationFn: () =>
      wmsApi<LoteResponse>("/api/wms/localizacoes/lote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          galpao_id: galpaoId,
          prefixo: lote.prefixo.toUpperCase(),
          h_inicio: lote.h_inicio,
          h_fim: lote.h_fim,
          v_inicio: lote.v_inicio,
          v_fim: lote.v_fim,
          tipo: lote.tipo,
          preview: true,
        }),
      }),
    onSuccess: (data) => setPreview(data),
    onError: (e: Error) => toast.error(e.message),
  });

  const criarLote = useMutation({
    mutationFn: () =>
      wmsApi<LoteResponse>("/api/wms/localizacoes/lote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          galpao_id: galpaoId,
          prefixo: lote.prefixo.toUpperCase(),
          h_inicio: lote.h_inicio,
          h_fim: lote.h_fim,
          v_inicio: lote.v_inicio,
          v_fim: lote.v_fim,
          tipo: lote.tipo,
          preview: false,
        }),
      }),
    onSuccess: (data) => {
      toast.success(
        `Criadas ${data.criadas}${
          data.ja_existiam > 0 ? ` (${data.ja_existiam} já existiam)` : ""
        }`,
      );
      fecharForm();
      queryClient.invalidateQueries({ queryKey: ["wms-locs", galpaoId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saldosQuery = useQuery({
    queryKey: ["wms-loc-saldos", excluindo?.id],
    queryFn: () =>
      wmsApi<SaldosResponse>(
        `/api/wms/localizacoes/${excluindo!.id}/saldos`,
      ),
    enabled: !!excluindo,
  });

  const trocarTipo = useMutation({
    mutationFn: ({ id, tipo }: { id: string; tipo: TipoLocalizacao }) =>
      wmsApi<Localizacao>(`/api/wms/localizacoes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tipo }),
      }),
    onSuccess: () => {
      toast.success("Tipo atualizado");
      setEditandoTipoId(null);
      queryClient.invalidateQueries({ queryKey: ["wms-locs", galpaoId] });
    },
    onError: (e: Error) => {
      toast.error(e.message);
      setEditandoTipoId(null);
    },
  });

  const imprimirEndereco = useMutation({
    mutationFn: ({ codigo, tipo }: { codigo: string; tipo: "pequena" | "grande" }) =>
      wmsApi<{ ok: true; printerNome: string }>("/api/wms/etiquetas/endereco", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ galpao_id: galpaoId, codigos: [codigo], tipo }),
      }),
    onSuccess: (data) => toast.success(`Etiqueta enviada para ${data.printerNome || "a impressora"}`),
    onError: (e: Error) => toast.error(e.message),
  });

  const excluirSimples = useMutation({
    mutationFn: (id: string) =>
      wmsApi<{ ok: true }>(`/api/wms/localizacoes/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Localização removida");
      setExcluindo(null);
      setDestinoSubsId("");
      queryClient.invalidateQueries({ queryKey: ["wms-locs", galpaoId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const substituirEExcluir = useMutation({
    mutationFn: () =>
      wmsApi<{
        ok: true;
        origem_codigo: string;
        destino_codigo: string;
        itens_movidos: number;
      }>(`/api/wms/localizacoes/${excluindo!.id}/substituir-e-excluir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destino_id: destinoSubsId }),
      }),
    onSuccess: (data) => {
      toast.success(
        `${data.itens_movidos} item${data.itens_movidos !== 1 ? "s" : ""} movido${
          data.itens_movidos !== 1 ? "s" : ""
        } pra ${data.destino_codigo}. Loc ${data.origem_codigo} removida.`,
      );
      setExcluindo(null);
      setDestinoSubsId("");
      queryClient.invalidateQueries({ queryKey: ["wms-locs", galpaoId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const fecharExcluir = () => {
    setExcluindo(null);
    setDestinoSubsId("");
  };

  const rows = useMemo(
    () => locsQuery.data?.rows ?? [],
    [locsQuery.data],
  );
  const filteredRows = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    if (!termo) return rows;
    return rows.filter(
      (l) =>
        l.codigo.toLowerCase().includes(termo) ||
        (l.descricao?.toLowerCase().includes(termo) ?? false),
    );
  }, [rows, busca]);
  const pagedRows = useMemo(
    () => filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filteredRows, page],
  );

  const loteValido =
    lote.prefixo.trim() !== "" &&
    lote.h_inicio >= 1 &&
    lote.h_fim >= lote.h_inicio &&
    lote.v_inicio >= 1 &&
    lote.v_fim >= lote.v_inicio;

  return (
    <>
      <PageHeader
        title="Localizações"
        subtitle="Endereçamento físico por galpão"
      >
        {podeEditar && (
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            disabled={!galpaoId}
            onClick={() => {
              if (showForm) fecharForm();
              else setShowForm(true);
            }}
          >
            <Icon name="plus" size={12} />
            Nova localização
          </button>
        )}
      </PageHeader>

      {!galpaoId && (
        <div className="wms-empty-block">
          <h3>Escolha um galpão</h3>
          <p>
            Selecione um galpão específico na sidebar para ver e gerenciar suas
            localizações.
          </p>
        </div>
      )}

      {galpaoId && showForm && (
        <div
          style={{
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-3)",
            padding: 16,
            marginBottom: 16,
          }}
        >
          {/* Toggle modo */}
          {!preview && (
            <div
              className="wms-seg"
              style={{ marginBottom: 14, maxWidth: 360 }}
            >
              <button
                type="button"
                className={`wms-seg-btn ${
                  modo === "individual" ? "is-active" : ""
                }`}
                onClick={() => setModo("individual")}
              >
                <Icon name="plus" size={11} /> Individual
              </button>
              <button
                type="button"
                className={`wms-seg-btn ${modo === "lote" ? "is-active" : ""}`}
                onClick={() => setModo("lote")}
              >
                <Icon name="box" size={11} /> Lote
              </button>
            </div>
          )}

          {/* Modo individual */}
          {modo === "individual" && (
            <>
              <h3 className="wms-sec-h" style={{ marginTop: 0 }}>
                Nova localização
              </h3>
              <div className="wms-row-3">
                <Field label="Código" required>
                  <input
                    className="wms-input wms-mono"
                    value={novo.codigo}
                    onChange={(e) =>
                      setNovo({ ...novo, codigo: e.target.value })
                    }
                    placeholder="A-12-03"
                  />
                </Field>
                <Field label="Descrição" hint="opcional">
                  <input
                    className="wms-input"
                    value={novo.descricao}
                    onChange={(e) =>
                      setNovo({ ...novo, descricao: e.target.value })
                    }
                    placeholder="Rua A, Coluna 12, Nível 03"
                  />
                </Field>
                <Field label="Tipo" required>
                  <select
                    className="wms-select"
                    value={novo.tipo}
                    onChange={(e) =>
                      setNovo({
                        ...novo,
                        tipo: e.target.value as TipoLocalizacao,
                      })
                    }
                  >
                    {TIPOS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                  paddingTop: 12,
                  borderTop: "1px solid var(--wms-c-border)",
                  marginTop: 12,
                }}
              >
                <button
                  type="button"
                  className="wms-btn wms-btn-ghost"
                  onClick={fecharForm}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="wms-btn wms-btn-primary"
                  disabled={!novo.codigo || criar.isPending}
                  onClick={() => criar.mutate()}
                >
                  <Icon name="check" size={11} />
                  {criar.isPending ? "Criando…" : "Criar"}
                </button>
              </div>
            </>
          )}

          {/* Modo lote — form */}
          {modo === "lote" && !preview && (
            <>
              <h3 className="wms-sec-h" style={{ marginTop: 0 }}>
                Cadastro em lote
              </h3>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--wms-c-fg-3)",
                  marginBottom: 12,
                }}
              >
                Gera todas as combinações horizontal × vertical com o prefixo.
                Ex: A com horizontal 1–10 e vertical 1–10 → A-01-01 até A-10-10
                (100 localizações). Códigos que já existem são pulados.
              </div>
              <div className="wms-row-3" style={{ marginBottom: 10 }}>
                <Field label="Prefixo" required>
                  <input
                    className="wms-input wms-mono"
                    value={lote.prefixo}
                    onChange={(e) =>
                      setLote({
                        ...lote,
                        prefixo: e.target.value.toUpperCase().slice(0, 8),
                      })
                    }
                    placeholder="A"
                    maxLength={8}
                  />
                </Field>
                <Field label="Tipo" required>
                  <select
                    className="wms-select"
                    value={lote.tipo}
                    onChange={(e) =>
                      setLote({
                        ...lote,
                        tipo: e.target.value as TipoLocalizacao,
                      })
                    }
                  >
                    {TIPOS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
                <div />
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "100px 1fr 1fr",
                  gap: 10,
                  alignItems: "end",
                  marginBottom: 6,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--wms-c-fg-2)",
                    paddingBottom: 8,
                  }}
                >
                  Horizontal
                </div>
                <Field label="Início" required>
                  <input
                    type="number"
                    className="wms-input wms-mono"
                    min={1}
                    value={lote.h_inicio || ""}
                    onChange={(e) =>
                      setLote({
                        ...lote,
                        h_inicio: parseInt(e.target.value, 10) || 0,
                      })
                    }
                  />
                </Field>
                <Field label="Fim" required>
                  <input
                    type="number"
                    className="wms-input wms-mono"
                    min={1}
                    value={lote.h_fim || ""}
                    onChange={(e) =>
                      setLote({
                        ...lote,
                        h_fim: parseInt(e.target.value, 10) || 0,
                      })
                    }
                  />
                </Field>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "100px 1fr 1fr",
                  gap: 10,
                  alignItems: "end",
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--wms-c-fg-2)",
                    paddingBottom: 8,
                  }}
                >
                  Vertical
                </div>
                <Field label="Início" required>
                  <input
                    type="number"
                    className="wms-input wms-mono"
                    min={1}
                    value={lote.v_inicio || ""}
                    onChange={(e) =>
                      setLote({
                        ...lote,
                        v_inicio: parseInt(e.target.value, 10) || 0,
                      })
                    }
                  />
                </Field>
                <Field label="Fim" required>
                  <input
                    type="number"
                    className="wms-input wms-mono"
                    min={1}
                    value={lote.v_fim || ""}
                    onChange={(e) =>
                      setLote({
                        ...lote,
                        v_fim: parseInt(e.target.value, 10) || 0,
                      })
                    }
                  />
                </Field>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                  paddingTop: 12,
                  borderTop: "1px solid var(--wms-c-border)",
                  marginTop: 14,
                }}
              >
                <button
                  type="button"
                  className="wms-btn wms-btn-ghost"
                  onClick={fecharForm}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="wms-btn wms-btn-primary"
                  disabled={!loteValido || visualizar.isPending}
                  onClick={() => visualizar.mutate()}
                >
                  {visualizar.isPending ? "Calculando…" : "Visualizar"}
                </button>
              </div>
            </>
          )}

          {/* Modo lote — preview */}
          {modo === "lote" && preview && (
            <>
              <h3 className="wms-sec-h" style={{ marginTop: 0 }}>
                Confirmação do lote
              </h3>

              <div
                style={{
                  display: "flex",
                  gap: 24,
                  flexWrap: "wrap",
                  marginBottom: 14,
                  fontSize: 14,
                }}
              >
                <div>
                  <div
                    style={{ fontSize: 11, color: "var(--wms-c-fg-3)" }}
                  >
                    Total no range
                  </div>
                  <div style={{ fontWeight: 600 }}>{preview.total}</div>
                </div>
                <div>
                  <div
                    style={{ fontSize: 11, color: "var(--wms-c-fg-3)" }}
                  >
                    Serão criadas
                  </div>
                  <div style={{ fontWeight: 600 }}>{preview.criadas}</div>
                </div>
                <div>
                  <div
                    style={{ fontSize: 11, color: "var(--wms-c-fg-3)" }}
                  >
                    Já existem (puladas)
                  </div>
                  <div style={{ fontWeight: 600 }}>{preview.ja_existiam}</div>
                </div>
              </div>

              <div style={{ marginBottom: 10 }}>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--wms-c-fg-3)",
                    marginBottom: 4,
                  }}
                >
                  {preview.amostra.ultimas.length === 0
                    ? "Códigos"
                    : "Primeiros"}
                </div>
                <div
                  className="wms-mono"
                  style={{ fontSize: 13, color: "var(--wms-c-fg-2)" }}
                >
                  {preview.amostra.primeiras.join(", ")}
                </div>
              </div>

              {preview.amostra.ultimas.length > 0 && (
                <div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--wms-c-fg-3)",
                      marginBottom: 4,
                    }}
                  >
                    Últimos
                  </div>
                  <div
                    className="wms-mono"
                    style={{ fontSize: 13, color: "var(--wms-c-fg-2)" }}
                  >
                    {preview.amostra.ultimas.join(", ")}
                  </div>
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                  paddingTop: 14,
                  borderTop: "1px solid var(--wms-c-border)",
                  marginTop: 14,
                }}
              >
                <button
                  type="button"
                  className="wms-btn wms-btn-ghost"
                  onClick={() => setPreview(null)}
                >
                  Voltar
                </button>
                <button
                  type="button"
                  className="wms-btn wms-btn-primary"
                  disabled={preview.criadas === 0 || criarLote.isPending}
                  onClick={() => criarLote.mutate()}
                >
                  <Icon name="check" size={11} />
                  {criarLote.isPending
                    ? "Criando…"
                    : preview.criadas === 0
                      ? "Nada a criar"
                      : `Criar ${preview.criadas}`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {galpaoId && (
        <>
          {locsQuery.isLoading && (
            <div className="wms-loading-pane">Carregando localizações…</div>
          )}
          {locsQuery.isError && (
            <div className="wms-empty-block">
              <h3>Erro</h3>
              <p>{(locsQuery.error as Error).message}</p>
            </div>
          )}
          {!locsQuery.isLoading && rows.length === 0 && (
            <div className="wms-empty-block">
              <h3>Nenhuma localização nesse galpão</h3>
              <p>Crie a primeira para começar a endereçar estoque.</p>
            </div>
          )}
          {rows.length > 0 && (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 12,
                }}
              >
                <div style={{ position: "relative", flex: "0 0 320px" }}>
                  <span
                    style={{
                      position: "absolute",
                      left: 10,
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "var(--wms-c-fg-3)",
                      pointerEvents: "none",
                      display: "flex",
                    }}
                  >
                    <Icon name="search" size={12} />
                  </span>
                  <input
                    className="wms-input"
                    style={{ paddingLeft: 30, paddingRight: busca ? 30 : 10 }}
                    placeholder="Buscar por código ou descrição…"
                    value={busca}
                    onChange={(e) => setBusca(e.target.value)}
                  />
                  {busca && (
                    <button
                      type="button"
                      className="wms-btn-icon"
                      title="Limpar"
                      onClick={() => setBusca("")}
                      style={{
                        position: "absolute",
                        right: 4,
                        top: "50%",
                        transform: "translateY(-50%)",
                      }}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--wms-c-fg-3)",
                  }}
                >
                  {busca
                    ? `${filteredRows.length} de ${rows.length}`
                    : `${rows.length} no total`}
                </div>
              </div>

              {filteredRows.length === 0 ? (
                <div className="wms-empty-block">
                  <h3>Nada encontrado</h3>
                  <p>
                    Nenhuma localização corresponde a{" "}
                    <span className="wms-mono">&quot;{busca}&quot;</span>.
                  </p>
                </div>
              ) : (
                <>
                  <div className="wms-tbl">
                    <table>
                      <thead>
                        <tr>
                          <th>Código</th>
                          <th>Descrição</th>
                          <th>Tipo</th>
                          <th style={{ width: 60, textAlign: "right" }}>Ações</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagedRows.map((l) => {
                          const editandoEsta = editandoTipoId === l.id;
                          const salvandoEsta =
                            trocarTipo.isPending &&
                            trocarTipo.variables?.id === l.id;
                          return (
                            <tr key={l.id}>
                              <td className="wms-mono">{l.codigo}</td>
                              <td className="wms-td-mute">
                                {l.descricao ?? "—"}
                              </td>
                              <td>
                                {editandoEsta ? (
                                  <select
                                    autoFocus
                                    className="wms-select"
                                    style={{
                                      height: 26,
                                      fontSize: 12,
                                      padding: "0 6px",
                                      minWidth: 130,
                                    }}
                                    value={l.tipo}
                                    disabled={salvandoEsta}
                                    onBlur={() => {
                                      if (!salvandoEsta)
                                        setEditandoTipoId(null);
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === "Escape")
                                        setEditandoTipoId(null);
                                    }}
                                    onChange={(e) => {
                                      const novo = e.target
                                        .value as TipoLocalizacao;
                                      if (novo === l.tipo) {
                                        setEditandoTipoId(null);
                                        return;
                                      }
                                      trocarTipo.mutate({
                                        id: l.id,
                                        tipo: novo,
                                      });
                                    }}
                                  >
                                    {TIPOS.map((t) => (
                                      <option key={t} value={t}>
                                        {t}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setEditandoTipoId(l.id)}
                                    title="Clique para trocar o tipo"
                                    style={{
                                      background: "none",
                                      border: "none",
                                      padding: 0,
                                      cursor: "pointer",
                                    }}
                                  >
                                    <LocTipoBadge tipo={l.tipo} />
                                  </button>
                                )}
                              </td>
                              <td className="wms-td-actions">
                                {podeImprimir && (
                                  <>
                                    <button
                                      type="button"
                                      className="wms-btn-icon"
                                      title="Imprimir etiqueta pequena"
                                      onClick={() => imprimirEndereco.mutate({ codigo: l.codigo, tipo: "pequena" })}
                                    >
                                      <Icon name="printer" size={12} />
                                    </button>
                                    <button
                                      type="button"
                                      className="wms-btn-icon"
                                      title="Imprimir etiqueta grande 10×15"
                                      onClick={() => imprimirEndereco.mutate({ codigo: l.codigo, tipo: "grande" })}
                                    >
                                      <span style={{ fontSize: 10, fontWeight: 700 }}>10×15</span>
                                    </button>
                                  </>
                                )}
                                <button
                                  type="button"
                                  className="wms-btn-icon"
                                  title="Excluir localização"
                                  onClick={() => setExcluindo(l)}
                                >
                                  <Icon name="trash" size={12} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    total={filteredRows.length}
                    pageSize={PAGE_SIZE}
                    page={page}
                    onPageChange={setPage}
                    label="localizações"
                  />
                </>
              )}
            </>
          )}
        </>
      )}

      {excluindo && (
        <ExcluirLocModal
          loc={excluindo}
          saldos={saldosQuery.data ?? null}
          saldosLoading={saldosQuery.isLoading}
          saldosError={
            saldosQuery.isError ? (saldosQuery.error as Error).message : null
          }
          locsDisponiveis={rows.filter(
            (l) => l.id !== excluindo.id && l.ativo !== false,
          )}
          destinoId={destinoSubsId}
          onDestinoChange={setDestinoSubsId}
          onCancelar={fecharExcluir}
          onExcluirSimples={() => excluirSimples.mutate(excluindo.id)}
          onSubstituir={() => substituirEExcluir.mutate()}
          excluindoSimples={excluirSimples.isPending}
          substituindo={substituirEExcluir.isPending}
        />
      )}
    </>
  );
}

interface ExcluirLocModalProps {
  loc: Localizacao;
  saldos: SaldosResponse | null;
  saldosLoading: boolean;
  saldosError: string | null;
  locsDisponiveis: Localizacao[];
  destinoId: string;
  onDestinoChange: (id: string) => void;
  onCancelar: () => void;
  onExcluirSimples: () => void;
  onSubstituir: () => void;
  excluindoSimples: boolean;
  substituindo: boolean;
}

function ExcluirLocModal({
  loc,
  saldos,
  saldosLoading,
  saldosError,
  locsDisponiveis,
  destinoId,
  onDestinoChange,
  onCancelar,
  onExcluirSimples,
  onSubstituir,
  excluindoSimples,
  substituindo,
}: ExcluirLocModalProps) {
  const temSaldo = !!saldos && saldos.total_linhas > 0;

  return (
    <Portal>
      <div className="wms-md-overlay" onClick={onCancelar}>
        <div
          style={{
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-3)",
            width: "100%",
            maxWidth: 540,
            maxHeight: "90vh",
            overflow: "auto",
            padding: 20,
          }}
          onClick={(e) => e.stopPropagation()}
        >
        <h3 className="wms-sec-h" style={{ marginTop: 0 }}>
          Excluir <span className="wms-mono">{loc.codigo}</span>
        </h3>

        {saldosLoading && (
          <div className="wms-loading-pane">Verificando saldo…</div>
        )}
        {saldosError && (
          <div className="wms-empty-block">
            <h3>Erro ao verificar saldo</h3>
            <p>{saldosError}</p>
          </div>
        )}

        {!saldosLoading && !saldosError && !temSaldo && (
          <>
            <p
              style={{
                fontSize: 13,
                color: "var(--wms-c-fg-2)",
                margin: "0 0 16px",
              }}
            >
              Esta localização está vazia. Quer remover?
            </p>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                paddingTop: 12,
                borderTop: "1px solid var(--wms-c-border)",
              }}
            >
              <button
                type="button"
                className="wms-btn wms-btn-ghost"
                onClick={onCancelar}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="wms-btn wms-btn-danger"
                disabled={excluindoSimples}
                onClick={onExcluirSimples}
              >
                <Icon name="trash" size={11} />
                {excluindoSimples ? "Removendo…" : "Remover"}
              </button>
            </div>
          </>
        )}

        {!saldosLoading && !saldosError && temSaldo && saldos && (
          <>
            <p
              style={{
                fontSize: 13,
                color: "var(--wms-c-fg-2)",
                margin: "0 0 12px",
              }}
            >
              Esta localização tem saldo. Escolha pra onde mover antes de
              remover.
            </p>

            <div
              style={{
                background: "var(--wms-c-panel-2)",
                border: "1px solid var(--wms-c-border)",
                borderRadius: "var(--wms-r-2)",
                padding: 10,
                marginBottom: 14,
                maxHeight: 200,
                overflow: "auto",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "var(--wms-c-fg-3)",
                  marginBottom: 6,
                }}
              >
                {saldos.total_linhas} linha
                {saldos.total_linhas !== 1 ? "s" : ""} ·{" "}
                {saldos.total_qty} unidade
                {saldos.total_qty !== 1 ? "s" : ""}
              </div>
              <table style={{ width: "100%", fontSize: 12 }}>
                <thead>
                  <tr style={{ color: "var(--wms-c-fg-3)" }}>
                    <th style={{ textAlign: "left", paddingBottom: 4 }}>SKU</th>
                    <th style={{ textAlign: "left", paddingBottom: 4 }}>
                      Descrição
                    </th>
                    <th style={{ textAlign: "right", paddingBottom: 4 }}>
                      Saldo
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {saldos.rows.map((s) => (
                    <tr key={s.produto_id}>
                      <td className="wms-mono" style={{ paddingRight: 8 }}>
                        {s.sku ?? s.produto_id.slice(0, 8)}
                      </td>
                      <td style={{ color: "var(--wms-c-fg-2)" }}>
                        {s.descricao ?? "—"}
                      </td>
                      <td
                        className="wms-mono"
                        style={{ textAlign: "right" }}
                      >
                        {s.saldo}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Field label="Mover para" required>
              <select
                className="wms-select"
                value={destinoId}
                onChange={(e) => onDestinoChange(e.target.value)}
              >
                <option value="">Selecione a localização destino…</option>
                {locsDisponiveis.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.codigo}
                    {l.descricao ? ` — ${l.descricao}` : ""}
                  </option>
                ))}
              </select>
            </Field>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                paddingTop: 14,
                borderTop: "1px solid var(--wms-c-border)",
                marginTop: 14,
              }}
            >
              <button
                type="button"
                className="wms-btn wms-btn-ghost"
                onClick={onCancelar}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="wms-btn wms-btn-danger"
                disabled={!destinoId || substituindo}
                onClick={onSubstituir}
              >
                <Icon name="arrows" size={11} />
                {substituindo ? "Movendo e removendo…" : "Mover e remover"}
              </button>
            </div>
          </>
        )}
        </div>
      </div>
    </Portal>
  );
}
