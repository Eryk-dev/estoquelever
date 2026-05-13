"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, Field } from "@/components/wms/ui/wms-ui";
import type { GalpaoHierarquiaWms, EmpresaHierarquiaWms } from "./types";

function StatusConexao({ empresa }: { empresa: EmpresaHierarquiaWms }) {
  if (!empresa.ativo) {
    return <span className="wms-badge wms-badge-mute">Inativa</span>;
  }
  if (empresa.conexao?.conectado) {
    return <span className="wms-badge wms-badge-ok">Conectado</span>;
  }
  if (empresa.conexao) {
    return <span className="wms-badge wms-badge-warn">Não autorizado</span>;
  }
  return <span className="wms-badge wms-badge-mute">Sem conexão</span>;
}

export function AbaEmpresas({
  galpoes,
  isLoading,
}: {
  galpoes: GalpaoHierarquiaWms[];
  isLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [novo, setNovo] = useState({ nome: "", cnpj: "", galpao_id: "" });
  const [editando, setEditando] = useState<string | null>(null);
  const [filtroGalpao, setFiltroGalpao] = useState<string>("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["wms-cfg-galpoes"] });
  };

  const todasEmpresas = useMemo(
    () =>
      galpoes.flatMap((g) =>
        g.siso_empresas.map((e) => ({ ...e, galpao_id: g.id, galpao_nome: g.nome })),
      ),
    [galpoes],
  );

  const empresasFiltradas = useMemo(
    () =>
      filtroGalpao
        ? todasEmpresas.filter((e) => e.galpao_id === filtroGalpao)
        : todasEmpresas,
    [todasEmpresas, filtroGalpao],
  );

  const criar = useMutation({
    mutationFn: () =>
      wmsApi("/api/admin/empresas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: novo.nome,
          cnpj: novo.cnpj.replace(/\D/g, ""),
          galpao_id: novo.galpao_id,
        }),
      }),
    onSuccess: () => {
      toast.success("Empresa criada — configure a conexão Tiny em seguida");
      setNovo({ nome: "", cnpj: "", galpao_id: "" });
      setShowForm(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h3 className="wms-sec-h" style={{ margin: 0 }}>
            Empresas
          </h3>
          <p className="wms-td-mute" style={{ fontSize: 12, marginTop: 2 }}>
            Contas Tiny (CNPJ) ancoradas a um galpão. A conexão OAuth2 e
            configurações de depósito vivem em <code>/configuracoes</code> legado.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            className="wms-select"
            value={filtroGalpao}
            onChange={(e) => setFiltroGalpao(e.target.value)}
            style={{ minWidth: 180 }}
          >
            <option value="">Todos os galpões</option>
            {galpoes.map((g) => (
              <option key={g.id} value={g.id}>
                {g.nome}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            onClick={() => setShowForm((s) => !s)}
            disabled={galpoes.length === 0}
            title={galpoes.length === 0 ? "Cadastre um galpão antes" : undefined}
          >
            <Icon name="plus" size={12} />
            Nova empresa
          </button>
        </div>
      </div>

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
            Nova empresa
          </h3>
          <div className="wms-row-3">
            <Field label="Nome" required>
              <input
                className="wms-input"
                value={novo.nome}
                onChange={(e) => setNovo({ ...novo, nome: e.target.value })}
                placeholder="ex.: NetAir"
                autoFocus
              />
            </Field>
            <Field label="CNPJ" required>
              <input
                className="wms-input wms-mono"
                value={novo.cnpj}
                onChange={(e) => setNovo({ ...novo, cnpj: e.target.value })}
                placeholder="34857388000163"
              />
            </Field>
            <Field label="Galpão" required>
              <select
                className="wms-select"
                value={novo.galpao_id}
                onChange={(e) => setNovo({ ...novo, galpao_id: e.target.value })}
              >
                <option value="">Selecione…</option>
                {galpoes
                  .filter((g) => g.ativo)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.nome}
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
              onClick={() => {
                setShowForm(false);
                setNovo({ nome: "", cnpj: "", galpao_id: "" });
              }}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              disabled={
                !novo.nome.trim() ||
                novo.cnpj.replace(/\D/g, "").length < 8 ||
                !novo.galpao_id ||
                criar.isPending
              }
              onClick={() => criar.mutate()}
            >
              <Icon name="check" size={11} />
              {criar.isPending ? "Criando…" : "Criar empresa"}
            </button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="wms-loading-pane">Carregando empresas…</div>
      )}
      {!isLoading && empresasFiltradas.length === 0 && (
        <div className="wms-empty-block">
          <h3>Nenhuma empresa {filtroGalpao ? "neste galpão" : "cadastrada"}</h3>
          <p>
            {filtroGalpao
              ? "Adicione uma empresa associada a este galpão."
              : "Cadastre uma empresa pra começar."}
          </p>
        </div>
      )}
      {empresasFiltradas.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>CNPJ</th>
                <th>Galpão</th>
                <th>Grupo / Tier</th>
                <th>Conexão</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {empresasFiltradas.map((e) => (
                <LinhaEmpresa
                  key={e.id}
                  empresa={e}
                  galpoes={galpoes}
                  editando={editando === e.id}
                  onEditar={() => setEditando(e.id)}
                  onFechar={() => setEditando(null)}
                  onSalvo={invalidate}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function LinhaEmpresa({
  empresa,
  galpoes,
  editando,
  onEditar,
  onFechar,
  onSalvo,
}: {
  empresa: EmpresaHierarquiaWms & { galpao_id: string; galpao_nome: string };
  galpoes: GalpaoHierarquiaWms[];
  editando: boolean;
  onEditar: () => void;
  onFechar: () => void;
  onSalvo: () => void;
}) {
  const [form, setForm] = useState({
    nome: empresa.nome,
    galpao_id: empresa.galpao_id,
    ativo: empresa.ativo,
  });

  const salvar = useMutation({
    mutationFn: () =>
      wmsApi(`/api/admin/empresas/${empresa.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: form.nome,
          galpao_id: form.galpao_id,
          ativo: form.ativo,
        }),
      }),
    onSuccess: () => {
      toast.success("Empresa atualizada");
      onSalvo();
      onFechar();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!editando) {
    return (
      <tr style={{ opacity: empresa.ativo ? 1 : 0.55 }}>
        <td>
          <strong>{empresa.nome}</strong>
        </td>
        <td className="wms-mono wms-td-mute">{empresa.cnpj}</td>
        <td>{empresa.galpao_nome}</td>
        <td>
          {empresa.grupo ? (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <span>{empresa.grupo.nome}</span>
              {empresa.tier != null && (
                <span className="wms-mono wms-td-mute">T{empresa.tier}</span>
              )}
            </span>
          ) : (
            <span className="wms-td-mute">—</span>
          )}
        </td>
        <td>
          <StatusConexao empresa={empresa} />
        </td>
        <td>
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={onEditar}
          >
            <Icon name="edit" size={12} />
            Editar
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr style={{ background: "var(--wms-c-panel)" }}>
      <td colSpan={6} style={{ padding: 14 }}>
        <div className="wms-row-3">
          <Field label="Nome" required>
            <input
              className="wms-input"
              value={form.nome}
              onChange={(e) => setForm({ ...form, nome: e.target.value })}
            />
          </Field>
          <Field label="Galpão" required>
            <select
              className="wms-select"
              value={form.galpao_id}
              onChange={(e) => setForm({ ...form, galpao_id: e.target.value })}
            >
              {galpoes.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nome}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                color: "var(--wms-c-fg)",
                paddingTop: 6,
              }}
            >
              <input
                type="checkbox"
                checked={form.ativo}
                onChange={(e) => setForm({ ...form, ativo: e.target.checked })}
              />
              Ativa
            </label>
          </Field>
        </div>
        <p
          className="wms-td-mute"
          style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}
        >
          CNPJ não pode ser alterado depois de criado (referenciado por webhooks Tiny).
          Pra remover de fato, desative.
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 12,
          }}
        >
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={onFechar}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            disabled={!form.nome.trim() || !form.galpao_id || salvar.isPending}
            onClick={() => salvar.mutate()}
          >
            <Icon name="check" size={11} />
            {salvar.isPending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </td>
    </tr>
  );
}
