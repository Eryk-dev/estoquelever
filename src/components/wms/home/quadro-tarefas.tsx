// src/components/wms/home/quadro-tarefas.tsx
"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import type { DashboardTarefasResult } from "@/lib/wms/dashboard-tarefas";
import { useDashboardTarefasRealtime } from "@/hooks/use-dashboard-tarefas-realtime";
import {
  useEstadoPresencaWms,
  type EstadoPresencaWms,
  type FuncaoPresenca,
} from "@/hooks/use-presenca-wms";
import type { Executor } from "@/lib/wms/dashboard-tarefas";
import { CardTarefa } from "./card-tarefa";
import {
  CardComprasFornecedor,
  CardGuardaItem,
  CardInventarioCiclo,
} from "./cards-detalhe";
import {
  SecaoExcecoes,
  SecaoExcecoesSkeleton,
} from "./exceptions/secao-excecoes";

function EmptyCard({ href, label }: { href: string; label: string }) {
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

/**
 * Intersecta a lista de executores (dono persistido em `siso_pedidos` etc.)
 * com o set de presença ao vivo. Avatar só aparece se o operador estiver
 * realmente com a aba aberta na função correspondente.
 */
function filtrarPresentes(
  executores: Executor[] | undefined,
  presenca: EstadoPresencaWms,
  funcao: FuncaoPresenca,
): Executor[] {
  if (!executores || executores.length === 0) return [];
  const set = presenca[funcao];
  return executores.filter((e) => set.has(e.id));
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
    // staleTime=0 + refetchInterval 30s: realtime hook invalida sob demanda;
    // o intervalo é apenas safety net caso a publication falhe (P5 §6).
    staleTime: 0,
    refetchInterval: 30_000,
  });

  useDashboardTarefasRealtime(activeGalpaoId ?? null);
  const presenca = useEstadoPresencaWms();

  const data = query.data;

  const guardaTotal = data?.guarda.count ?? 0;
  const inventarioTotal = data?.inventario.sessoesAtivas ?? 0;
  const comprasComprar = data?.compras.aComprar ?? 0;
  const comprasReceber = data?.compras.aReceber ?? 0;

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
          legenda="transferências"
          legendaExtra={
            data?.aprovacao
              ? `${data.aprovacao.marketplace} marketplace · ${data.aprovacao.manual} manual`
              : undefined
          }
          href="/wms/pedidos"
        />
        <CardTarefa
          variante="simples"
          titulo="Separação"
          contador={data?.separacao.count ?? 0}
          executores={filtrarPresentes(
            data?.separacao.executores,
            presenca,
            "separacao",
          )}
          href="/wms/separacao"
        />
        <CardTarefa
          variante="simples"
          titulo="Embalagem"
          contador={data?.embalagem.count ?? 0}
          executores={filtrarPresentes(
            data?.embalagem.executores,
            presenca,
            "embalagem",
          )}
          href="/wms/separacao"
        />
      </div>

      <div className="wms-kanban-board">
        <div className="wms-kanban-coluna">
          <div className="wms-kanban-coluna-head">
            <span className="wms-kanban-coluna-titulo">Guarda</span>
            <span className="wms-kanban-coluna-count">{guardaTotal}</span>
          </div>
          <div className="wms-kanban-coluna-cards">
            {guardaTotal === 0 ? (
              <EmptyCard
                href="/wms/guarda"
                label="Nenhuma pendência de guarda"
              />
            ) : (
              <>
                {data!.guarda.itens.map((it) => (
                  <CardGuardaItem
                    key={it.id}
                    item={
                      it.iniciada_por &&
                      !presenca.guarda.has(it.iniciada_por.id)
                        ? { ...it, iniciada_por: null }
                        : it
                    }
                  />
                ))}
                {data!.guarda.itens.length < guardaTotal ? (
                  <Link
                    href="/wms/guarda"
                    className="wms-card-detalhe wms-card-detalhe-more"
                  >
                    +{guardaTotal - data!.guarda.itens.length} pendência
                    {guardaTotal - data!.guarda.itens.length === 1 ? "" : "s"}{" "}
                    · ver todas
                  </Link>
                ) : null}
              </>
            )}
          </div>
        </div>

        <div className="wms-kanban-coluna">
          <div className="wms-kanban-coluna-head">
            <span className="wms-kanban-coluna-titulo">Inventário</span>
            <span className="wms-kanban-coluna-count">{inventarioTotal}</span>
          </div>
          <div className="wms-kanban-coluna-cards">
            {inventarioTotal === 0 ? (
              <EmptyCard
                href="/wms/inventario"
                label="Nenhum ciclo em andamento"
              />
            ) : (
              data!.inventario.ciclos.map((c) => (
                <CardInventarioCiclo
                  key={c.id}
                  ciclo={{
                    ...c,
                    operadores: c.operadores.filter((o) =>
                      presenca.inventario.has(o.id),
                    ),
                  }}
                />
              ))
            )}
          </div>
        </div>

        <div className="wms-kanban-coluna">
          <div className="wms-kanban-coluna-head">
            <span className="wms-kanban-coluna-titulo">Compras</span>
            <span className="wms-kanban-coluna-count">
              {comprasComprar} / {comprasReceber}
            </span>
          </div>
          <div className="wms-kanban-coluna-cards">
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
        </div>
      </div>

      {query.isLoading && !data ? (
        <SecaoExcecoesSkeleton />
      ) : data?.excecoes ? (
        <SecaoExcecoes excecoes={data.excecoes} />
      ) : null}
    </section>
  );
}
