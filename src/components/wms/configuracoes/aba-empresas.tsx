"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, Field } from "@/components/wms/ui/wms-ui";
import type { GalpaoHierarquiaWms, EmpresaHierarquiaWms } from "./types";

interface EmpresaFlat extends EmpresaHierarquiaWms {
  galpao_principal_id: string | null;
  galpao_principal_nome: string | null;
}

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

function PreferenciaisChips({
  preferenciais,
}: {
  preferenciais: { id: string; nome: string }[];
}) {
  if (preferenciais.length === 0) {
    return <span className="wms-td-mute">—</span>;
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {preferenciais.map((p) => (
        <span
          key={p.id}
          className="wms-badge"
          style={{
            background: "var(--wms-c-faint)",
            color: "var(--wms-c-fg)",
            fontWeight: 500,
          }}
        >
          {p.nome}
        </span>
      ))}
    </div>
  );
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
  const [novo, setNovo] = useState<{
    nome: string;
    cnpj: string;
    preferenciais: string[];
  }>({ nome: "", cnpj: "", preferenciais: [] });
  const [editando, setEditando] = useState<string | null>(null);
  const [filtroGalpao, setFiltroGalpao] = useState<string>("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["wms-cfg-galpoes"] });
  };

  // De-dup por id — `galpoes` traz cada empresa aninhada no galpão espelho
  // (siso_empresas.galpao_id = primeiro preferencial), então cada empresa
  // aparece em exatamente um galpão na resposta. Mesmo assim guardamos um
  // Map por segurança.
  const todasEmpresas = useMemo<EmpresaFlat[]>(() => {
    const map = new Map<string, EmpresaFlat>();
    for (const g of galpoes) {
      for (const e of g.siso_empresas) {
        if (map.has(e.id)) continue;
        map.set(e.id, {
          ...e,
          galpao_principal_id: g.id,
          galpao_principal_nome: g.nome,
        });
      }
    }
    return [...map.values()].sort((a, b) => a.nome.localeCompare(b.nome));
  }, [galpoes]);

  const empresasFiltradas = useMemo(
    () =>
      filtroGalpao
        ? todasEmpresas.filter((e) =>
            e.preferenciais.some((p) => p.id === filtroGalpao),
          )
        : todasEmpresas,
    [todasEmpresas, filtroGalpao],
  );

  const criar = useMutation({
    mutationFn: () =>
      wmsApi("/api/wms/admin/empresas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: novo.nome,
          cnpj: novo.cnpj.replace(/\D/g, ""),
          galpoes_preferenciais: novo.preferenciais,
        }),
      }),
    onSuccess: () => {
      toast.success("Empresa criada — configure a conexão Tiny em seguida");
      setNovo({ nome: "", cnpj: "", preferenciais: [] });
      setShowForm(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleNovoPref = (id: string) => {
    setNovo((s) =>
      s.preferenciais.includes(id)
        ? { ...s, preferenciais: s.preferenciais.filter((p) => p !== id) }
        : { ...s, preferenciais: [...s.preferenciais, id] },
    );
  };

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
            Empresas operam em todos os galpões. Marcar 1 ou mais{" "}
            <strong>preferenciais</strong> é opcional — define o viés
            geográfico no roteamento (geo-priority 0).
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            className="wms-select"
            value={filtroGalpao}
            onChange={(e) => setFiltroGalpao(e.target.value)}
            style={{ minWidth: 200 }}
            title="Filtra empresas que tenham o galpão como preferencial"
          >
            <option value="">Todos (sem filtro)</option>
            {galpoes.map((g) => (
              <option key={g.id} value={g.id}>
                Preferencial: {g.nome}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            onClick={() => setShowForm((s) => !s)}
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
            <div />
          </div>
          <div style={{ marginTop: 10 }}>
            <div
              className="wms-td-mute"
              style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}
            >
              Galpões preferenciais (opcional)
            </div>
            {galpoes.length === 0 ? (
              <p className="wms-td-mute" style={{ fontSize: 12 }}>
                Cadastre pelo menos um galpão primeiro.
              </p>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {galpoes
                  .filter((g) => g.ativo)
                  .map((g) => {
                    const ativo = novo.preferenciais.includes(g.id);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => toggleNovoPref(g.id)}
                        className={`wms-toggle-pill ${ativo ? "is-on" : "is-off"}`}
                        style={{
                          padding: "4px 10px",
                          borderRadius: 999,
                          border: "1px solid var(--wms-c-border)",
                          background: ativo
                            ? "var(--wms-c-success-faint, #d1fae5)"
                            : "var(--wms-c-faint)",
                          color: ativo
                            ? "var(--wms-c-success, #047857)"
                            : "var(--wms-c-mute, #9ca3af)",
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        {ativo ? "✓ " : "+ "}
                        {g.nome}
                      </button>
                    );
                  })}
              </div>
            )}
            <p
              className="wms-td-mute"
              style={{ fontSize: 11, marginTop: 6, marginBottom: 0 }}
            >
              Empresa sem preferencial é válida — significa que o roteamento
              decide por cobertura sem viés geográfico.
            </p>
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
                setNovo({ nome: "", cnpj: "", preferenciais: [] });
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
          <h3>
            Nenhuma empresa
            {filtroGalpao ? " com esse galpão preferencial" : " cadastrada"}
          </h3>
          <p>
            {filtroGalpao
              ? "Empresas só aparecem aqui quando o galpão escolhido está marcado como preferencial."
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
                <th>Preferenciais</th>
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
  empresa: EmpresaFlat;
  galpoes: GalpaoHierarquiaWms[];
  editando: boolean;
  onEditar: () => void;
  onFechar: () => void;
  onSalvo: () => void;
}) {
  const [form, setForm] = useState({
    nome: empresa.nome,
    preferenciais: empresa.preferenciais.map((p) => p.id),
    ativo: empresa.ativo,
  });

  const salvar = useMutation({
    mutationFn: () =>
      wmsApi(`/api/wms/admin/empresas/${empresa.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: form.nome,
          galpoes_preferenciais: form.preferenciais,
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

  const togglePref = (id: string) => {
    setForm((s) =>
      s.preferenciais.includes(id)
        ? { ...s, preferenciais: s.preferenciais.filter((p) => p !== id) }
        : { ...s, preferenciais: [...s.preferenciais, id] },
    );
  };

  if (!editando) {
    return (
      <tr style={{ opacity: empresa.ativo ? 1 : 0.55 }}>
        <td>
          <strong>{empresa.nome}</strong>
        </td>
        <td className="wms-mono wms-td-mute">{empresa.cnpj}</td>
        <td>
          <PreferenciaisChips preferenciais={empresa.preferenciais} />
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
      <td colSpan={5} style={{ padding: 14 }}>
        <div className="wms-row-3">
          <Field label="Nome" required>
            <input
              className="wms-input"
              value={form.nome}
              onChange={(e) => setForm({ ...form, nome: e.target.value })}
            />
          </Field>
          <Field label="CNPJ">
            <input
              className="wms-input wms-mono"
              value={empresa.cnpj}
              disabled
              title="CNPJ não pode ser alterado (referenciado por webhooks Tiny). Pra remover, desative."
            />
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
        <div style={{ marginTop: 10 }}>
          <div
            className="wms-td-mute"
            style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}
          >
            Galpões preferenciais
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {galpoes
              .filter((g) => g.ativo)
              .map((g) => {
                const ativo = form.preferenciais.includes(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => togglePref(g.id)}
                    className={`wms-toggle-pill ${ativo ? "is-on" : "is-off"}`}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      border: "1px solid var(--wms-c-border)",
                      background: ativo
                        ? "var(--wms-c-success-faint, #d1fae5)"
                        : "var(--wms-c-faint)",
                      color: ativo
                        ? "var(--wms-c-success, #047857)"
                        : "var(--wms-c-mute, #9ca3af)",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {ativo ? "✓ " : "+ "}
                    {g.nome}
                  </button>
                );
              })}
          </div>
          <p
            className="wms-td-mute"
            style={{ fontSize: 11, marginTop: 6, marginBottom: 0 }}
          >
            Vazio = sem viés geográfico no roteamento.
          </p>
        </div>
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
            disabled={!form.nome.trim() || salvar.isPending}
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
