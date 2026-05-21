"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";
import { Icon, PageHeader, Card, Field } from "@/components/wms/ui/wms-ui";

interface RoleDetalhada {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  sistema: boolean;
  ativo: boolean;
  permissoes: string[];
  usuarios: Array<{ id: string; nome: string; roles: string[] }>;
}

interface CatalogoModulo {
  id: string;
  label: string;
  permissoes: Array<{ codigo: string; label: string }>;
}

export default function RoleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { can } = usePermissoes();

  const role = useQuery({
    queryKey: ["role", id],
    queryFn: async () => {
      const res = await sisoFetch(`/api/wms/admin/roles/${id}`);
      if (!res.ok) throw new Error();
      return (await res.json()).role as RoleDetalhada;
    },
    enabled: can("sistema.roles"),
  });

  const catalogo = useQuery({
    queryKey: ["permissoes-catalogo"],
    queryFn: async () => {
      const res = await sisoFetch("/api/wms/admin/permissoes");
      if (!res.ok) throw new Error();
      return (await res.json()).modulos as CatalogoModulo[];
    },
    enabled: can("sistema.roles"),
  });

  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [ativo, setAtivo] = useState(true);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (role.data) {
      setNome(role.data.nome);
      setDescricao(role.data.descricao ?? "");
      setAtivo(role.data.ativo);
      setMarcadas(new Set(role.data.permissoes));
    }
  }, [role.data]);

  const isAdminRole = role.data?.codigo === "admin";

  const salvarMeta = useMutation({
    mutationFn: async () => {
      const res = await sisoFetch(`/api/wms/admin/roles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome, descricao, ativo }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Erro");
    },
    onSuccess: () => {
      toast.success("Dados atualizados");
      qc.invalidateQueries({ queryKey: ["role", id] });
      qc.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const salvarPerms = useMutation({
    mutationFn: async () => {
      const res = await sisoFetch(`/api/wms/admin/roles/${id}/permissoes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissoes: Array.from(marcadas) }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Erro");
    },
    onSuccess: () => {
      toast.success("Permissões salvas");
      qc.invalidateQueries({ queryKey: ["role", id] });
      qc.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const deletar = useMutation({
    mutationFn: async () => {
      const res = await sisoFetch(`/api/wms/admin/roles/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Erro");
    },
    onSuccess: () => {
      toast.success("Role deletada");
      qc.invalidateQueries({ queryKey: ["roles"] });
      router.push("/wms/configuracoes/roles");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (!can("sistema.roles")) {
    return (
      <>
        <PageHeader
          title="Role"
          backHref="/wms/configuracoes/roles"
          backLabel="Roles & Permissões"
        />
        <div className="wms-empty-block">
          <h3>Acesso restrito</h3>
          <p>Apenas administradores podem gerenciar roles.</p>
        </div>
      </>
    );
  }

  if (role.isLoading || catalogo.isLoading) {
    return (
      <>
        <PageHeader
          title="Carregando…"
          backHref="/wms/configuracoes/roles"
          backLabel="Roles & Permissões"
        />
        <div className="wms-loading-pane">Carregando role…</div>
      </>
    );
  }

  if (!role.data) {
    return (
      <>
        <PageHeader
          title="Role"
          backHref="/wms/configuracoes/roles"
          backLabel="Roles & Permissões"
        />
        <div className="wms-empty-block">
          <h3>Role não encontrada</h3>
          <p>A role que você tentou abrir não existe ou foi removida.</p>
        </div>
      </>
    );
  }

  function togglePerm(codigo: string) {
    if (isAdminRole) return;
    const next = new Set(marcadas);
    if (next.has(codigo)) next.delete(codigo);
    else next.add(codigo);
    setMarcadas(next);
  }

  function marcarTodasDoModulo(mod: CatalogoModulo) {
    if (isAdminRole) return;
    const next = new Set(marcadas);
    const codigos = mod.permissoes.map((p) => p.codigo);
    const todasMarcadas = codigos.every((c) => next.has(c));
    if (todasMarcadas) {
      codigos.forEach((c) => next.delete(c));
    } else {
      codigos.forEach((c) => next.add(c));
    }
    setMarcadas(next);
  }

  const totalPerms = catalogo.data?.reduce((s, m) => s + m.permissoes.length, 0) ?? 0;
  const marcadasCount = isAdminRole ? totalPerms : marcadas.size;

  return (
    <>
      <PageHeader
        title={role.data.nome}
        subtitle={
          <span>
            Código:{" "}
            <code className="wms-mono">{role.data.codigo}</code>
            {role.data.sistema && (
              <span style={{ marginLeft: 8 }}>· role de sistema (não editável)</span>
            )}
          </span>
        }
        backHref="/wms/configuracoes/roles"
        backLabel="Roles & Permissões"
      >
        {role.data.sistema && (
          <span className="wms-badge wms-badge-info">Sistema</span>
        )}
        {!role.data.ativo && (
          <span className="wms-badge wms-badge-mute">Inativa</span>
        )}
      </PageHeader>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Dados */}
        <Card title="Dados">
          <Field label="Nome" required>
            <input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              className="wms-input"
              disabled={role.data.sistema}
            />
          </Field>
          <Field label="Descrição">
            <textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              rows={2}
              className="wms-input"
              disabled={role.data.sistema}
            />
          </Field>
          {!role.data.sistema && (
            <Field label="Status">
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={ativo}
                  onChange={(e) => setAtivo(e.target.checked)}
                />
                <span>Role ativa</span>
              </label>
            </Field>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              borderTop: "1px solid var(--wms-c-border)",
              paddingTop: 12,
              marginTop: 4,
            }}
          >
            <button
              onClick={() => salvarMeta.mutate()}
              disabled={salvarMeta.isPending || role.data.sistema}
              className="wms-btn wms-btn-primary"
            >
              <Icon name="check" size={12} />
              {salvarMeta.isPending ? "Salvando…" : "Salvar dados"}
            </button>
          </div>
        </Card>

        {/* Permissões */}
        <Card
          title={`Permissões (${marcadasCount} / ${totalPerms})`}
          actions={
            !isAdminRole ? (
              <button
                onClick={() => salvarPerms.mutate()}
                disabled={salvarPerms.isPending}
                className="wms-btn wms-btn-primary wms-btn-sm"
              >
                <Icon name="check" size={11} />
                {salvarPerms.isPending ? "Salvando…" : "Salvar permissões"}
              </button>
            ) : null
          }
        >
          {isAdminRole && (
            <div
              className="wms-hint-card wms-hint-info"
              style={{ fontSize: 12, marginBottom: 12 }}
            >
              <Icon name="alert" />
              <span>
                A role <strong>admin</strong> sempre tem todas as permissões (read-only).
              </span>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {catalogo.data?.map((m) => {
              const codigos = m.permissoes.map((p) => p.codigo);
              const todasMarcadas = codigos.every((c) =>
                isAdminRole ? true : marcadas.has(c),
              );
              const algumasMarcadas =
                !todasMarcadas && codigos.some((c) => marcadas.has(c));
              return (
                <div key={m.id}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 6,
                    }}
                  >
                    <h4 className="wms-sec-h" style={{ margin: 0, fontSize: 12 }}>
                      {m.label}
                    </h4>
                    <span className="wms-td-mute" style={{ fontSize: 11 }}>
                      {isAdminRole
                        ? `${codigos.length} / ${codigos.length}`
                        : `${codigos.filter((c) => marcadas.has(c)).length} / ${codigos.length}`}
                    </span>
                    {!isAdminRole && (
                      <button
                        type="button"
                        className="wms-btn wms-btn-ghost wms-btn-sm"
                        style={{ marginLeft: "auto" }}
                        onClick={() => marcarTodasDoModulo(m)}
                      >
                        {todasMarcadas ? "Desmarcar todas" : "Marcar todas"}
                      </button>
                    )}
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                      gap: 4,
                      border: "1px solid var(--wms-c-border)",
                      borderRadius: "var(--wms-r-3)",
                      background: "var(--wms-c-panel-2)",
                      padding: 6,
                      opacity: algumasMarcadas ? 1 : isAdminRole ? 0.85 : 1,
                    }}
                  >
                    {m.permissoes.map((p) => {
                      const checked = isAdminRole ? true : marcadas.has(p.codigo);
                      return (
                        <label
                          key={p.codigo}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            borderRadius: "var(--wms-r-2)",
                            cursor: isAdminRole ? "not-allowed" : "pointer",
                            background: checked
                              ? "var(--wms-c-info-bg, transparent)"
                              : "transparent",
                            fontSize: 12,
                            transition: "background .12s",
                          }}
                          onMouseEnter={(e) => {
                            if (!isAdminRole && !checked) {
                              e.currentTarget.style.background = "var(--wms-c-faint)";
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!checked) {
                              e.currentTarget.style.background = "transparent";
                            }
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isAdminRole}
                            onChange={() => togglePerm(p.codigo)}
                          />
                          <span style={{ flex: 1 }}>{p.label}</span>
                          <code
                            className="wms-mono wms-td-mute"
                            style={{ fontSize: 10 }}
                          >
                            {p.codigo}
                          </code>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Usuários */}
        <Card title={`Usuários com esta role (${role.data.usuarios.length})`}>
          {role.data.usuarios.length === 0 ? (
            <p className="wms-td-mute" style={{ fontSize: 12, margin: 0 }}>
              Nenhum usuário com esta role.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {role.data.usuarios.map((u) => {
                const outras = u.roles.filter((r) => r !== role.data!.codigo);
                return (
                  <div
                    key={u.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 10px",
                      border: "1px solid var(--wms-c-border)",
                      borderRadius: "var(--wms-r-2)",
                      background: "var(--wms-c-panel-2)",
                      fontSize: 13,
                    }}
                  >
                    <span>{u.nome}</span>
                    {outras.length > 0 && (
                      <span
                        className="wms-td-mute"
                        style={{ fontSize: 11, marginLeft: "auto" }}
                      >
                        também: {outras.join(", ")}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Zona de perigo */}
        {!role.data.sistema && (
          <Card title="Zona de perigo">
            <div
              className="wms-hint-card wms-hint-danger"
              style={{ fontSize: 12, marginBottom: 10 }}
            >
              <Icon name="alert" />
              <span>
                Deletar esta role remove-a de todos os usuários. Usuários que
                ficassem sem nenhuma role serão bloqueados.
              </span>
            </div>
            <button
              onClick={() => {
                if (confirm(`Deletar role "${role.data!.nome}"?`)) deletar.mutate();
              }}
              disabled={deletar.isPending}
              className="wms-btn wms-btn-danger wms-btn-sm"
            >
              <Icon name="trash" size={11} />
              {deletar.isPending ? "Deletando…" : "Deletar role"}
            </button>
          </Card>
        )}
      </div>
    </>
  );
}
