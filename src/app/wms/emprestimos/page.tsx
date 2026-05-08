"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
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
    queryFn: async () =>
      (await sisoFetch("/api/admin/galpoes")).json() as Promise<{
        galpoes?: GalpaoRow[];
      }>,
  });
  const empresas: EmpresaRow[] = (galpoes?.galpoes ?? []).flatMap(
    (g) => g.empresas ?? [],
  );

  const { data: regras } = useQuery({
    queryKey: ["wms-regras"],
    queryFn: async () =>
      (await sisoFetch("/api/wms/emprestimo-regras")).json() as Promise<{
        rows: EmprestimoRegra[];
      }>,
  });

  const { data: saldos } = useQuery({
    queryKey: ["wms-saldos-devedores"],
    queryFn: async () =>
      (await sisoFetch("/api/wms/emprestimos/saldos")).json() as Promise<{
        rows: SaldoDevedor[];
      }>,
  });

  const criar = useMutation({
    mutationFn: async () =>
      sisoFetch("/api/wms/emprestimo-regras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_credora_id: credora,
          empresa_devedora_id: devedora,
        }),
      }).then(async (r) => {
        if (!r.ok) {
          const e = (await r.json()) as { error?: string };
          throw new Error(e.error ?? "erro");
        }
        return r.json();
      }),
    onSuccess: () => {
      toast.success("regra criada");
      queryClient.invalidateQueries({ queryKey: ["wms-regras"] });
    },
    onError: (e) => toast.error(String(e)),
  });

  const empresaNome = (id: string) => empresas.find((e) => e.id === id)?.nome ?? id;

  return (
    <div className="space-y-4 max-w-4xl">
      <section>
        <h2 className="text-lg font-medium mb-2">Matriz de empréstimos</h2>
        <div className="flex gap-2 mb-3 items-center flex-wrap">
          <select
            value={credora}
            onChange={(e) => setCredora(e.target.value)}
            className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
          >
            <option value="">— credora —</option>
            {empresas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nome}
              </option>
            ))}
          </select>
          <span>→ empresta para →</span>
          <select
            value={devedora}
            onChange={(e) => setDevedora(e.target.value)}
            className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
          >
            <option value="">— devedora —</option>
            {empresas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nome}
              </option>
            ))}
          </select>
          <button
            onClick={() => criar.mutate()}
            disabled={!credora || !devedora || credora === devedora}
            className="px-3 py-1 rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-sm"
          >
            criar
          </button>
        </div>
        <div className="space-y-1">
          {regras?.rows.map((r) => (
            <RegraComLimite key={r.id} regra={r} empresaNome={empresaNome} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">Saldos devedores</h2>
        <p className="text-xs text-zinc-500 mb-2">
          Saldo líquido entre credora ↔ devedora por produto. Limites por par+produto
          editáveis em cada regra acima.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500">
              <th>credora</th>
              <th>devedora</th>
              <th>produto</th>
              <th className="text-right">saldo</th>
            </tr>
          </thead>
          <tbody>
            {saldos?.rows.map((s, i) => (
              <tr key={i} className="border-t border-zinc-200 dark:border-zinc-800">
                <td>{empresaNome(s.credora)}</td>
                <td>{empresaNome(s.devedora)}</td>
                <td className="font-mono text-xs">{s.produto_id}</td>
                <td className="text-right tabular-nums">
                  {Number(s.saldo_liquido).toLocaleString("pt-BR")}
                </td>
              </tr>
            ))}
            {saldos && saldos.rows.length === 0 && (
              <tr>
                <td colSpan={4} className="text-zinc-500 py-2">
                  sem saldos devedores
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
    mutationFn: async () =>
      sisoFetch(`/api/wms/emprestimo-regras/${regra.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limite_max_por_produto: limite === "" ? null : Number(limite),
        }),
      }).then((r) => r.json()),
    onSuccess: () => {
      toast.success("limite atualizado");
      setEditando(false);
      queryClient.invalidateQueries({ queryKey: ["wms-regras"] });
    },
  });

  return (
    <div className="text-sm p-2 rounded border border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
      <span className="flex-1">
        {empresaNome(regra.empresa_credora_id)} → {empresaNome(regra.empresa_devedora_id)}
      </span>
      {editando ? (
        <>
          <input
            type="number"
            value={limite}
            onChange={(e) => setLimite(e.target.value)}
            placeholder="qty máx por produto"
            className="w-32 px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-xs"
          />
          <button
            onClick={() => atualizar.mutate()}
            className="text-xs px-2 py-1 rounded bg-zinc-900 text-white"
          >
            salvar
          </button>
          <button
            onClick={() => setEditando(false)}
            className="text-xs px-2 py-1 rounded"
          >
            cancelar
          </button>
        </>
      ) : (
        <>
          <span className="text-xs text-zinc-500">
            limite global: {regra.limite_max_por_produto ?? "sem limite"}
          </span>
          <span className="text-xs text-zinc-500">
            limites por SKU: {Object.keys(regra.limites_por_produto ?? {}).length}
          </span>
          <button
            onClick={() => setEditando(true)}
            className="text-xs px-2 py-1 rounded border"
          >
            editar global
          </button>
        </>
      )}
    </div>
  );
}
