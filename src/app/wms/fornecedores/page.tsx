"use client";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { usePermissoes } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Icon,
  PageHeader,
  Pagination,
  Field,
  Modal,
} from "@/components/wms/ui/wms-ui";
import type { Fornecedor } from "@/lib/wms/fornecedores";

interface Galpao {
  id: string;
  nome: string;
}

interface LeadTimeForm {
  min: string;
  medio: string;
  max: string;
}

function ltFromFornecedor(f: Fornecedor): LeadTimeForm {
  return {
    min: f.lead_time_dias_min != null ? String(f.lead_time_dias_min) : "",
    medio: f.lead_time_dias_medio != null ? String(f.lead_time_dias_medio) : "",
    max: f.lead_time_dias_max != null ? String(f.lead_time_dias_max) : "",
  };
}

function parseLt(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function fmtLt(f: Fornecedor): string {
  const { lead_time_dias_min: a, lead_time_dias_medio: m, lead_time_dias_max: x } = f;
  if (a == null && m == null && x == null) return "—";
  const parts = [a ?? "·", m ?? "·", x ?? "·"];
  return parts.join(" / ");
}

export default function FornecedoresPage() {
  const queryClient = useQueryClient();
  const { can } = usePermissoes();
  const podeEditar = can("fornecedores.editar");
  const [showForm, setShowForm] = useState(false);
  const [novo, setNovo] = useState({
    nome: "",
    cnpj: "",
    prefixo_sku: "",
    galpao_id: "",
    lt: { min: "", medio: "", max: "" } as LeadTimeForm,
  });
  const [editando, setEditando] = useState<Fornecedor | null>(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["wms-fornecedores"],
    queryFn: () =>
      wmsApi<{ rows: Fornecedor[]; galpoes: Galpao[] }>("/api/wms/fornecedores"),
  });
  const galpoes = useMemo(() => data?.galpoes ?? [], [data]);
  const galpaoNomeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of galpoes) m.set(g.id, g.nome);
    return m;
  }, [galpoes]);

  const criar = useMutation({
    mutationFn: () =>
      wmsApi<Fornecedor>("/api/wms/fornecedores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: novo.nome,
          cnpj: novo.cnpj || undefined,
          prefixo_sku: novo.prefixo_sku || undefined,
          galpao_id: novo.galpao_id || null,
          lead_time_dias_min: parseLt(novo.lt.min),
          lead_time_dias_medio: parseLt(novo.lt.medio),
          lead_time_dias_max: parseLt(novo.lt.max),
        }),
      }),
    onSuccess: () => {
      toast.success("Fornecedor criado");
      setNovo({
        nome: "",
        cnpj: "",
        prefixo_sku: "",
        galpao_id: "",
        lt: { min: "", medio: "", max: "" },
      });
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["wms-fornecedores"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const autoCadastro = useMutation({
    mutationFn: () =>
      wmsApi<{ criados: number; existentes: number }>(
        "/api/wms/fornecedores/auto-cadastro",
        { method: "POST" },
      ),
    onSuccess: (d) => {
      toast.success(`${d.criados} criados, ${d.existentes} já existiam`);
      queryClient.invalidateQueries({ queryKey: ["wms-fornecedores"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const pagedRows = useMemo(
    () => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [rows, page],
  );

  return (
    <>
      <PageHeader
        title="Fornecedores"
        subtitle={`${rows.length} fornecedor(es) cadastrado(s)`}
      >
        {podeEditar && (
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            disabled={autoCadastro.isPending}
            onClick={() => autoCadastro.mutate()}
            title="Auto-cadastrar do mapeamento canônico de prefixos SKU"
          >
            <Icon name="sparkle" size={12} />
            Auto-cadastrar mapeamento canônico
          </button>
        )}
        {podeEditar && (
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            onClick={() => setShowForm((s) => !s)}
          >
            <Icon name="plus" size={12} />
            Novo fornecedor
          </button>
        )}
      </PageHeader>

      {showForm && (
        <div
          style={{
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-3)",
            padding: 16,
            marginBottom: 16,
          }}
        >
          <h3 className="wms-sec-h" style={{ marginTop: 0 }}>
            Novo fornecedor
          </h3>
          <div className="wms-row-3">
            <Field label="Nome" required>
              <input
                className="wms-input"
                value={novo.nome}
                onChange={(e) => setNovo({ ...novo, nome: e.target.value })}
                placeholder="ex.: Tiger"
              />
            </Field>
            <Field label="CNPJ">
              <input
                className="wms-input wms-mono"
                value={novo.cnpj}
                onChange={(e) => setNovo({ ...novo, cnpj: e.target.value })}
                placeholder="00.000.000/0000-00"
              />
            </Field>
            <Field label="Prefixo SKU">
              <input
                className="wms-input wms-mono"
                value={novo.prefixo_sku}
                onChange={(e) =>
                  setNovo({ ...novo, prefixo_sku: e.target.value })
                }
                placeholder="TGR"
              />
            </Field>
            <Field label="Galpão de recebimento">
              <select
                className="wms-select"
                value={novo.galpao_id}
                onChange={(e) =>
                  setNovo({ ...novo, galpao_id: e.target.value })
                }
              >
                <option value="">— (cai no prefixo do SKU)</option>
                {galpoes.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.nome}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px dashed var(--wms-c-border)",
            }}
          >
            <p className="wms-td-mute" style={{ marginBottom: 8, fontSize: 12 }}>
              Lead time (dias) — defaults herdados ao vincular um produto novo a
              este fornecedor. Em branco = sem default.
            </p>
            <div className="wms-row-3">
              <Field label="Mínimo">
                <input
                  className="wms-input"
                  inputMode="numeric"
                  value={novo.lt.min}
                  onChange={(e) =>
                    setNovo({ ...novo, lt: { ...novo.lt, min: e.target.value } })
                  }
                  placeholder="ex.: 7"
                />
              </Field>
              <Field label="Médio">
                <input
                  className="wms-input"
                  inputMode="numeric"
                  value={novo.lt.medio}
                  onChange={(e) =>
                    setNovo({
                      ...novo,
                      lt: { ...novo.lt, medio: e.target.value },
                    })
                  }
                  placeholder="ex.: 14"
                />
              </Field>
              <Field label="Máximo">
                <input
                  className="wms-input"
                  inputMode="numeric"
                  value={novo.lt.max}
                  onChange={(e) =>
                    setNovo({ ...novo, lt: { ...novo.lt, max: e.target.value } })
                  }
                  placeholder="ex.: 30"
                />
              </Field>
            </div>
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
              onClick={() => setShowForm(false)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              disabled={!novo.nome || criar.isPending}
              onClick={() => criar.mutate()}
            >
              <Icon name="check" size={11} />
              {criar.isPending ? "Criando…" : "Criar fornecedor"}
            </button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="wms-loading-pane">Carregando fornecedores…</div>
      )}
      {isError && (
        <div className="wms-empty-block">
          <h3>Erro</h3>
          <p>{(error as Error).message}</p>
        </div>
      )}
      {!isLoading && rows.length === 0 && (
        <div className="wms-empty-block">
          <h3>Nenhum fornecedor cadastrado</h3>
          {podeEditar && (
            <p>
              Use o botão{" "}
              <strong>Auto-cadastrar mapeamento canônico</strong> para semear os
              fornecedores do mapeamento de prefixos SKU.
            </p>
          )}
        </div>
      )}
      {rows.length > 0 && (
        <>
          <div className="wms-tbl">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Prefixo SKU</th>
                  <th>CNPJ</th>
                  <th>Galpão</th>
                  <th title="Lead time min / médio / máx (dias)">
                    Lead time (dias)
                  </th>
                  {podeEditar && <th style={{ width: 80 }}></th>}
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <strong>{f.nome}</strong>
                    </td>
                    <td className="wms-mono">{f.prefixo_sku ?? "—"}</td>
                    <td className="wms-mono wms-td-mute">{f.cnpj ?? "—"}</td>
                    <td>
                      {f.galpao_id ? (
                        <span className="wms-pcard-chip is-galpao">
                          {galpaoNomeById.get(f.galpao_id) ?? "?"}
                        </span>
                      ) : (
                        <span className="wms-td-mute">prefixo</span>
                      )}
                    </td>
                    <td className="wms-mono">{fmtLt(f)}</td>
                    {podeEditar && (
                      <td>
                        <button
                          type="button"
                          className="wms-btn wms-btn-ghost"
                          onClick={() => setEditando(f)}
                          title="Editar fornecedor"
                        >
                          <Icon name="edit" size={12} />
                          Editar
                        </button>
                      </td>
                    )}
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
            label="fornecedores"
          />
        </>
      )}

      {editando && (
        <EditarFornecedorModal
          fornecedor={editando}
          galpoes={galpoes}
          onClose={() => setEditando(null)}
          onSaved={() => {
            setEditando(null);
            queryClient.invalidateQueries({ queryKey: ["wms-fornecedores"] });
          }}
        />
      )}
    </>
  );
}

function EditarFornecedorModal({
  fornecedor,
  galpoes,
  onClose,
  onSaved,
}: {
  fornecedor: Fornecedor;
  galpoes: Galpao[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [lt, setLt] = useState<LeadTimeForm>(ltFromFornecedor(fornecedor));
  const [galpaoId, setGalpaoId] = useState<string>(fornecedor.galpao_id ?? "");

  const salvar = useMutation({
    mutationFn: () =>
      wmsApi<Fornecedor>(`/api/wms/fornecedores/${fornecedor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          galpao_id: galpaoId || null,
          lead_time_dias_min: parseLt(lt.min),
          lead_time_dias_medio: parseLt(lt.medio),
          lead_time_dias_max: parseLt(lt.max),
        }),
      }),
    onSuccess: () => {
      toast.success("Fornecedor atualizado");
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal
      title={`Editar ${fornecedor.nome}`}
      subtitle="Defaults de lead time herdados ao vincular novos produtos."
      width={520}
      onClose={onClose}
      footer={
        <>
          <button className="wms-btn wms-btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="wms-btn wms-btn-primary"
            disabled={salvar.isPending}
            onClick={() => salvar.mutate()}
          >
            <Icon name="check" size={11} />
            {salvar.isPending ? "Salvando…" : "Salvar"}
          </button>
        </>
      }
    >
      <Field label="Galpão de recebimento">
        <select
          className="wms-select"
          value={galpaoId}
          onChange={(e) => setGalpaoId(e.target.value)}
        >
          <option value="">— (cai no prefixo do SKU)</option>
          {galpoes.map((g) => (
            <option key={g.id} value={g.id}>
              {g.nome}
            </option>
          ))}
        </select>
      </Field>
      <p
        className="wms-td-mute"
        style={{ fontSize: 12, marginBottom: 12, marginTop: 12 }}
      >
        Lead time (dias). Em branco = sem default. Vínculos já existentes em{" "}
        <strong>produto × fornecedor</strong> não são alterados aqui.
      </p>
      <div className="wms-row-3">
        <Field label="Mínimo">
          <input
            className="wms-input"
            inputMode="numeric"
            value={lt.min}
            onChange={(e) => setLt({ ...lt, min: e.target.value })}
            placeholder="ex.: 7"
          />
        </Field>
        <Field label="Médio">
          <input
            className="wms-input"
            inputMode="numeric"
            value={lt.medio}
            onChange={(e) => setLt({ ...lt, medio: e.target.value })}
            placeholder="ex.: 14"
          />
        </Field>
        <Field label="Máximo">
          <input
            className="wms-input"
            inputMode="numeric"
            value={lt.max}
            onChange={(e) => setLt({ ...lt, max: e.target.value })}
            placeholder="ex.: 30"
          />
        </Field>
      </div>
    </Modal>
  );
}
