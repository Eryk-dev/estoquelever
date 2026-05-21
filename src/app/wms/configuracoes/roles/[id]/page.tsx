"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";

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
      const res = await sisoFetch(`/api/wms/admin/roles/${id}`, { method: "DELETE" });
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
    return <AppShell title="Role"><div className="p-6 text-zinc-400">Sem acesso.</div></AppShell>;
  }
  if (role.isLoading || catalogo.isLoading) {
    return <AppShell title="Role"><div className="p-6 text-zinc-400">Carregando...</div></AppShell>;
  }
  if (!role.data) {
    return <AppShell title="Role"><div className="p-6 text-red-400">Role não encontrada.</div></AppShell>;
  }

  function togglePerm(codigo: string) {
    if (isAdminRole) return;
    const next = new Set(marcadas);
    if (next.has(codigo)) next.delete(codigo); else next.add(codigo);
    setMarcadas(next);
  }

  return (
    <AppShell title={role.data.nome}>
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            {role.data.sistema && <Lock size={14} className="text-zinc-500" />}
            <h1 className="text-2xl font-semibold">{role.data.nome}</h1>
          </div>
          <p className="text-sm text-zinc-500">
            Código: <code>{role.data.codigo}</code>
            {role.data.sistema && " (sistema — não editável)"}
          </p>
        </div>

        {/* Dados */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 grid gap-3">
          <label className="grid gap-1">
            <span className="text-sm text-zinc-400">Nome</span>
            <input value={nome} onChange={(e) => setNome(e.target.value)} className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2" />
          </label>
          <label className="grid gap-1">
            <span className="text-sm text-zinc-400">Descrição</span>
            <textarea value={descricao} onChange={(e) => setDescricao(e.target.value)} rows={2} className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2" />
          </label>
          {!role.data.sistema && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
              <span className="text-sm">Ativa</span>
            </label>
          )}
          <div>
            <button onClick={() => salvarMeta.mutate()} disabled={salvarMeta.isPending} className="rounded-md bg-cyan-500 px-4 py-2 text-zinc-950 hover:bg-cyan-400 disabled:opacity-50">
              {salvarMeta.isPending ? "Salvando..." : "Salvar dados"}
            </button>
          </div>
        </section>

        {/* Permissões */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
          <h2 className="font-medium mb-3">Permissões</h2>
          {isAdminRole && (
            <p className="text-xs text-zinc-400 mb-3">
              A role admin sempre tem todas as permissões (read-only).
            </p>
          )}
          <div className="grid gap-4">
            {catalogo.data?.map((m) => (
              <div key={m.id}>
                <h3 className="text-sm font-medium text-zinc-300 mb-2">— {m.label} —</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {m.permissoes.map((p) => (
                    <label key={p.codigo} className={`flex items-center gap-2 rounded px-2 py-1 ${isAdminRole ? "opacity-60" : "hover:bg-zinc-800/50"}`}>
                      <input
                        type="checkbox"
                        checked={isAdminRole ? true : marcadas.has(p.codigo)}
                        disabled={isAdminRole}
                        onChange={() => togglePerm(p.codigo)}
                      />
                      <span className="text-sm">{p.label}</span>
                      <code className="text-xs text-zinc-500">{p.codigo}</code>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4">
            <button onClick={() => salvarPerms.mutate()} disabled={salvarPerms.isPending || isAdminRole} className="rounded-md bg-cyan-500 px-4 py-2 text-zinc-950 hover:bg-cyan-400 disabled:opacity-50">
              {salvarPerms.isPending ? "Salvando..." : "Salvar permissões"}
            </button>
          </div>
        </section>

        {/* Usuários */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
          <h2 className="font-medium mb-3">Usuários ({role.data.usuarios.length})</h2>
          {role.data.usuarios.length === 0 ? (
            <p className="text-sm text-zinc-500">Nenhum usuário com esta role.</p>
          ) : (
            <ul className="grid gap-1">
              {role.data.usuarios.map((u) => (
                <li key={u.id} className="text-sm">
                  • {u.nome}
                  {u.roles.length > 1 && <span className="text-zinc-500"> (também: {u.roles.filter((r) => r !== role.data!.codigo).join(", ")})</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Deletar */}
        {!role.data.sistema && (
          <section className="rounded-lg border border-red-900/30 bg-red-950/10 p-4">
            <h2 className="font-medium text-red-300 mb-2">Zona de perigo</h2>
            <p className="text-sm text-zinc-400 mb-3">
              Deletar esta role remove-a de todos os usuários. Usuários que ficassem sem nenhuma role serão bloqueados.
            </p>
            <button
              onClick={() => {
                if (confirm(`Deletar role "${role.data!.nome}"?`)) deletar.mutate();
              }}
              disabled={deletar.isPending}
              className="rounded-md bg-red-600 px-4 py-2 text-white hover:bg-red-500 disabled:opacity-50"
            >
              {deletar.isPending ? "Deletando..." : "Deletar role"}
            </button>
          </section>
        )}
      </div>
    </AppShell>
  );
}
