"use client";
import { use, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { useInventarioRealtime } from "@/hooks/use-inventario-realtime";
import { toast } from "sonner";
import Link from "next/link";

interface SessaoData {
  sessao?: { status: string; tipo: string; modo_contagem: string } | null;
  areas?: Array<{ id: string; nome: string; operador?: { nome?: string } }>;
}

export default function InventarioDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const { contagens, locs } = useInventarioRealtime(id);

  const { data } = useQuery({
    queryKey: ["wms-inv", id],
    queryFn: async () =>
      (await sisoFetch(`/api/wms/inventario/${id}`)).json() as Promise<SessaoData>,
  });

  const iniciar = useMutation({
    mutationFn: async () =>
      sisoFetch(`/api/wms/inventario/${id}/iniciar`, { method: "POST" }).then(
        (r) => r.json(),
      ),
    onSuccess: () => {
      toast.success("iniciada");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
  });

  const aprovar = useMutation({
    mutationFn: async () =>
      sisoFetch(`/api/wms/inventario/${id}/aprovar`, { method: "POST" }).then(
        async (r) => {
          if (!r.ok) {
            const e = (await r.json()) as { error?: string };
            throw new Error(e.error ?? "erro");
          }
          return r.json();
        },
      ),
    onSuccess: () => {
      toast.success("aprovada");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
    onError: (e) => toast.error(String(e)),
  });

  const aplicar = useMutation({
    mutationFn: async () =>
      sisoFetch(`/api/wms/inventario/${id}/aplicar`, { method: "POST" }).then(
        (r) => r.json() as Promise<{ movsGeradas: number }>,
      ),
    onSuccess: (r) => {
      toast.success(`${r.movsGeradas} movs geradas`);
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
  });

  const progresso = useMemo(() => {
    const total = locs.length;
    const concluidas = locs.filter(
      (l) => l.status === "contada" || l.status === "aprovada",
    ).length;
    return total > 0 ? concluidas / total : 0;
  }, [locs]);

  const totalContado = useMemo(
    () => contagens.reduce((s, c) => s + Number(c.qty_contada), 0),
    [contagens],
  );

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Inventário {id.slice(0, 8)}</h1>
        <span className="text-sm">
          status: <strong>{data?.sessao?.status}</strong>
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-sm">
        <div className="p-3 rounded border border-zinc-200 dark:border-zinc-800">
          <div className="text-zinc-500">progresso</div>
          <div className="text-2xl tabular-nums">
            {(progresso * 100).toFixed(1)}%
          </div>
        </div>
        <div className="p-3 rounded border border-zinc-200 dark:border-zinc-800">
          <div className="text-zinc-500">contagens registradas</div>
          <div className="text-2xl tabular-nums">{contagens.length}</div>
        </div>
        <div className="p-3 rounded border border-zinc-200 dark:border-zinc-800">
          <div className="text-zinc-500">total qty contada</div>
          <div className="text-2xl tabular-nums">
            {totalContado.toLocaleString("pt-BR")}
          </div>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {data?.sessao?.status === "planejada" && (
          <button
            onClick={() => iniciar.mutate()}
            className="px-3 py-1 rounded bg-zinc-900 text-white"
          >
            iniciar
          </button>
        )}
        {data?.sessao?.status === "em_andamento" && (
          <button
            onClick={() => aprovar.mutate()}
            className="px-3 py-1 rounded bg-zinc-900 text-white"
          >
            finalizar/aprovar
          </button>
        )}
        {data?.sessao?.status === "aprovada" && (
          <button
            onClick={() => aplicar.mutate()}
            className="px-3 py-1 rounded bg-green-700 text-white"
          >
            aplicar no estoque
          </button>
        )}
        <Link
          href={`/wms/inventario/${id}/contar`}
          className="px-3 py-1 rounded border"
        >
          tela do operador
        </Link>
        <Link
          href={`/wms/inventario/${id}/divergencias`}
          className="px-3 py-1 rounded border"
        >
          divergências
        </Link>
      </div>

      <details className="rounded border border-zinc-200 dark:border-zinc-800">
        <summary className="p-3 cursor-pointer">Áreas</summary>
        <div className="p-3 space-y-2">
          {data?.areas?.map((a) => (
            <div key={a.id} className="border-l-2 border-zinc-300 pl-3">
              <div className="font-medium">
                {a.nome}{" "}
                {a.operador?.nome && (
                  <span className="text-zinc-500 text-sm">— {a.operador.nome}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
