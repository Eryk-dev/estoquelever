"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { sisoFetch } from "@/lib/auth-context";
import { PageHeader } from "@/components/wms/ui/wms-ui";
import { Truck, ChevronRight } from "lucide-react";

interface TransferRow {
  id: string;
  criado_em: string;
  origem_nome: string | null;
  destino_nome: string | null;
  qty_pendente: number;
}

export default function ReceberTransferenciaListaPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["receber-transferencia-lista"],
    queryFn: async () => {
      const r = await sisoFetch("/api/wms/receber/transferencia/lista");
      return (await r.json()) as { transferencias: TransferRow[] };
    },
  });

  const trs = data?.transferencias ?? [];

  return (
    <>
      <PageHeader
        title="Receber Transferência"
        subtitle="Veio caminhão de outro galpão? Escolha a transferência em trânsito."
      />
      <div className="px-4 pb-12 max-w-3xl mx-auto pt-4">
        {isLoading && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Carregando…</p>
        )}
        {!isLoading && trs.length === 0 && (
          <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            Nenhuma transferência em trânsito com destino no seu galpão.
          </div>
        )}
        <div className="flex flex-col gap-3">
          {trs.map((t) => (
            <Link
              key={t.id}
              href={`/wms/receber/transferencia/${t.id}`}
              className="group flex items-center gap-4 rounded-2xl border border-sky-200 bg-white p-4 transition hover:border-sky-400 hover:shadow-sm dark:border-sky-900/50 dark:bg-zinc-900 dark:hover:border-sky-700"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                <Truck size={20} />
              </div>
              <div className="flex-1">
                <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                  {t.origem_nome ?? "—"} → {t.destino_nome ?? "—"}
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  Transferência {t.id.slice(0, 8)} ·{" "}
                  {t.qty_pendente} un. pendente(s)
                </div>
              </div>
              <ChevronRight
                size={20}
                className="text-zinc-400 transition group-hover:translate-x-1 group-hover:text-zinc-600 dark:text-zinc-600 dark:group-hover:text-zinc-300"
              />
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
