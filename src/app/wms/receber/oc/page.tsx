"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { sisoFetch, useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/wms/ui/wms-ui";
import { Package, ChevronRight } from "lucide-react";

interface OCRow {
  id: string;
  fornecedor: string | null;
  galpao_id: string;
  galpao_nome: string | null;
  qty_pendente: number;
  criado_em: string;
}

export default function ReceberOCListaPage() {
  const { activeGalpaoId } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["receber-oc-lista", activeGalpaoId],
    queryFn: async () => {
      const url = activeGalpaoId
        ? `/api/wms/receber/oc/lista?galpao_id=${activeGalpaoId}`
        : "/api/wms/receber/oc/lista";
      const r = await sisoFetch(url);
      return (await r.json()) as { ocs: OCRow[] };
    },
  });

  const ocs = data?.ocs ?? [];

  return (
    <>
      <PageHeader
        title="Receber OC pendente"
        subtitle="Caminhão chegou? Escolha a ordem de compra que está sendo entregue."
      />
      <div className="px-4 pb-12 max-w-3xl mx-auto pt-4">
        {isLoading && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Carregando…</p>
        )}
        {!isLoading && ocs.length === 0 && (
          <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            Nenhuma OC pendente de recebimento no momento.
          </div>
        )}
        <div className="flex flex-col gap-3">
          {ocs.map((oc) => (
            <Link
              key={oc.id}
              href={`/wms/receber/oc/${oc.id}`}
              className="group flex items-center gap-4 rounded-2xl border border-emerald-200 bg-white p-4 transition hover:border-emerald-400 hover:shadow-sm dark:border-emerald-900/50 dark:bg-zinc-900 dark:hover:border-emerald-700"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                <Package size={20} />
              </div>
              <div className="flex-1">
                <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                  {oc.fornecedor || "Fornecedor —"}
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  OC {oc.id.slice(0, 8)} · {oc.galpao_nome ?? "—"} ·{" "}
                  {oc.qty_pendente} un. pendente(s)
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
