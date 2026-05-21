"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";

export default function NovaRolePage() {
  const router = useRouter();
  const { can } = usePermissoes();
  const [codigo, setCodigo] = useState("");
  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [saving, setSaving] = useState(false);

  if (!can("sistema.roles")) {
    return (
      <AppShell title="Nova role">
        <div className="p-6 text-zinc-400">Sem acesso.</div>
      </AppShell>
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
    <AppShell title="Nova role">
      <div className="max-w-xl mx-auto p-6">
        <h1 className="text-2xl font-semibold mb-6">Nova role</h1>
        <form onSubmit={submit} className="grid gap-4">
          <label className="grid gap-1">
            <span className="text-sm text-zinc-400">Código</span>
            <input
              required
              pattern="[a-z][a-z0-9_]*"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              placeholder="conferente"
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
            />
            <span className="text-xs text-zinc-500">apenas a-z, 0-9, _ — começa com letra</span>
          </label>
          <label className="grid gap-1">
            <span className="text-sm text-zinc-400">Nome</span>
            <input
              required
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Conferente"
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-sm text-zinc-400">Descrição (opcional)</span>
            <textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              rows={3}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => router.back()} className="rounded-md px-4 py-2 text-zinc-300 hover:bg-zinc-800">
              Cancelar
            </button>
            <button type="submit" disabled={saving} className="rounded-md bg-cyan-500 px-4 py-2 text-zinc-950 hover:bg-cyan-400 disabled:opacity-50">
              {saving ? "Criando..." : "Criar role"}
            </button>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
