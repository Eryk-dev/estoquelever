"use client";

import Link from "next/link";
import { Package, Truck, Hand } from "lucide-react";
import { PageHeader } from "@/components/wms/ui/wms-ui";

/**
 * Hub /wms/receber (Decisão 28/05): porta única com 3 entradas de
 * recebimento — OC pendente, Transferência inter-galpão, Avulso (achado,
 * devolução cliente, ajuste manual). Cada card leva pra subpágina dedicada.
 *
 * Form de recebimento avulso preservado em /wms/receber/avulso.
 */
export default function ReceberHubPage() {
  return (
    <>
      <PageHeader
        title="Recebimento"
        subtitle="Como você está recebendo hoje?"
      />
      <div className="grid grid-cols-1 gap-4 px-4 pb-12 sm:grid-cols-2 lg:grid-cols-3 max-w-5xl mx-auto pt-4">
        <Link
          href="/wms/receber/oc"
          className="group flex flex-col items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-6 transition hover:border-emerald-300 hover:bg-emerald-100 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:hover:bg-emerald-950/50"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm">
            <Package size={24} />
          </div>
          <div>
            <h3 className="mb-1 text-lg font-semibold text-emerald-900 dark:text-emerald-100">
              Receber OC pendente
            </h3>
            <p className="text-sm text-emerald-800/80 dark:text-emerald-200/70">
              Caminhão de fornecedor chegou — entrega vinculada a uma ordem
              de compra
            </p>
          </div>
        </Link>

        <Link
          href="/wms/receber/transferencia"
          className="group flex flex-col items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 p-6 transition hover:border-sky-300 hover:bg-sky-100 dark:border-sky-900/50 dark:bg-sky-950/30 dark:hover:bg-sky-950/50"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-sky-600 text-white shadow-sm">
            <Truck size={24} />
          </div>
          <div>
            <h3 className="mb-1 text-lg font-semibold text-sky-900 dark:text-sky-100">
              Receber Transferência
            </h3>
            <p className="text-sm text-sky-800/80 dark:text-sky-200/70">
              Veio de outro galpão (transferência inter-galpão em trânsito)
            </p>
          </div>
        </Link>

        <Link
          href="/wms/receber/avulso"
          className="group flex flex-col items-start gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 p-6 transition hover:border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900/50 dark:hover:bg-zinc-900"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-700 text-white shadow-sm">
            <Hand size={24} />
          </div>
          <div>
            <h3 className="mb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Recebimento avulso
            </h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Achado, devolução de cliente, ajuste manual sem OC
            </p>
          </div>
        </Link>
      </div>
    </>
  );
}
