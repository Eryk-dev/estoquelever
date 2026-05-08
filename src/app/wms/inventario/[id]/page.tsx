"use client";
import { use, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Link from "next/link";
import { wmsApi } from "@/lib/wms/api-client";
import { useInventarioRealtime } from "@/hooks/use-inventario-realtime";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ErrorBanner } from "@/components/ui/error-banner";

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

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["wms-inv", id],
    queryFn: () => wmsApi<SessaoData>(`/api/wms/inventario/${id}`),
  });

  const iniciar = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>(`/api/wms/inventario/${id}/iniciar`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("Sessão iniciada");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const aprovar = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>(`/api/wms/inventario/${id}/aprovar`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("Sessão aprovada");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const aplicar = useMutation({
    mutationFn: () =>
      wmsApi<{ movsGeradas: number }>(`/api/wms/inventario/${id}/aplicar`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      toast.success(`${r.movsGeradas} movs geradas`);
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
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

  if (isLoading) return <LoadingSpinner />;
  if (isError) {
    return (
      <ErrorBanner message={(error as Error).message} onRetry={() => refetch()} />
    );
  }

  const status = data?.sessao?.status;
  const anyMutationPending =
    iniciar.isPending || aprovar.isPending || aplicar.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs text-ink-faint">{id.slice(0, 8)}</span>
        <span className="text-sm text-ink-muted">
          status: <strong className="text-ink">{status ?? "—"}</strong>
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-sm">
        <Stat label="progresso" value={`${(progresso * 100).toFixed(1)}%`} />
        <Stat label="contagens registradas" value={contagens.length} />
        <Stat
          label="total qty contada"
          value={totalContado.toLocaleString("pt-BR")}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {status === "planejada" && (
          <button
            type="button"
            onClick={() => iniciar.mutate()}
            disabled={anyMutationPending}
            className="btn-primary"
          >
            iniciar
          </button>
        )}
        {status === "em_andamento" && (
          <button
            type="button"
            onClick={() => aprovar.mutate()}
            disabled={anyMutationPending}
            className="btn-primary"
          >
            finalizar/aprovar
          </button>
        )}
        {status === "aprovada" && (
          <button
            type="button"
            onClick={() => aplicar.mutate()}
            disabled={anyMutationPending}
            className="btn-primary"
          >
            aplicar no estoque
          </button>
        )}
        <Link
          href={`/wms/inventario/${id}/contar`}
          className="btn-ghost"
        >
          tela do operador
        </Link>
        <Link
          href={`/wms/inventario/${id}/divergencias`}
          className="btn-ghost"
        >
          divergências
        </Link>
      </div>

      <details className="rounded-xl border border-line bg-paper">
        <summary className="cursor-pointer p-3 text-sm font-medium text-ink">
          Áreas
        </summary>
        <div className="space-y-2 border-t border-line p-3">
          {(data?.areas ?? []).length === 0 ? (
            <p className="text-sm text-ink-faint">Nenhuma área configurada.</p>
          ) : (
            data?.areas?.map((a) => (
              <div key={a.id} className="border-l-2 border-line pl-3">
                <div className="font-medium text-ink">
                  {a.nome}{" "}
                  {a.operador?.nome && (
                    <span className="text-sm text-ink-muted">
                      — {a.operador.nome}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </details>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-line bg-paper p-3">
      <div className="text-xs text-ink-faint">{label}</div>
      <div className="text-2xl tabular-nums text-ink">{value}</div>
    </div>
  );
}
