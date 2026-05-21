"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";
import { Icon, PageHeader, Card } from "@/components/wms/ui/wms-ui";

interface RoleRow {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  sistema: boolean;
  ativo: boolean;
  n_permissoes: number;
  n_usuarios: number;
}

export default function RolesPage() {
  const { can } = usePermissoes();

  const { data, isLoading, error } = useQuery({
    queryKey: ["roles"],
    queryFn: async () => {
      const res = await sisoFetch("/api/wms/admin/roles");
      if (!res.ok) throw new Error("Falha ao carregar roles");
      return res.json() as Promise<{ roles: RoleRow[] }>;
    },
    enabled: can("sistema.roles"),
  });

  if (!can("sistema.roles")) {
    return (
      <>
        <PageHeader
          title="Roles & Permissões"
          backHref="/wms/configuracoes"
          backLabel="Configurações"
        />
        <div className="wms-empty-block">
          <h3>Acesso restrito</h3>
          <p>Apenas administradores podem gerenciar roles.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Roles & Permissões"
        subtitle="Gerencie roles e o que cada uma pode acessar"
        backHref="/wms/configuracoes"
        backLabel="Configurações"
      >
        <Link
          href="/wms/configuracoes/roles/nova"
          className="wms-btn wms-btn-primary"
        >
          <Icon name="plus" size={12} />
          Nova role
        </Link>
      </PageHeader>

      <Card title={`Roles cadastradas${data ? ` (${data.roles.length})` : ""}`}>
        {isLoading && (
          <div className="wms-loading-pane">Carregando roles…</div>
        )}
        {error && (
          <div className="wms-hint-card wms-hint-danger" style={{ fontSize: 12 }}>
            <Icon name="alert" />
            <span>Erro ao carregar roles.</span>
          </div>
        )}

        {data && data.roles.length === 0 && (
          <p className="wms-td-mute" style={{ fontSize: 12, margin: 0 }}>
            Nenhuma role cadastrada ainda.
          </p>
        )}

        {data && data.roles.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data.roles.map((r) => (
              <Link
                key={r.id}
                href={`/wms/configuracoes/roles/${r.id}`}
                style={{
                  border: "1px solid var(--wms-c-border)",
                  borderRadius: "var(--wms-r-3)",
                  background: "var(--wms-c-panel-2)",
                  padding: "10px 12px",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  textDecoration: "none",
                  transition: "border-color .15s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--wms-c-border-2)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--wms-c-border)";
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <strong style={{ fontSize: 14 }}>{r.nome}</strong>
                    <code className="wms-mono wms-td-mute" style={{ fontSize: 11 }}>
                      {r.codigo}
                    </code>
                    {r.sistema && (
                      <span className="wms-badge wms-badge-info">Sistema</span>
                    )}
                    {!r.ativo && (
                      <span className="wms-badge wms-badge-mute">Inativa</span>
                    )}
                  </div>
                  {r.descricao && (
                    <p
                      className="wms-td-mute"
                      style={{ fontSize: 12, margin: "4px 0 0" }}
                    >
                      {r.descricao}
                    </p>
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-end",
                    gap: 2,
                    fontSize: 11,
                  }}
                  className="wms-td-mute"
                >
                  <span>
                    <strong style={{ color: "var(--wms-c-fg)" }}>
                      {r.n_permissoes}
                    </strong>{" "}
                    permissões
                  </span>
                  <span>
                    <strong style={{ color: "var(--wms-c-fg)" }}>
                      {r.n_usuarios}
                    </strong>{" "}
                    {r.n_usuarios === 1 ? "usuário" : "usuários"}
                  </span>
                </div>
                <Icon name="chevron-r" size={14} className="wms-td-mute" />
              </Link>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
