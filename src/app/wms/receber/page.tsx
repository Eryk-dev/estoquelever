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
      <div className="px-4 pb-12 max-w-5xl mx-auto pt-4">
        <div className="wms-home-grid">
          <Link href="/wms/compras?tab=receber" className="wms-home-card">
            <div className="wms-home-card-icon">
              <Package size={18} />
            </div>
            <div>
              <div className="wms-home-card-title">Receber OC pendente</div>
              <div className="wms-home-card-desc">
                Caminhão de fornecedor chegou — entrega vinculada a uma ordem
                de compra
              </div>
            </div>
          </Link>

          <Link href="/wms/receber/transferencia" className="wms-home-card">
            <div className="wms-home-card-icon">
              <Truck size={18} />
            </div>
            <div>
              <div className="wms-home-card-title">Receber transferência</div>
              <div className="wms-home-card-desc">
                Veio de outro galpão — transferência inter-galpão em trânsito
              </div>
            </div>
          </Link>

          <Link href="/wms/receber/avulso" className="wms-home-card">
            <div className="wms-home-card-icon">
              <Hand size={18} />
            </div>
            <div>
              <div className="wms-home-card-title">Recebimento avulso</div>
              <div className="wms-home-card-desc">
                Achado, devolução de cliente, ajuste manual sem OC
              </div>
            </div>
          </Link>
        </div>
      </div>
    </>
  );
}
