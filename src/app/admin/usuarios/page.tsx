"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  Loader2,
  Plus,
  Trash2,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { CARGO_LABELS, type Cargo } from "@/types";

// ─── Types ──────────────────────────────────────────────────────────────────

interface UsuarioListItem {
  id: string;
  nome: string;
  cargo: Cargo;
  ativo: boolean;
  criado_em: string;
  atualizado_em: string;
}

const CARGOS: Cargo[] = ["admin", "operador_cwb", "operador_sp", "comprador"];

const CARGO_COLORS: Record<Cargo, string> = {
  admin:
    "bg-purple-50 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300",
  operador_cwb:
    "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
  operador_sp:
    "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
  comprador:
    "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
};

// ─── Page ───────────────────────────────────────────────────────────────────

export default function AdminUsuariosPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [usuarios, setUsuarios] = useState<UsuarioListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Guard: only admin can access
  useEffect(() => {
    if (!authLoading && (!user || user.cargo !== "admin")) {
      router.replace("/");
    }
  }, [user, authLoading, router]);

  const fetchUsuarios = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/usuarios");
      const data = await res.json();
      setUsuarios(Array.isArray(data) ? data : []);
    } catch {
      toast.error("Erro ao carregar usuários");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user?.cargo === "admin") fetchUsuarios();
  }, [user, fetchUsuarios]);

  if (authLoading || !user || user.cargo !== "admin") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <Link
            href="/configuracoes"
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Link>
          <div>
            <h1 className="text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
              Usuários
            </h1>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
              Gerenciar acessos e cargos
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        {/* Add user button */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-zinc-400" />
            <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
              {usuarios.length} usuário{usuarios.length !== 1 ? "s" : ""}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white transition-all hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            <Plus className="h-3.5 w-3.5" />
            Novo Usuário
          </button>
        </div>

        {/* New user form */}
        {showForm && (
          <NovoUsuarioForm
            onCreated={() => {
              setShowForm(false);
              fetchUsuarios();
            }}
            onCancel={() => setShowForm(false)}
          />
        )}

        {/* List */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {usuarios.map((u) => (
              <UsuarioRow
                key={u.id}
                usuario={u}
                isSelf={u.id === user.id}
                onUpdated={fetchUsuarios}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// ─── New User Form ──────────────────────────────────────────────────────────

function NovoUsuarioForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [nome, setNome] = useState("");
  const [pin, setPin] = useState("");
  const [cargo, setCargo] = useState<Cargo>("operador_cwb");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!nome.trim() || pin.length !== 4) return;

    setSaving(true);
    try {
      const res = await fetch("/api/admin/usuarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: nome.trim(), pin, cargo }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.erro ?? "Erro ao criar");
      }
      toast.success(`Usuário ${nome.trim()} criado`);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar usuário");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="animate-slide-up overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-700/60 dark:bg-zinc-900"
    >
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
          Novo Usuário
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3 px-4 py-4">
        {/* Nome */}
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Nome
          </label>
          <input
            type="text"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="Nome do usuário"
            autoFocus
            className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 outline-none transition-colors focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          />
        </div>

        {/* PIN */}
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
            PIN (4 dígitos)
          </label>
          <input
            type="text"
            inputMode="numeric"
            maxLength={4}
            value={pin}
            onChange={(e) =>
              setPin(e.target.value.replace(/\D/g, "").slice(0, 4))
            }
            placeholder="0000"
            className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm tracking-widest text-zinc-700 outline-none transition-colors focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          />
        </div>

        {/* Cargo */}
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Cargo
          </label>
          <div className="flex flex-wrap gap-2">
            {CARGOS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCargo(c)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-semibold transition-all",
                  cargo === c
                    ? cn(CARGO_COLORS[c], "ring-2 ring-zinc-300 dark:ring-zinc-600")
                    : "bg-zinc-100 text-zinc-400 hover:text-zinc-600 dark:bg-zinc-800 dark:hover:text-zinc-300",
                )}
              >
                {CARGO_LABELS[c]}
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving || !nome.trim() || pin.length !== 4}
            className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-1.5 text-xs font-semibold text-white transition-all hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Criar
          </button>
        </div>
      </div>
    </form>
  );
}

// ─── User Row ───────────────────────────────────────────────────────────────

function UsuarioRow({
  usuario,
  isSelf,
  onUpdated,
}: {
  usuario: UsuarioListItem;
  isSelf: boolean;
  onUpdated: () => void;
}) {
  const [editingCargo, setEditingCargo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleToggleAtivo() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/usuarios", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: usuario.id, ativo: !usuario.ativo }),
      });
      if (!res.ok) throw new Error();
      toast.success(
        `${usuario.nome} ${usuario.ativo ? "desativado" : "ativado"}`,
      );
      onUpdated();
    } catch {
      toast.error("Erro ao atualizar");
    } finally {
      setSaving(false);
    }
  }

  async function handleChangeCargo(novoCargo: Cargo) {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/usuarios", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: usuario.id, cargo: novoCargo }),
      });
      if (!res.ok) throw new Error();
      toast.success(`Cargo de ${usuario.nome} alterado`);
      setEditingCargo(false);
      onUpdated();
    } catch {
      toast.error("Erro ao alterar cargo");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Excluir ${usuario.nome} permanentemente?`)) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/admin/usuarios?id=${usuario.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error();
      toast.success(`${usuario.nome} excluído`);
      onUpdated();
    } catch {
      toast.error("Erro ao excluir");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-white dark:bg-zinc-900",
        usuario.ativo
          ? "border-zinc-200 dark:border-zinc-700/60"
          : "border-zinc-200 opacity-50 dark:border-zinc-700/60",
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Name + cargo */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
              {usuario.nome}
            </span>
            {isSelf && (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 dark:bg-zinc-800">
                você
              </span>
            )}
          </div>

          {/* Cargo badge or editor */}
          {editingCargo ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {CARGOS.map((c) => (
                <button
                  key={c}
                  type="button"
                  disabled={saving}
                  onClick={() => handleChangeCargo(c)}
                  className={cn(
                    "rounded-md px-2 py-1 text-[11px] font-semibold transition-all",
                    c === usuario.cargo
                      ? cn(CARGO_COLORS[c], "ring-1 ring-zinc-300 dark:ring-zinc-600")
                      : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700",
                  )}
                >
                  {CARGO_LABELS[c]}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setEditingCargo(false)}
                className="ml-1 text-[11px] text-zinc-400 hover:text-zinc-600"
              >
                cancelar
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditingCargo(true)}
              className={cn(
                "mt-0.5 rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors hover:ring-1 hover:ring-zinc-300 dark:hover:ring-zinc-600",
                CARGO_COLORS[usuario.cargo],
              )}
              title="Clique para alterar cargo"
            >
              {CARGO_LABELS[usuario.cargo]}
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5">
          {/* Toggle ativo */}
          {!isSelf && (
            <button
              type="button"
              onClick={handleToggleAtivo}
              disabled={saving}
              className={cn(
                "rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors",
                usuario.ativo
                  ? "border-zinc-200 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  : "border-emerald-200 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-800 dark:hover:bg-emerald-950/30",
              )}
            >
              {usuario.ativo ? "Desativar" : "Ativar"}
            </button>
          )}

          {/* Delete */}
          {!isSelf && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-lg border border-zinc-200 p-1.5 text-zinc-400 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-500 dark:border-zinc-700 dark:hover:border-red-800 dark:hover:bg-red-950/30"
              title="Excluir usuário"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
