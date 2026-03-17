"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  Check,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { CARGO_LABELS, type Cargo } from "@/types";
import { AppShell } from "@/components/app-shell";

// ─── Types ──────────────────────────────────────────────────────────────────

interface GalpaoRef {
  id: string;
  nome: string;
}

interface UsuarioListItem {
  id: string;
  nome: string;
  cargo: Cargo;
  cargos: Cargo[];
  ativo: boolean;
  criado_em: string;
  atualizado_em: string;
  galpoes: GalpaoRef[];
}

const CARGOS: Cargo[] = ["admin", "operador", "comprador"];

const CARGO_COLORS: Record<string, string> = {
  admin:
    "bg-purple-50 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300",
  operador:
    "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
  operador_cwb:
    "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
  operador_sp:
    "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
  comprador:
    "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
};

// ─── Page ───────────────────────────────────────────────────────────────────

export default function AdminUsuariosPage() {
  const { user } = useAuth();
  const [usuarios, setUsuarios] = useState<UsuarioListItem[]>([]);
  const [galpoes, setGalpoes] = useState<GalpaoRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

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

  const fetchGalpoes = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/galpoes");
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.galpoes ?? [];
      setGalpoes(list.map((g: { id: string; nome: string }) => ({ id: g.id, nome: g.nome })));
    } catch {
      // Galpões not critical — user can still manage
    }
  }, []);

  useEffect(() => {
    fetchUsuarios();
    fetchGalpoes();
  }, [fetchUsuarios, fetchGalpoes]);

  return (
    <AppShell
      title="Usuários"
      subtitle="Gerenciar acessos, cargos e galpões"
      backHref="/configuracoes"
      requireAdmin={true}
      mainClassName="space-y-4"
    >
      {/* Add user button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-ink-faint" />
          <h2 className="text-sm font-semibold text-ink">
            {usuarios.length} usuário{usuarios.length !== 1 ? "s" : ""}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all"
        >
          <Plus className="h-3.5 w-3.5" />
          Novo Usuário
        </button>
      </div>

      {/* New user form */}
      {showForm && (
        <NovoUsuarioForm
          galpoes={galpoes}
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
          <Loader2 className="h-5 w-5 animate-spin text-ink-faint" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {usuarios.map((u) => (
            <UsuarioRow
              key={u.id}
              usuario={u}
              isSelf={u.id === user?.id}
              allGalpoes={galpoes}
              onUpdated={fetchUsuarios}
            />
          ))}
        </div>
      )}
    </AppShell>
  );
}

// ─── Cargo Multi-Select ─────────────────────────────────────────────────────

