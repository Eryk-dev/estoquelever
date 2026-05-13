"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, Field } from "@/components/wms/ui/wms-ui";
import type { GalpaoHierarquiaWms, GrupoInfoWms } from "./types";

export function AbaGrupos({
  grupos,
  galpoes,
  isLoading,
}: {
  grupos: GrupoInfoWms[];
  galpoes: GalpaoHierarquiaWms[];
  isLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [novoNome, setNovoNome] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["wms-cfg-galpoes"] });
    queryClient.invalidateQueries({ queryKey: ["wms-cfg-grupos"] });
  };

  // Empresas já em algum grupo (não podem ser adicionadas a outro).
  const empresasJaEmGrupo = useMemo(
    () =>
      new Set(
        grupos.flatMap((g) =>
          g.siso_grupo_empresas.map((ge) => ge.siso_empresas.id),
        ),
      ),
    [grupos],
  );

  // Todas empresas ativas, com galpão.
  const todasEmpresas = useMemo(
    () =>
      galpoes.flatMap((g) =>
        g.siso_empresas
          .filter((e) => e.ativo)
          .map((e) => ({
            id: e.id,
            nome: e.nome,
            cnpj: e.cnpj,
            galpao_nome: g.nome,
          })),
      ),
    [galpoes],
  );

  const empresasDisponiveis = useMemo(
    () => todasEmpresas.filter((e) => !empresasJaEmGrupo.has(e.id)),
    [todasEmpresas, empresasJaEmGrupo],
  );

  const criar = useMutation({
    mutationFn: () =>
      wmsApi("/api/admin/grupos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: novoNome.trim() }),
      }),
    onSuccess: () => {
      toast.success("Grupo criado");
      setNovoNome("");
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
        }}
      >
        <div>
          <h3 className="wms-sec-h" style={{ margin: 0 }}>
            Grupos &amp; Tiers
          </h3>
          <p className="wms-td-mute" style={{ fontSize: 12, marginTop: 2 }}>
            Empresas no mesmo grupo consultam estoque entre si. <strong>Tier</strong>{" "}
            define ordem de dedução (1 = preferido). Empresa origem do pedido vira tier 1
            em runtime.
          </p>
        </div>
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          onClick={() => setShowForm((s) => !s)}
        >
          <Icon name="plus" size={12} />
          Novo grupo
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
            display: "flex",
            gap: 8,
            alignItems: "flex-end",
          }}
        >
          <Field label="Nome do grupo" required>
            <input
              className="wms-input"
              value={novoNome}
              onChange={(e) => setNovoNome(e.target.value)}
              placeholder="ex.: Autopecas"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && novoNome.trim()) criar.mutate();
              }}
              style={{ minWidth: 280 }}
            />
          </Field>
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            disabled={!novoNome.trim() || criar.isPending}
            onClick={() => criar.mutate()}
          >
            <Icon name="check" size={11} />
            {criar.isPending ? "Criando…" : "Criar"}
          </button>
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={() => {
              setShowForm(false);
              setNovoNome("");
            }}
          >
            Cancelar
          </button>
        </div>
      )}

      {isLoading && <div className="wms-loading-pane">Carregando grupos…</div>}
      {!isLoading && grupos.length === 0 && (
        <div className="wms-empty-block">
          <h3>Nenhum grupo cadastrado</h3>
          <p>
            Empresas sem grupo não participam de consultas de estoque cruzado e seguem
            apenas seu próprio saldo.
          </p>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {grupos.map((grupo) => (
          <GrupoCard
            key={grupo.id}
            grupo={grupo}
            empresasDisponiveis={empresasDisponiveis}
            onRefresh={invalidate}
          />
        ))}
      </div>
    </>
  );
}

