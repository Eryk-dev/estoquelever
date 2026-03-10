"use client";

import { ScanInput } from "./scan-input";
import { PedidoSeparacaoCard, type PedidoSeparacao } from "./pedido-separacao-card";
import { EmptyState } from "@/components/ui/empty-state";

interface TabPendentesProps {
  pedidos: PedidoSeparacao[];
  onBipProcessed: () => void;
}

export function TabPendentes({ pedidos, onBipProcessed }: TabPendentesProps) {
  if (pedidos.length === 0) {
    return <EmptyState message="Nenhum pedido pendente de separação" />;
  }

  return (
    <div className="space-y-4">
      <ScanInput onBipProcessed={onBipProcessed} />
      {pedidos.map((pedido) => (
        <PedidoSeparacaoCard key={pedido.id} pedido={pedido} />
      ))}
    </div>
  );
}
