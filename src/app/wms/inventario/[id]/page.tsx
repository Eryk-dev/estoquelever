"use client";
import { use, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

const STATUS_GUIDE: Record<
  string,
  { titulo: string; descricao: string; proximo: string }
> = {
  planejada: {
    titulo: "Sessão criada",
    descricao:
      "As localizações foram configuradas. Inicie pra criar os locks e começar a contar.",
    proximo: "Inicie e abra o handheld pra bipar produtos.",
  },
  em_andamento: {
    titulo: "Contagem em andamento",
    descricao:
      "Operador deve abrir o handheld, pegar uma localização e bipar produtos. Quando todas estiverem contadas, finalize a sessão.",
    proximo:
      "Use o handheld pra contar e 'Finalizar & aprovar' quando terminar.",
  },
  revisao: {
    titulo: "Em revisão",
    descricao:
      "Contagem finalizada. Há divergências entre saldo do sistema e contagem.",
    proximo: "Resolva as divergências (aprovar/recontar/rejeitar) e aprove.",
  },
  aprovada: {
    titulo: "Sessão aprovada",
    descricao:
      "Divergências aprovadas. Aplique no estoque pra gerar as movimentações no ledger.",
    proximo: "Clique em 'Aplicar no estoque'.",
  },
  aplicada: {
    titulo: "Concluída",
    descricao: "Movimentações geradas. Veja o relatório final.",
    proximo: "—",
  },
  cancelada: {
    titulo: "Cancelada",
    descricao: "Sessão cancelada — locks liberados.",
    proximo: "—",
  },
};

export default function InventarioDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
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

  const iniciarEContar = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>(`/api/wms/inventario/${id}/iniciar`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("Sessão iniciada");
      router.push(`/wms/inventario/${id}/contar`);
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

  // Agrega progresso por área usando area_id das localizações
  const areaStats = useMemo(() => {
    const m = new Map<
      string,
      { total: number; contadas: number; emContagem: number; divergentes: number }
    >();
    for (const l of locs) {
      const key = l.area_id ?? "_sem_area";
      const cur = m.get(key) ?? {
        total: 0,
        contadas: 0,
        emContagem: 0,
        divergentes: 0,
      };
      cur.total++;
      if (l.status === "contada" || l.status === "aprovada") cur.contadas++;
      if (l.status === "em_contagem") cur.emContagem++;
      if (l.status === "divergente") cur.divergentes++;
      m.set(key, cur);
    }
    return m;
  }, [locs]);

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
    iniciar.isPending ||
    iniciarEContar.isPending ||
    aprovar.isPending ||
    aplicar.isPending;
  const totalLocs = locs.length;
  const concluidas = Math.round(progresso * totalLocs);
  const pendentes = totalLocs - concluidas;
  const acuracidade =
    concluidas > 0
      ? Math.round((1 - divergentes / Math.max(concluidas, 1)) * 100)
      : 0;
  const guide = status ? STATUS_GUIDE[status] : undefined;

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

      {guide && (
        <div
          style={{
            background: "var(--wms-c-faint)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-3)",
            padding: "12px 14px",
            marginTop: 16,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {guide.titulo}
          </div>
          <div className="wms-td-mute" style={{ marginBottom: 6 }}>
            {guide.descricao}
          </div>
          {guide.proximo !== "—" && (
            <div style={{ fontSize: 12 }}>
              <strong>Próximo:</strong>{" "}
              <span className="wms-td-mute">{guide.proximo}</span>
            </div>
          )}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        {status === "planejada" && (
          <>
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              disabled={anyMutationPending}
              onClick={() => iniciarEContar.mutate()}
            >
              <Icon name="check" size={11} />
              {iniciarEContar.isPending
                ? "Iniciando…"
                : "Iniciar e abrir handheld"}
            </button>
            <button
              type="button"
              className="wms-btn wms-btn-ghost"
              disabled={anyMutationPending}
              onClick={() => iniciar.mutate()}
            >
              Só iniciar
            </button>
          </>
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
            (data?.areas ?? []).map((a) => {
              const stats = areaStats.get(a.id) ?? {
                total: 0,
                contadas: 0,
                emContagem: 0,
                divergentes: 0,
              };
              const pct =
                stats.total > 0
                  ? Math.round((stats.contadas / stats.total) * 100)
                  : 0;
              return (
                <div
                  key={a.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 0",
                    borderBottom: "1px solid var(--wms-c-border)",
                    fontSize: 13,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>
                      <strong>{a.nome}</strong>
                      {a.operador?.nome && (
                        <span className="wms-td-mute">
                          {" "}— {a.operador.nome}
                        </span>
                      )}
                    </div>
                    <div
                      className="wms-td-mute"
                      style={{ fontSize: 11, marginTop: 2 }}
                    >
                      {stats.total} loc(s) · {stats.contadas} contada(s)
                      {stats.emContagem > 0 &&
                        ` · ${stats.emContagem} em contagem`}
                      {stats.divergentes > 0 && (
                        <span className="wms-td-warn">
                          {" "}· {stats.divergentes} divergente(s)
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        marginTop: 6,
                        height: 4,
                        background: "var(--wms-c-border)",
                        borderRadius: 2,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${pct}%`,
                          height: "100%",
                          background:
                            pct === 100
                              ? "var(--wms-c-success, #16a34a)"
                              : "var(--wms-c-primary, #1f2937)",
                          transition: "width .2s",
                        }}
                      />
                    </div>
                  </div>
                  <div className="wms-mono" style={{ fontSize: 12, minWidth: 48, textAlign: "right" }}>
                    {pct}%
                  </div>
                  {status === "em_andamento" && (
                    <Link
                      href={`/wms/inventario/${id}/contar`}
                      className="wms-btn wms-btn-ghost wms-btn-sm"
                    >
                      Abrir
                    </Link>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