function CargoMultiSelect({
  selected,
  onChange,
  disabled,
}: {
  selected: Cargo[];
  onChange: (cargos: Cargo[]) => void;
  disabled?: boolean;
}) {
  function toggle(cargo: Cargo) {
    if (disabled) return;
    if (selected.includes(cargo)) {
      // Don't allow removing the last cargo
      if (selected.length <= 1) return;
      onChange(selected.filter((c) => c !== cargo));
    } else {
      onChange([...selected, cargo]);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {CARGOS.map((c) => (
        <button
          key={c}
          type="button"
          disabled={disabled}
          onClick={() => toggle(c)}
          className={cn(
            "rounded-lg px-3 py-1.5 text-xs font-semibold transition-all",
            selected.includes(c)
              ? cn(CARGO_COLORS[c], "ring-2 ring-zinc-300 dark:ring-zinc-600")
              : "bg-zinc-100 text-zinc-400 hover:text-zinc-600 dark:bg-zinc-800 dark:hover:text-zinc-300",
          )}
        >
          {CARGO_LABELS[c]}
        </button>
      ))}
    </div>
  );
}

// ─── Galpão Multi-Select ────────────────────────────────────────────────────

function GalpaoMultiSelect({
  allGalpoes,
  selected,
  onChange,
  disabled,
}: {
  allGalpoes: GalpaoRef[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  if (allGalpoes.length === 0) return null;

  function toggle(id: string) {
    if (disabled) return;
    if (selected.includes(id)) {
      onChange(selected.filter((g) => g !== id));
    } else {
      onChange([...selected, id]);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {allGalpoes.map((g) => (
        <button
          key={g.id}
          type="button"
          disabled={disabled}
          onClick={() => toggle(g.id)}
          className={cn(
            "inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all",
            selected.includes(g.id)
              ? "bg-emerald-50 text-emerald-700 ring-2 ring-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-700"
              : "bg-zinc-100 text-zinc-400 hover:text-zinc-600 dark:bg-zinc-800 dark:hover:text-zinc-300",
          )}
        >
          <MapPin className="h-3 w-3" />
          {g.nome}
        </button>
      ))}
    </div>
  );
}

// ─── New User Form ──────────────────────────────────────────────────────────

function NovoUsuarioForm({
  galpoes,
  onCreated,
  onCancel,
}: {
  galpoes: GalpaoRef[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [nome, setNome] = useState("");
  const [pin, setPin] = useState("");
  const [cargos, setCargos] = useState<Cargo[]>(["operador"]);
  const [galpaoIds, setGalpaoIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const needsGalpao = cargos.includes("operador");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!nome.trim() || pin.length !== 4 || cargos.length === 0) return;

    setSaving(true);
    try {
      const res = await fetch("/api/admin/usuarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: nome.trim(), pin, cargos, galpao_ids: galpaoIds }),
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
      className="animate-slide-up overflow-hidden rounded-xl border border-line bg-paper"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="text-sm font-semibold text-ink">Novo Usuário</span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 text-ink-faint hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3 px-4 py-4">
        {/* Nome */}
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">
            Nome
          </label>
          <input
            type="text"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="Nome do usuário"
            autoFocus
            className="w-full rounded-lg border border-line bg-zinc-50 px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 dark:bg-zinc-800"
          />
        </div>

        {/* PIN */}
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">
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
            className="w-full rounded-lg border border-line bg-zinc-50 px-3 py-2 font-mono text-sm tracking-widest text-ink outline-none transition-colors focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 dark:bg-zinc-800"
          />
        </div>

        {/* Cargos */}
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">
            Cargos
          </label>
          <CargoMultiSelect selected={cargos} onChange={setCargos} />
          <p className="mt-1 text-[10px] text-ink-faint">
            Selecione um ou mais cargos
          </p>
        </div>

        {/* Galpões */}
        {needsGalpao && galpoes.length > 0 && (
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-muted">
              Galpões
            </label>
            <GalpaoMultiSelect
              allGalpoes={galpoes}
              selected={galpaoIds}
              onChange={setGalpaoIds}
            />
            <p className="mt-1 text-[10px] text-ink-faint">
              Selecione os galpões que o operador pode acessar
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-muted transition-colors hover:bg-surface"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving || !nome.trim() || pin.length !== 4 || cargos.length === 0}
            className="btn-primary inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-30"
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
  allGalpoes,
  onUpdated,
}: {
  usuario: UsuarioListItem;
  isSelf: boolean;
  allGalpoes: GalpaoRef[];
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const cargos: Cargo[] = usuario.cargos?.length ? usuario.cargos : [usuario.cargo];
  // Normalize legacy cargos for display
  const displayCargos = cargos.map((c) => {
    if (c === "operador_cwb" || c === "operador_sp") return c;
    return c;
  });

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
        "overflow-hidden rounded-xl border bg-paper",
        usuario.ativo
          ? "border-line"
          : "border-line opacity-50",
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Name + cargo + galpões */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-ink">
              {usuario.nome}
            </span>
            {isSelf && (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-faint dark:bg-zinc-800">
                você
              </span>
            )}
          </div>

          {/* Cargo badges + galpão badges or editor */}
          {editing ? (
            <EditUserInline
              usuario={usuario}
              allGalpoes={allGalpoes}
              saving={saving}
              onSave={async (newCargos, newGalpaoIds) => {
                setSaving(true);
                try {
                  const res = await fetch("/api/admin/usuarios", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      id: usuario.id,
                      cargos: newCargos,
                      galpao_ids: newGalpaoIds,
                    }),
                  });
                  if (!res.ok) throw new Error();
                  toast.success(`${usuario.nome} atualizado`);
                  setEditing(false);
                  onUpdated();
                } catch {
                  toast.error("Erro ao atualizar");
                } finally {
                  setSaving(false);
                }
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <div className="mt-0.5 flex flex-wrap items-center gap-1">
              {displayCargos.map((c) => (
                <span
                  key={c}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] font-semibold",
                    CARGO_COLORS[c] ?? CARGO_COLORS.operador,
                  )}
                >
                  {CARGO_LABELS[c] ?? c}
                </span>
              ))}
              {usuario.galpoes.length > 0 && (
                <>
                  <span className="text-[10px] text-ink-faint">·</span>
                  {usuario.galpoes.map((g) => (
                    <span
                      key={g.id}
                      className="inline-flex items-center gap-0.5 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                    >
                      <MapPin className="h-2.5 w-2.5" />
                      {g.nome}
                    </span>
                  ))}
                </>
              )}
              {!isSelf && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-1 rounded-md border border-dashed border-zinc-300 px-1.5 py-0.5 text-[11px] text-ink-faint transition-colors hover:border-zinc-400 hover:text-ink dark:border-zinc-600 dark:hover:border-zinc-500"
                  title="Editar cargos e galpões"
                >
                  <Pencil className="h-2.5 w-2.5" />
                  Editar
                </button>
              )}
            </div>
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
                  ? "border-line text-ink-muted hover:bg-surface"
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
              className="rounded-lg border border-line p-1.5 text-ink-faint transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-500 dark:hover:border-red-800 dark:hover:bg-red-950/30"
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

// ─── Inline Editor (Cargos + Galpões) ───────────────────────────────────────

function EditUserInline({
  usuario,
  allGalpoes,
  saving,
  onSave,
  onCancel,
}: {
  usuario: UsuarioListItem;
  allGalpoes: GalpaoRef[];
  saving: boolean;
  onSave: (cargos: Cargo[], galpaoIds: string[]) => void;
  onCancel: () => void;
}) {
  const currentCargos = usuario.cargos?.length ? usuario.cargos : [usuario.cargo];
  // Normalize legacy operador_cwb/operador_sp to operador
  const normalizedCargos = currentCargos.map((c) =>
    c === "operador_cwb" || c === "operador_sp" ? "operador" : c,
  ) as Cargo[];
  const dedupedCargos = [...new Set(normalizedCargos)] as Cargo[];

  const [selectedCargos, setSelectedCargos] = useState<Cargo[]>(dedupedCargos);
  const [selectedGalpaoIds, setSelectedGalpaoIds] = useState<string[]>(
    usuario.galpoes.map((g) => g.id),
  );

  const needsGalpao = selectedCargos.includes("operador");

  const cargosChanged =
    JSON.stringify([...selectedCargos].sort()) !== JSON.stringify([...dedupedCargos].sort());
  const galpoesChanged =
    JSON.stringify([...selectedGalpaoIds].sort()) !==
    JSON.stringify([...usuario.galpoes.map((g) => g.id)].sort());
  const changed = cargosChanged || galpoesChanged;

  return (
    <div className="mt-1.5 space-y-2">
      {/* Cargos */}
      <div className="flex flex-wrap items-center gap-1.5">
        {CARGOS.map((c) => (
          <button
            key={c}
            type="button"
            disabled={saving}
            onClick={() => {
              if (saving) return;
              if (selectedCargos.includes(c)) {
                if (selectedCargos.length <= 1) return;
                setSelectedCargos(selectedCargos.filter((x) => x !== c));
              } else {
                setSelectedCargos([...selectedCargos, c]);
              }
            }}
            className={cn(
              "rounded-md px-2 py-1 text-[11px] font-semibold transition-all",
              selectedCargos.includes(c)
                ? cn(CARGO_COLORS[c], "ring-1 ring-zinc-300 dark:ring-zinc-600")
                : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700",
            )}
          >
            {CARGO_LABELS[c]}
          </button>
        ))}
      </div>

      {/* Galpões */}
      {needsGalpao && allGalpoes.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-medium text-ink-faint">Galpões</p>
          <GalpaoMultiSelect
            allGalpoes={allGalpoes}
            selected={selectedGalpaoIds}
            onChange={setSelectedGalpaoIds}
            disabled={saving}
          />
        </div>
      )}

      {/* Save / Cancel */}
      <div className="flex items-center gap-2">
        {changed && (
          <button
            type="button"
            disabled={saving}
            onClick={() => onSave(selectedCargos, selectedGalpaoIds)}
            className="rounded-md bg-emerald-100 px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Salvar"}
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] text-ink-faint hover:text-ink"
        >
          cancelar
        </button>
      </div>
    </div>
  );
}
