"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { sisoFetch } from "@/lib/auth-context";
import { PageHeader, fmtRelative } from "@/components/wms/ui/wms-ui";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Truck } from "lucide-react";

interface TransferRow {
  id: string;
  criado_em: string;
  origem_nome: string | null;
  destino_nome: string | null;
  qty_pendente: number;
  skus_pendentes: number;
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
        title="Receber transferência"
        subtitle="Veio caminhão de outro galpão? Escolha a transferência em trânsito."
        backHref="/wms/receber"
        backLabel="Recebimento"
      />
      <div className="px-4 pb-12 max-w-3xl mx-auto pt-4">
        {isLoading && <LoadingSpinner message="Carregando transferências…" />}
        {!isLoading && trs.length === 0 && (
          <div className="wms-empty-block">
            <h3>Nenhuma transferência em trânsito</h3>
            <p>Nada com destino no seu galpão agora.</p>
            <Link href="/wms/receber" className="wms-btn wms-btn-ghost">
              Voltar ao recebimento
            </Link>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {trs.map((t) => (
            <Link
              key={t.id}
              href={`/wms/receber/transferencia/${t.id}`}
              className="wms-home-card"
            >
              <div className="wms-home-card-icon">
                <Truck size={18} />
              </div>
              <div>
                <div className="wms-home-card-title">
                  {t.origem_nome ?? "—"} → {t.destino_nome ?? "—"}
                </div>
                <div className="wms-home-card-desc">
                  {t.skus_pendentes} SKU{t.skus_pendentes === 1 ? "" : "s"} ·{" "}
                  {t.qty_pendente} un · {fmtRelative(t.criado_em)}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
