"use client";
import { use, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Link from "next/link";
import { wmsApi } from "@/lib/wms/api-client";
import { useInventarioRealtime } from "@/hooks/use-inventario-realtime";
import {
  Icon,
  PageHeader,
  StatusBadge,
  Kpi,
} from "@/components/wms/ui/wms-ui";

interface SessaoData {
  sessao?: {
    status: string;
    tipo: string;
    modo_contagem: string;
    nome?: string;
    criado_em?: string;
  } | null;
  areas?: Array<{ id: string; nome: string; operador?: { nome?: string } }>;
}

export default function InventarioDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const { contagens, locs } = useInventarioRealtime(id);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["wms-inv", id],
    queryFn: () => wmsApi<SessaoData>(`/api/wms/inventario/${id}`),
  });

  const iniciar = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>(`/api/wms/inventario/${id}/iniciar`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("Sessão iniciada");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const aprovar = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>(`/api/wms/inventario/${id}/aprovar`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("Sessão aprovada");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const aplicar = useMutation({
    mutationFn: () =>
      wmsApi<{ movsGeradas: number }>(`/api/wms/inventario/${id}/aplicar`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      toast.success(`${r.movsGeradas} movs geradas`);
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const progresso = useMemo(() => {
    const total = locs.length;
    const concluidas = locs.filter(
      (l) => l.status === "contada" || l.status === "aprovada",
    ).length;
    return total > 0 ? concluidas / total : 0;
  }, [locs]);

  const divergentes = useMemo(
    () => locs.filter((l) => l.status === "divergente").length,
    [locs],
  );

  if (isLoading) {
    return <div className="wms-loading-pane">Carregando sessão…</div>;
  }
  if (isError) {
    return (
      <div className="wms-empty-block">
        <h3>Erro ao carregar</h3>
        <p>{(error as Error).message}</p>
      </div>
    );
  }

  const sessao = data?.sessao;
  const status = sessao?.status;
  const anyMutationPending =
    iniciar.isPending || aprovar.isPending || aplicar.isPending;
  const totalLocs = locs.length;
  const concluidas = Math.round(progresso * totalLocs);
  const pendentes = totalLocs - concluidas;
  const acuracidade =
    concluidas > 0
      ? Math.round((1 - divergentes / Math.max(concluidas, 1)) * 100)
      : 0;

  return (
    <>
      <PageHeader
        title={sessao?.nome ?? `Sessão ${id.slice(0, 8)}`}
        subtitle={
          sessao
            ? `${sessao.tipo === "cycle_count" ? "Cycle count" : "Completo"} · modo ${sessao.modo_contagem}`
            : undefined
        }
      >
        <StatusBadge status={status ?? "planejada"} size="lg" />
      </PageHeader>

      <div className="wms-kpis">
        <Kpi label="Pendentes" value={pendentes} />
        <Kpi label="Concluídas" value={concluidas} />
        <Kpi
          label="Divergentes"
          value={divergentes}
          danger={divergentes > 0}
        />
        <Kpi label="Acuracidade" value={`${acuracidade}%`} />
        <Kpi label="Contagens registradas" value={contagens.length} />
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginTop: 16,
          marginBottom: 16,
        }}
      >
        {status === "planejada" && (
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            disabled={anyMutationPending}
            onClick={() => iniciar.mutate()}
          >
            <Icon name="check" size={11} />
            Iniciar sessão
          </button>
        )}
        {status === "em_andamento" && (
          <>
            <Link
              href={`/wms/inventario/${id}/contar`}
              className="wms-btn wms-btn-ghost"
            >
              <Icon name="clipboard" size={11} />
              Abrir handheld
            </Link>
            <Link
              href={`/wms/inventario/${id}/divergencias`}
              className="wms-btn wms-btn-ghost"
            >
              <Icon name="alert" size={11} />
              Ver divergências
            </Link>
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              disabled={anyMutationPending}
              onClick={() => aprovar.mutate()}
            >
              <Icon name="check" size={11} />
              Finalizar & aprovar
            </button>
          </>
        )}
        {status === "aprovada" && (
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            disabled={anyMutationPending}
            onClick={() => aplicar.mutate()}
          >
            <Icon name="check" size={11} />
            Aplicar no estoque
          </button>
        )}
        {status === "aplicada" && (
          <Link
            href={`/wms/inventario/${id}/divergencias`}
            className="wms-btn wms-btn-ghost"
          >
            Ver relatório
          </Link>
        )}
      </div>

      <div className="wms-card">
        <div className="wms-card-h">
          <h3>Áreas</h3>
          <span className="wms-td-mute" style={{ fontSize: 12 }}>
            {(data?.areas ?? []).length} configurada(s)
          </span>
        </div>
        <div className="wms-card-body">
          {(data?.areas ?? []).length === 0 ? (
            <div className="wms-exp-empty">Nenhuma área configurada.</div>
          ) : (
            (data?.areas ?? []).map((a) => (
              <div
                key={a.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px 0",
                  borderBottom: "1px solid var(--wms-c-border)",
                  fontSize: 13,
                }}
              >
                <div>
                  <strong>{a.nome}</strong>
                  {a.operador?.nome && (
                    <span className="wms-td-mute"> — {a.operador.nome}</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
