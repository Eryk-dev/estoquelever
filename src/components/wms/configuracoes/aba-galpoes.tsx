"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { useAuth } from "@/lib/auth-context";
import { Icon, Field } from "@/components/wms/ui/wms-ui";
import type { GalpaoHierarquiaWms } from "./types";

interface NovoGalpao {
  nome: string;
  descricao: string;
  cidade: string;
  estado: string;
  pais: string;
}

const EMPTY_NOVO: NovoGalpao = {
  nome: "",
  descricao: "",
  cidade: "",
  estado: "",
  pais: "BR",
};

export function AbaGalpoes({
  galpoes,
  isLoading,
}: {
  galpoes: GalpaoHierarquiaWms[];
  isLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const { refreshUser } = useAuth();
  const [showForm, setShowForm] = useState(false);
  const [novo, setNovo] = useState<NovoGalpao>(EMPTY_NOVO);
  const [editando, setEditando] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["wms-cfg-galpoes"] });
  };

  const criar = useMutation({
    mutationFn: () =>
      wmsApi<{ id: string; nome: string; admins_vinculados: number; admins_erro: string | null }>(
        "/api/wms/admin/galpoes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nome: novo.nome,
            descricao: novo.descricao || undefined,
            cidade: novo.cidade || undefined,
            estado: novo.estado || undefined,
            pais: novo.pais || "BR",
          }),
        },
      ),
    onSuccess: async (data) => {
      if (data.admins_erro) {
        toast.warning(
          `Galpão criado, mas falhou ao vincular admins: ${data.admins_erro}`,
        );
      } else if (data.admins_vinculados > 0) {
        toast.success(
          `Galpão criado e vinculado a ${data.admins_vinculados} admin(s)`,
        );
      } else {
        toast.success("Galpão criado");
      }
      setNovo(EMPTY_NOVO);
      setShowForm(false);
      invalidate();
      // Atualiza o seletor do sidebar imediatamente (sem re-login).
      await refreshUser();
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
        }}
      >
        <div>
          <h3 className="wms-sec-h" style={{ margin: 0 }}>
            Galpões físicos
          </h3>
          <p className="wms-td-mute" style={{ fontSize: 12, marginTop: 2 }}>
            {galpoes.length} galpão{galpoes.length === 1 ? "" : "es"} cadastrado{galpoes.length === 1 ? "" : "s"}.
            Cidade e estado alimentam o roteamento (geo-priority).
          </p>
        </div>
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          onClick={() => setShowForm((s) => !s)}
        >
          <Icon name="plus" size={12} />
          Novo galpão
        </button>
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
            Novo galpão
          </h3>
          <div className="wms-row-3">
            <Field label="Nome" required>
              <input
                className="wms-input"
                value={novo.nome}
                onChange={(e) => setNovo({ ...novo, nome: e.target.value })}
                placeholder="ex.: CWB"
                autoFocus
              />
            </Field>
            <Field label="Descrição" hint="opcional">
              <input
                className="wms-input"
                value={novo.descricao}
                onChange={(e) => setNovo({ ...novo, descricao: e.target.value })}
                placeholder="Curitiba — galpão principal"
              />
            </Field>
            <Field label="Cidade">
              <input
                className="wms-input"
                value={novo.cidade}
                onChange={(e) => setNovo({ ...novo, cidade: e.target.value })}
                placeholder="Curitiba"
              />
            </Field>
          </div>
          <div className="wms-row-3" style={{ marginTop: 8 }}>
            <Field label="Estado (UF)">
              <input
                className="wms-input wms-mono"
                value={novo.estado}
                onChange={(e) =>
                  setNovo({ ...novo, estado: e.target.value.toUpperCase().slice(0, 2) })
                }
                placeholder="PR"
                maxLength={2}
              />
            </Field>
            <Field label="País">
              <input
                className="wms-input wms-mono"
                value={novo.pais}
                onChange={(e) =>
                  setNovo({ ...novo, pais: e.target.value.toUpperCase().slice(0, 2) })
                }
                placeholder="BR"
                maxLength={2}
              />
            </Field>
            <div />
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
                setNovo(EMPTY_NOVO);
              }}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              disabled={!novo.nome.trim() || criar.isPending}
              onClick={() => criar.mutate()}
            >
              <Icon name="check" size={11} />
              {criar.isPending ? "Criando…" : "Criar galpão"}
            </button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="wms-loading-pane">Carregando galpões…</div>
      )}
      {!isLoading && galpoes.length === 0 && (
        <div className="wms-empty-block">
          <h3>Nenhum galpão cadastrado</h3>
          <p>Crie o primeiro galpão pra começar a registrar empresas, localizações e estoque.</p>
        </div>
      )}
      {galpoes.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Descrição</th>
                <th>Cidade / UF</th>
                <th>País</th>
                <th>Empresas</th>
                <th>Status</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {galpoes.map((g) => (
                <LinhaGalpao
                  key={g.id}
                  galpao={g}
                  editando={editando === g.id}
                  onEditar={() => setEditando(g.id)}
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

function LinhaGalpao({
  galpao,
  editando,
  onEditar,
  onFechar,
  onSalvo,
}: {
  galpao: GalpaoHierarquiaWms;
  editando: boolean;
  onEditar: () => void;
  onFechar: () => void;
  onSalvo: () => void;
}) {
  const { refreshUser } = useAuth();
  const [form, setForm] = useState({
    nome: galpao.nome,
    descricao: galpao.descricao ?? "",
    cidade: galpao.cidade ?? "",
    estado: galpao.estado ?? "",
    pais: galpao.pais ?? "BR",
    ativo: galpao.ativo,
  });

  const salvar = useMutation({
    mutationFn: () =>
      wmsApi(`/api/wms/admin/galpoes/${galpao.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: form.nome,
          descricao: form.descricao,
          cidade: form.cidade,
          estado: form.estado,
          pais: form.pais,
          ativo: form.ativo,
        }),
      }),
    onSuccess: async () => {
      toast.success("Galpão atualizado");
      onSalvo();
      onFechar();
      // Mudança de ativo (true↔false) ou nome reflete no seletor.
      await refreshUser();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!editando) {
    const empresasAtivas = galpao.siso_empresas.filter((e) => e.ativo).length;
    return (
      <tr style={{ opacity: galpao.ativo ? 1 : 0.55 }}>
        <td>
          <strong>{galpao.nome}</strong>
        </td>
        <td className="wms-td-mute">{galpao.descricao ?? "—"}</td>
        <td className="wms-mono">
          {galpao.cidade ?? "—"}
          {galpao.estado ? ` / ${galpao.estado}` : ""}
        </td>
        <td className="wms-mono">{galpao.pais ?? "BR"}</td>
        <td>
          {empresasAtivas}/{galpao.siso_empresas.length}
        </td>
        <td>
          {galpao.ativo ? (
            <span className="wms-badge wms-badge-ok">Ativo</span>
          ) : (
            <span className="wms-badge wms-badge-mute">Inativo</span>
          )}
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
      <td colSpan={7} style={{ padding: 14 }}>
        <div className="wms-row-3">
          <Field label="Nome" required>
            <input
              className="wms-input"
              value={form.nome}
              onChange={(e) => setForm({ ...form, nome: e.target.value })}
            />
          </Field>
          <Field label="Descrição">
            <input
              className="wms-input"
              value={form.descricao}
              onChange={(e) => setForm({ ...form, descricao: e.target.value })}
            />
          </Field>
          <Field label="Cidade">
            <input
              className="wms-input"
              value={form.cidade}
              onChange={(e) => setForm({ ...form, cidade: e.target.value })}
            />
          </Field>
        </div>
        <div className="wms-row-3" style={{ marginTop: 8 }}>
          <Field label="UF">
            <input
              className="wms-input wms-mono"
              value={form.estado}
              maxLength={2}
              onChange={(e) =>
                setForm({ ...form, estado: e.target.value.toUpperCase().slice(0, 2) })
              }
            />
          </Field>
          <Field label="País">
            <input
              className="wms-input wms-mono"
              value={form.pais}
              maxLength={2}
              onChange={(e) =>
                setForm({ ...form, pais: e.target.value.toUpperCase().slice(0, 2) })
              }
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
              Ativo
            </label>
          </Field>
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
