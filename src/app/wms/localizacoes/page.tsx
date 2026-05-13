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
import type { Localizacao, TipoLocalizacao } from "@/lib/wms/types";
import { useAuth } from "@/lib/auth-context";

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
  const { activeGalpaoId } = useAuth();
  const galpaoId = activeGalpaoId ?? "";
  const [showForm, setShowForm] = useState(false);
  const [modo, setModo] = useState<Modo>("individual");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;
  const [novo, setNovo] = useState({
    codigo: "",
    descricao: "",
    tipo: "picking" as TipoLocalizacao,
  });
  const [lote, setLote] = useState<LoteForm>(LOTE_DEFAULT);
  const [preview, setPreview] = useState<LoteResponse | null>(null);

  useEffect(() => {
    setPage(1);
  }, [activeGalpaoId]);

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

  const rows = useMemo(
    () => locsQuery.data?.rows ?? [],
    [locsQuery.data],
  );
  const pagedRows = useMemo(
    () => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [rows, page],
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
              <div className="wms-tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Código</th>
                      <th>Descrição</th>
                      <th>Tipo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map((l) => (
                      <tr key={l.id}>
                        <td className="wms-mono">{l.codigo}</td>
                        <td className="wms-td-mute">{l.descricao ?? "—"}</td>
                        <td>
                          <LocTipoBadge tipo={l.tipo} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                total={rows.length}
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
  );
}
