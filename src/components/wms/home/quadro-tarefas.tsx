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

function EmptyCard({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="wms-card-detalhe wms-card-detalhe-empty"
      aria-label={label}
    >
      <div className="wms-card-detalhe-empty-label">{label}</div>
    </Link>
  );
}

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

  const guardaTotal = data?.guarda.count ?? 0;
  const inventarioTotal = data?.inventario.sessoesAtivas ?? 0;

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

      <div className="wms-quadro-sub">
        Guarda
        {guardaTotal > 0
          ? ` · ${guardaTotal} pendência${guardaTotal === 1 ? "" : "s"}`
          : ""}
      </div>
      <div className="wms-quadro-kanban">
        {guardaTotal === 0 ? (
          <EmptyCard href="/wms/guarda" label="Nenhuma pendência de guarda" />
        ) : (
          <>
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
          </>
        )}
      </div>

      <div className="wms-quadro-sub">
        Inventário
        {inventarioTotal > 0
          ? ` · ${inventarioTotal} ciclo${inventarioTotal === 1 ? "" : "s"} ativo${inventarioTotal === 1 ? "" : "s"}`
          : ""}
      </div>
      <div className="wms-quadro-kanban">
        {inventarioTotal === 0 ? (
          <EmptyCard
            href="/wms/inventario"
            label="Nenhum ciclo de inventário em andamento"
          />
        ) : (
          data!.inventario.ciclos.map((c) => (
            <CardInventarioCiclo key={c.id} ciclo={c} />
          ))
        )}
      </div>

      <div className="wms-quadro-sub">
        Compras
        {data && (data.compras.aComprar > 0 || data.compras.aReceber > 0)
          ? ` · ${data.compras.aComprar} a comprar / ${data.compras.aReceber} a receber`
          : ""}
      </div>
      <div className="wms-quadro-kanban">
        {!data || data.compras.fornecedores.length === 0 ? (
          <EmptyCard
            href="/wms/compras"
            label="Nenhuma compra pendente"
          />
        ) : (
          data.compras.fornecedores.map((f) => (
            <CardComprasFornecedor key={f.fornecedor} fornecedor={f} />
          ))
        )}
      </div>
    </section>
  );
}
