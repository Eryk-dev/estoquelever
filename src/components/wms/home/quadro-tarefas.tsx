// src/components/wms/home/quadro-tarefas.tsx
"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import type { DashboardTarefasResult } from "@/lib/wms/dashboard-tarefas";
import { useDashboardTarefasRealtime } from "@/hooks/use-dashboard-tarefas-realtime";
import { CardTarefa } from "./card-tarefa";
import {
  CardComprasFornecedor,
  CardGuardaItem,
  CardInventarioCiclo,
} from "./cards-detalhe";

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

  const pipelineTotal =
    (data?.aprovacao.count ?? 0) +
    (data?.separacao.count ?? 0) +
    (data?.embalagem.count ?? 0);
  const guardaTotal = data?.guarda.count ?? 0;
  const inventarioTotal = data?.inventario.sessoesAtivas ?? 0;
  const comprasTotal =
    (data?.compras.aComprar ?? 0) + (data?.compras.aReceber ?? 0);

  const totalGeral =
    pipelineTotal + guardaTotal + inventarioTotal + comprasTotal;

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

      {!query.isLoading && totalGeral === 0 ? (
        <div className="wms-quadro-vazio">
          Nenhuma tarefa pendente no momento. Tudo em dia.
        </div>
      ) : null}

      {pipelineTotal > 0 ? (
        <>
          <div className="wms-quadro-sub">Pipeline do pedido</div>
          <div className="wms-quadro-row">
            {(data?.aprovacao.count ?? 0) > 0 ? (
              <CardTarefa
                variante="simples"
                titulo="Aprovação"
                contador={data!.aprovacao.count}
                legenda="aguardando"
                href="/wms/pedidos"
              />
            ) : null}
            {(data?.separacao.count ?? 0) > 0 ? (
              <CardTarefa
                variante="simples"
                titulo="Separação"
                contador={data!.separacao.count}
                executores={data!.separacao.executores}
                href="/wms/separacao"
              />
            ) : null}
            {(data?.embalagem.count ?? 0) > 0 ? (
              <CardTarefa
                variante="simples"
                titulo="Embalagem"
                contador={data!.embalagem.count}
                executores={data!.embalagem.executores}
                href="/wms/separacao"
              />
            ) : null}
          </div>
        </>
      ) : null}

      {guardaTotal > 0 ? (
        <>
          <div className="wms-quadro-sub">
            Guarda · {guardaTotal} pendência{guardaTotal === 1 ? "" : "s"}
          </div>
          <div className="wms-quadro-kanban">
            {data!.guarda.itens.map((it) => (
              <CardGuardaItem key={it.id} item={it} />
            ))}
            {data!.guarda.itens.length < guardaTotal ? (
              <Link
                href="/wms/guarda"
                className="wms-card-detalhe wms-card-detalhe-more"
              >
                +{guardaTotal - data!.guarda.itens.length} pendência
                {guardaTotal - data!.guarda.itens.length === 1 ? "" : "s"} ·
                ver todas
              </Link>
            ) : null}
          </div>
        </>
      ) : null}

      {inventarioTotal > 0 ? (
        <>
          <div className="wms-quadro-sub">
            Inventário · {inventarioTotal} ciclo
            {inventarioTotal === 1 ? "" : "s"} ativo
            {inventarioTotal === 1 ? "" : "s"}
          </div>
          <div className="wms-quadro-kanban">
            {data!.inventario.ciclos.map((c) => (
              <CardInventarioCiclo key={c.id} ciclo={c} />
            ))}
          </div>
        </>
      ) : null}

      {comprasTotal > 0 ? (
        <>
          <div className="wms-quadro-sub">
            Compras · {data!.compras.aComprar} a comprar /{" "}
            {data!.compras.aReceber} a receber
          </div>
          <div className="wms-quadro-kanban">
            {data!.compras.fornecedores.map((f) => (
              <CardComprasFornecedor
                key={f.fornecedor}
                fornecedor={f}
              />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
