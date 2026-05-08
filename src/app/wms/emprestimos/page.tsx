"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";
import type { EmprestimoRegra, SaldoDevedor } from "@/lib/wms/emprestimos";

interface EmpresaRow {
  id: string;
  nome: string;
}

interface GalpaoRow {
  id: string;
  empresas?: EmpresaRow[];
}

export default function EmprestimosPage() {
  const queryClient = useQueryClient();
  const [credora, setCredora] = useState<string>("");
  const [devedora, setDevedora] = useState<string>("");

  const { data: galpoes } = useQuery({
    queryKey: ["galpoes"],
    queryFn: () =>
      wmsApi<{ galpoes?: GalpaoRow[] }>("/api/admin/galpoes"),
  });
  const empresas: EmpresaRow[] = (galpoes?.galpoes ?? []).flatMap(
    (g) => g.empresas ?? [],
  );

  const regrasQuery = useQuery({
    queryKey: ["wms-regras"],
    queryFn: () => wmsApi<{ rows: EmprestimoRegra[] }>("/api/wms/emprestimo-regras"),
  });

  const saldosQuery = useQuery({
    queryKey: ["wms-saldos-devedores"],
    queryFn: () => wmsApi<{ rows: SaldoDevedor[] }>("/api/wms/emprestimos/saldos"),
  });

  const criar = useMutation({
    mutationFn: () =>
      wmsApi<EmprestimoRegra>("/api/wms/emprestimo-regras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_credora_id: credora,
          empresa_devedora_id: devedora,
        }),
      }),
    onSuccess: () => {
      toast.success("Regra criada");
      setCredora("");
      setDevedora("");
      queryClient.invalidateQueries({ queryKey: ["wms-regras"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const empresaNome = (id: string) => empresas.find((e) => e.id === id)?.nome ?? id;

  const regras = regrasQuery.data?.rows ?? [];
  const saldos = saldosQuery.data?.rows ?? [];

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint">
          Matriz de empréstimos
        </h2>
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper p-3 text-sm">
          <select
            value={credora}
            onChange={(e) => setCredora(e.target.value)}
            className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
          >
            <option value="">— credora —</option>
            {empresas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nome}
              </option>
            ))}
          </select>
          <span className="text-ink-faint">→ empresta para →</span>
          <select
            value={devedora}
            onChange={(e) => setDevedora(e.target.value)}
            className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
          >
            <option value="">— devedora —</option>
            {empresas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nome}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => criar.mutate()}
            disabled={!credora || !devedora || credora === devedora || criar.isPending}
            className="btn-primary"
          >
            criar
          </button>
        </div>

        {regrasQuery.isLoading ? (
          <LoadingSpinner />
        ) : regrasQuery.isError ? (
          <ErrorBanner
            message={(regrasQuery.error as Error).message}
            onRetry={() => regrasQuery.refetch()}
          />
        ) : regras.length === 0 ? (
          <EmptyState message="Nenhuma regra de empréstimo cadastrada." />
        ) : (
          <div className="space-y-1">
            {regras.map((r) => (
              <RegraComLimite key={r.id} regra={r} empresaNome={empresaNome} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint">
          Saldos devedores
        </h2>
        <p className="text-xs text-ink-muted">
          Saldo líquido entre credora ↔ devedora por produto. Limites por par+produto
          editáveis em cada regra acima.
        </p>
        {saldosQuery.isLoading ? (
          <LoadingSpinner />
        ) : saldosQuery.isError ? (
          <ErrorBanner
            message={(saldosQuery.error as Error).message}
            onRetry={() => saldosQuery.refetch()}
          />
        ) : saldos.length === 0 ? (
          <EmptyState message="Sem saldos devedores no momento." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-paper">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-ink-faint">
                  <th className="p-2">credora</th>
                  <th>devedora</th>
                  <th>produto</th>
                  <th className="p-2 text-right">saldo</th>
                </tr>
              </thead>
              <tbody>
                {saldos.map((s, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="p-2 text-ink-muted">{empresaNome(s.credora)}</td>
                    <td className="text-ink-muted">{empresaNome(s.devedora)}</td>
                    <td className="font-mono text-xs text-ink">{s.produto_id}</td>
                    <td className="p-2 text-right tabular-nums text-ink">
                      {Number(s.saldo_liquido).toLocaleString("pt-BR")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function RegraComLimite({
  regra,
  empresaNome,
}: {
  regra: EmprestimoRegra;
  empresaNome: (id: string) => string;
}) {
  const queryClient = useQueryClient();
  const [editando, setEditando] = useState(false);
  const [limite, setLimite] = useState<string>(
    regra.limite_max_por_produto?.toString() ?? "",
  );

  const atualizar = useMutation({
    mutationFn: () =>
      wmsApi<EmprestimoRegra>(`/api/wms/emprestimo-regras/${regra.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limite_max_por_produto: limite === "" ? null : Number(limite),
        }),
      }),
    onSuccess: () => {
      toast.success("Limite atualizado");
      setEditando(false);
      queryClient.invalidateQueries({ queryKey: ["wms-regras"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper p-2.5 text-sm">
      <span className="flex-1 text-ink">
        {empresaNome(regra.empresa_credora_id)} → {empresaNome(regra.empresa_devedora_id)}
      </span>
      {editando ? (
        <>
          <input
            type="number"
            value={limite}
            onChange={(e) => setLimite(e.target.value)}
            placeholder="qty máx por produto"
            className="w-36 rounded-lg border border-line bg-paper px-2 py-1 text-xs text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
          />
          <button
            type="button"
            onClick={() => atualizar.mutate()}
            disabled={atualizar.isPending}
            className="btn-primary text-xs"
          >
            salvar
          </button>
          <button
            type="button"
            onClick={() => setEditando(false)}
            className="btn-ghost text-xs"
          >
            cancelar
          </button>
        </>
      ) : (
        <>
          <span className="text-xs text-ink-muted">
            limite global: {regra.limite_max_por_produto ?? "sem limite"}
          </span>
          <span className="text-xs text-ink-faint">
            limites por SKU: {Object.keys(regra.limites_por_produto ?? {}).length}
          </span>
          <button
            type="button"
            onClick={() => setEditando(true)}
            className="btn-ghost text-xs"
          >
            editar global
          </button>
        </>
      )}
    </div>
  );
}