function GrupoCard({
  grupo,
  empresasDisponiveis,
  onRefresh,
}: {
  grupo: GrupoInfoWms;
  empresasDisponiveis: { id: string; nome: string; cnpj: string; galpao_nome: string }[];
  onRefresh: () => void;
}) {
  const [adicionando, setAdicionando] = useState(false);
  const [empresaSel, setEmpresaSel] = useState("");
  const [tierSel, setTierSel] = useState(1);
  const [removendo, setRemovendo] = useState<string | null>(null);

  const adicionar = useMutation({
    mutationFn: () =>
      wmsApi(`/api/admin/grupos/${grupo.id}/empresas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ empresa_id: empresaSel, tier: tierSel }),
      }),
    onSuccess: () => {
      toast.success("Empresa adicionada ao grupo");
      setEmpresaSel("");
      setTierSel(1);
      setAdicionando(false);
      onRefresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remover = useMutation({
    mutationFn: (empresaId: string) =>
      wmsApi(`/api/admin/grupos/${grupo.id}/empresas/${empresaId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Empresa removida do grupo");
      setRemovendo(null);
      onRefresh();
    },
    onError: (e: Error) => {
      toast.error(e.message);
      setRemovendo(null);
    },
  });

  const editarTier = useMutation({
    mutationFn: ({ empresaId, tier }: { empresaId: string; tier: number }) =>
      wmsApi(`/api/admin/grupos/${grupo.id}/empresas/${empresaId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      }),
    onSuccess: () => {
      toast.success("Tier atualizado");
      onRefresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const excluirGrupo = useMutation({
    mutationFn: () =>
      wmsApi(`/api/admin/grupos/${grupo.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Grupo excluído");
      onRefresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const ordenadas = [...grupo.siso_grupo_empresas].sort((a, b) => a.tier - b.tier);

  return (
    <div
      style={{
        background: "var(--wms-c-panel)",
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderBottom: "1px solid var(--wms-c-border)",
        }}
      >
        <strong style={{ fontSize: 14, color: "var(--wms-c-fg)" }}>{grupo.nome}</strong>
        <span className="wms-td-mute" style={{ fontSize: 12 }}>
          {grupo.siso_grupo_empresas.length} empresa
          {grupo.siso_grupo_empresas.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          className="wms-btn wms-btn-ghost"
          style={{ marginLeft: "auto" }}
          onClick={() => {
            if (
              window.confirm(
                `Excluir grupo "${grupo.nome}"? Só funciona se não tiver empresas vinculadas.`,
              )
            ) {
              excluirGrupo.mutate();
            }
          }}
          disabled={excluirGrupo.isPending}
          title="Excluir grupo"
        >
          <Icon name="trash" size={12} />
        </button>
      </div>

      {ordenadas.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th style={{ width: 80 }}>Tier</th>
                <th>Empresa</th>
                <th>CNPJ</th>
                <th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {ordenadas.map((ge) => (
                <tr key={ge.id}>
                  <td>
                    <input
                      type="number"
                      min={1}
                      className="wms-input wms-mono"
                      value={ge.tier}
                      style={{ width: 60, padding: "4px 8px", textAlign: "center" }}
                      onChange={(e) => {
                        const t = Math.max(1, parseInt(e.target.value, 10) || 1);
                        if (t !== ge.tier) {
                          editarTier.mutate({ empresaId: ge.siso_empresas.id, tier: t });
                        }
                      }}
                    />
                  </td>
                  <td>
                    <strong>{ge.siso_empresas.nome}</strong>
                  </td>
                  <td className="wms-mono wms-td-mute">{ge.siso_empresas.cnpj}</td>
                  <td>
                    <button
                      type="button"
                      className="wms-btn wms-btn-ghost"
                      disabled={removendo === ge.siso_empresas.id}
                      onClick={() => {
                        setRemovendo(ge.siso_empresas.id);
                        remover.mutate(ge.siso_empresas.id);
                      }}
                      title="Remover do grupo"
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ padding: 12, borderTop: ordenadas.length > 0 ? "1px solid var(--wms-c-border)" : undefined }}>
        {adicionando ? (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <Field label="Empresa">
              <select
                className="wms-select"
                value={empresaSel}
                onChange={(e) => setEmpresaSel(e.target.value)}
                style={{ minWidth: 280 }}
                autoFocus
              >
                <option value="">Selecione…</option>
                {empresasDisponiveis.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.nome} ({e.galpao_nome}) — {e.cnpj}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tier">
              <input
                type="number"
                min={1}
                className="wms-input wms-mono"
                value={tierSel}
                onChange={(e) =>
                  setTierSel(Math.max(1, parseInt(e.target.value, 10) || 1))
                }
                style={{ width: 80, textAlign: "center" }}
              />
            </Field>
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              disabled={!empresaSel || adicionar.isPending}
              onClick={() => adicionar.mutate()}
            >
              <Icon name="check" size={11} />
              Adicionar
            </button>
            <button
              type="button"
              className="wms-btn wms-btn-ghost"
              onClick={() => {
                setAdicionando(false);
                setEmpresaSel("");
                setTierSel(1);
              }}
            >
              Cancelar
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            disabled={empresasDisponiveis.length === 0}
            onClick={() => setAdicionando(true)}
            title={
              empresasDisponiveis.length === 0
                ? "Todas as empresas ativas já estão em algum grupo"
                : undefined
            }
          >
            <Icon name="plus" size={12} />
            Adicionar empresa ao grupo
          </button>
        )}
      </div>
    </div>
  );
}
