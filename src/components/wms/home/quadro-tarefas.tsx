// src/components/wms/home/quadro-tarefas.tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import type { DashboardTarefasResult } from "@/lib/wms/dashboard-tarefas";
import { useDashboardTarefasRealtime } from "@/hooks/use-dashboard-tarefas-realtime";
import { CardTarefa } from "./card-tarefa";

export function QuadroTarefas() {
  const { activeGalpaoId, activeGalpaoNome } = useAuth();
  const galpaoLabel = activeGalpaoNome ?? "Todos os galpões";

  const query = useQuery<DashboardTarefasResult>({
    queryKey: ["wms-tarefas-pendentes", activeGalpaoId],
    queryFn: () =>
      wmsApi<DashboardTarefasResult>(
        activeGalpaoId
          ? `/api/wms/dashboard-tarefas?galpao_id=${activeGalpaoId}`
          : `/api/wms/dashboard-tarefas`,
      ),
  });

  useDashboardTarefasRealtime(activeGalpaoId ?? null);

  const data = query.data;

  return (
    <section className="wms-quadro">
      <div className="wms-quadro-head">
        <h2 className="wms-quadro-title">Tarefas pendentes</h2>
        <div className="wms-quadro-meta">
          <span>galpão: {galpaoLabel}</span>
          <span className="wms-quadro-live">● ao vivo</span>
        </div>
      </div>

      {query.isError ? (
        <div className="wms-quadro-error">
          Não foi possível carregar o quadro.{" "}
          <button onClick={() => query.refetch()}>Tentar novamente</button>
        </div>
      ) : null}

      <div className="wms-quadro-sub">Pipeline do pedido</div>
      <div className="wms-quadro-row">
        <CardTarefa
          variante="simples"
          titulo="Aprovação"
          contador={data?.aprovacao.count ?? 0}
          legenda="aguardando"
          href="/wms/pedidos"
        />
        <CardTarefa
          variante="simples"
          titulo="Separação"
          contador={data?.separacao.count ?? 0}
          executores={data?.separacao.executores}
          href="/wms/separacao"
        />
        <CardTarefa
          variante="simples"
          titulo="Embalagem"
          contador={data?.embalagem.count ?? 0}
          executores={data?.embalagem.executores}
          href="/wms/separacao"
        />
      </div>

      <div className="wms-quadro-sub">Tarefas adjacentes</div>
      <div className="wms-quadro-row">
        <CardTarefa
          variante="simples"
          titulo="Guarda"
          contador={data?.guarda.count ?? 0}
          executores={data?.guarda.executores}
          href="/wms/guarda"
        />
        <CardTarefa
          variante="dupla"
          titulo="Compras"
          contadores={[
            data?.compras.aComprar ?? 0,
            data?.compras.aReceber ?? 0,
          ]}
          legendas={["a comprar", "a receber"]}
          href="/wms/compras"
        />
        <CardTarefa
          variante="simples"
          titulo="Inventário"
          contador={data?.inventario.sessoesAtivas ?? 0}
          legenda="sessões ativas"
          executores={data?.inventario.executores}
          href="/wms/inventario"
        />
      </div>
    </section>
  );
}
