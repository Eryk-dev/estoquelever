"use client";
import { Icon, PageHeader } from "@/components/wms/ui/wms-ui";
import { useWmsModals } from "@/components/wms/wms-shell";
import { QuadroTarefas } from "@/components/wms/home/quadro-tarefas";

export default function WmsHome() {
  const modals = useWmsModals();

  return (
    <>
      <PageHeader
        title="WMS"
        subtitle="Operações de estoque · 3D (produto × galpão × localização)"
      >
        <button
          className="wms-btn wms-btn-ghost"
          onClick={() => modals.open("ajuste")}
        >
          <Icon name="sliders" size={12} />
          Ajustar
        </button>
        <button
          className="wms-btn wms-btn-primary"
          onClick={() => modals.open("receber")}
        >
          <Icon name="plus" size={12} />
          Receber mercadoria
        </button>
      </PageHeader>

      <QuadroTarefas />
    </>
  );
}
