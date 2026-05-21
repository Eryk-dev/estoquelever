"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";
import { Icon, PageHeader, Card, Field } from "@/components/wms/ui/wms-ui";

export default function NovaRolePage() {
  const router = useRouter();
  const { can } = usePermissoes();
  const [codigo, setCodigo] = useState("");
  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [saving, setSaving] = useState(false);

  if (!can("sistema.roles")) {
    return (
      <>
        <PageHeader
          title="Nova role"
          backHref="/wms/configuracoes/roles"
          backLabel="Roles & Permissões"
        />
        <div className="wms-empty-block">
          <h3>Acesso restrito</h3>
          <p>Apenas administradores podem criar roles.</p>
        </div>
      </>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await sisoFetch("/api/wms/admin/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigo, nome, descricao: descricao || undefined }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      toast.error(data.error ?? "Erro ao criar role");
      return;
    }
    toast.success("Role criada");
    router.push(`/wms/configuracoes/roles/${data.role.id}`);
  }

  return (
    <>
      <PageHeader
        title="Nova role"
        subtitle="Defina um código único, nome amigável e descrição"
        backHref="/wms/configuracoes/roles"
        backLabel="Roles & Permissões"
      />

      <form onSubmit={submit}>
        <Card title="Dados da role">
          <Field
            label="Código"
            required
            hint="apenas a-z, 0-9, _ — começa com letra"
          >
            <input
              required
              pattern="[a-z][a-z0-9_]*"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              placeholder="conferente"
              className="wms-input wms-mono"
              autoFocus
            />
          </Field>

          <Field label="Nome" required>
            <input
              required
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Conferente"
              className="wms-input"
            />
          </Field>

          <Field label="Descrição" hint="opcional">
            <textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              rows={3}
              className="wms-input"
              placeholder="Pra que serve esta role?"
            />
          </Field>

          <div
            style={{
              display: "flex",
              gap: 6,
              justifyContent: "flex-end",
              borderTop: "1px solid var(--wms-c-border)",
              paddingTop: 12,
              marginTop: 4,
            }}
          >
            <button
              type="button"
              onClick={() => router.back()}
              className="wms-btn wms-btn-ghost"
              disabled={saving}
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="wms-btn wms-btn-primary"
            >
              <Icon name="check" size={12} />
              {saving ? "Criando…" : "Criar role"}
            </button>
          </div>
        </Card>
      </form>
    </>
  );
}
