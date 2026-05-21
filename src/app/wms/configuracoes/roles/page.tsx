"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Lock, Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";

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
      <AppShell title="Roles & Permissões">
        <div className="p-6 text-zinc-400">Sem acesso a esta tela.</div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Roles & Permissões">
      <div className="max-w-5xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold">Roles & Permissões</h1>
            <p className="text-sm text-zinc-400 mt-1">
              Gerencie roles e o que cada uma pode acessar.
            </p>
          </div>
          <Link
            href="/wms/configuracoes/roles/nova"
            className="inline-flex items-center gap-2 rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-cyan-400"
          >
            <Plus size={16} /> Nova role
          </Link>
        </div>

        {isLoading && <div className="text-zinc-400">Carregando...</div>}
        {error && <div className="text-red-400">Erro ao carregar.</div>}

        {data && (
          <div className="grid gap-2">
            {data.roles.map((r) => (
              <Link
                key={r.id}
                href={`/wms/configuracoes/roles/${r.id}`}
                className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 hover:border-zinc-700"
              >
                <div className="flex items-center gap-3">
                  {r.sistema && <Lock size={14} className="text-zinc-500" />}
                  <div>
                    <div className="font-medium">
                      {r.nome}
                      {!r.ativo && <span className="ml-2 text-xs text-zinc-500">(inativa)</span>}
                    </div>
                    <div className="text-xs text-zinc-500">{r.codigo}</div>
                  </div>
                </div>
                <div className="text-xs text-zinc-400">
                  {r.n_permissoes} permissões · {r.n_usuarios} usuários
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
