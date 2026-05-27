"use client";
import { use, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { wmsApi } from "@/lib/wms/api-client";
import {
  useInventarioRealtime,
  type Operador,
} from "@/hooks/use-inventario-realtime";
import {
  Icon,
  Modal,
  PageHeader,
  StatusBadge,
  Kpi,
} from "@/components/wms/ui/wms-ui";
import { useAuth, usePermissoes } from "@/lib/auth-context";
import { FeedEventos } from "@/components/wms/inventario/feed-eventos";
import { Avatar } from "@/components/wms/ui/avatar";
import { useTrackPresencaWms } from "@/hooks/use-presenca-wms";

interface SessaoData {
  sessao?: {
    status: string;
    tipo: string;
    modo_contagem: string;
    nome?: string;
    galpao?: { nome?: string };
    criado_em?: string;
    iniciada_em?: string;
    tamanho_pool?: number;
  } | null;
}

const STATUS_GUIDE: Record<
  string,
  { titulo: string; descricao: string; proximo: string }
> = {
  planejada: {
    titulo: "Sessão criada",
    descricao:
      "Aguardando o primeiro operador entrar na party. Quando o primeiro entrar, a sessão arranca automaticamente.",
    proximo: "Operadores entram pela tela handheld e puxam locs uma a uma.",
  },
  em_andamento: {
    titulo: "Contagem em andamento",
    descricao:
      "Operadores estão puxando localizações do pool. Acompanhe ao vivo. Quando o pool esvaziar, encerre pra computar divergências.",
    proximo: "Encerre a sessão quando todas as locs forem contadas.",
  },
  revisao: {
    titulo: "Em revisão",
    descricao:
      "Contagem encerrada. Divergências computadas. Abra a tela de divergências, resolva cada pendente (aprovar/rejeitar) e depois clique em 'Aprovar sessão'.",
    proximo:
      "1) Resolver pendentes em /divergencias · 2) Aprovar sessão · 3) Aplicar no estoque.",
  },
  aprovada: {
    titulo: "Sessão aprovada",
    descricao:
      "Pronto pra aplicar no estoque — vai gerar movimentações no ledger.",
    proximo: "Clique em 'Aplicar no estoque'.",
  },
  aplicada: {
    titulo: "Concluída",
    descricao: "Movimentações geradas. Sessão fechada.",
    proximo: "—",
  },
  cancelada: {
    titulo: "Cancelada",
    descricao: "Sessão cancelada — locks liberados.",
    proximo: "—",
  },
};

export default function InventarioSupervisorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { can } = usePermissoes();
  const podeSupervisar = can("inventario.supervisionar");
  const { contagens, locs, operadores } = useInventarioRealtime(id);

  // Anuncia presença no card "Inventário" do quadro de tarefas (/wms).
  useTrackPresencaWms("inventario");
  const [encerrarOpen, setEncerrarOpen] = useState(false);
  const [cancelarOpen, setCancelarOpen] = useState(false);
  const [estornarOpen, setEstornarOpen] = useState(false);
  const [estornarMotivo, setEstornarMotivo] = useState("");
  // Admin perm gates "Estornar sessão" (backend requires requireAdmin).
  const podeEstornar = can("sistema.usuarios");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["wms-inv", id],
    queryFn: () => wmsApi<SessaoData>(`/api/wms/inventario/${id}`),
  });

  // Divergências (só faz sentido buscar quando sessão está em revisao+)
  const divQuery = useQuery({
    queryKey: ["wms-inv-div", id],
    queryFn: () =>
      wmsApi<{ rows: Array<{ status: string }> }>(
        `/api/wms/inventario/${id}/divergencias`,
      ),
    enabled:
      data?.sessao?.status === "revisao" ||
      data?.sessao?.status === "aprovada" ||
      data?.sessao?.status === "aplicada",
  });
  const divStats = useMemo(() => {
    const rows = divQuery.data?.rows ?? [];
    return {
      total: rows.length,
      pendentes: rows.filter((d) => d.status === "pendente").length,
      aprovadas: rows.filter((d) => d.status === "aprovada").length,
      rejeitadas: rows.filter((d) => d.status === "rejeitada").length,
      aplicadas: rows.filter((d) => d.status === "aplicada").length,
    };
  }, [divQuery.data]);

  const iniciar = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>(`/api/wms/inventario/${id}/iniciar`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("Sessão iniciada — operadores já podem entrar");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const encerrar = useMutation({
    mutationFn: (parcial: boolean = false) =>
      wmsApi<{
        ok: true;
        parcial: boolean;
        status: "revisao" | "aprovada";
        divergencias: { total: number; pendentes: number; aprovadas: number };
      }>(`/api/wms/inventario/${id}/aprovar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parcial }),
      }),
    onSuccess: (r) => {
      setEncerrarOpen(false);
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
      queryClient.invalidateQueries({ queryKey: ["wms-inv-div", id] });
      if (r.status === "aprovada") {
        toast.success(
          `Contagem encerrada · ${r.divergencias.aprovadas} divergência(s) aprovada(s) dentro da tolerância · sessão aprovada`,
        );
      } else if (r.divergencias.pendentes > 0) {
        toast.warning(
          `${r.divergencias.pendentes} divergência(s) pendente(s) · revise antes de aprovar`,
        );
        router.push(`/wms/inventario/${id}/divergencias`);
      } else {
        toast.success("Contagem encerrada · sem divergências");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const aprovarSessao = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true; status: "aprovada" }>(
        `/api/wms/inventario/${id}/aprovar-sessao`,
        { method: "POST" },
      ),
    onSuccess: () => {
      toast.success("Sessão aprovada — pronto pra aplicar no estoque");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelar = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>(`/api/wms/inventario/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Sessão cancelada · locks liberados");
      setCancelarOpen(false);
      setEncerrarOpen(false);
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
      router.push("/wms/inventario");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const aplicar = useMutation({
    mutationFn: () =>
      wmsApi<{ movsGeradas: number }>(`/api/wms/inventario/${id}/aplicar`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      toast.success(`${r.movsGeradas} movimentações geradas no ledger`);
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const estornar = useMutation({
    mutationFn: (motivo: string) =>
      wmsApi<{ ok: true; movsEstornadas?: number }>(
        `/api/wms/inventario/${id}/estornar`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ motivo }),
        },
      ),
    onSuccess: (r) => {
      toast.success(
        r.movsEstornadas != null
          ? `Sessão estornada · ${r.movsEstornadas} mov(s) revertida(s)`
          : "Sessão estornada — voltou pra revisão",
      );
      setEstornarOpen(false);
      setEstornarMotivo("");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
      queryClient.invalidateQueries({ queryKey: ["wms-inv-div", id] });
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ─── KPIs derivados do realtime ───
  const stats = useMemo(() => {
    const total = locs.length;
    const contadas = locs.filter(
      (l) => l.status === "contada" || l.status === "aprovada",
    ).length;
    const emContagem = locs.filter((l) => l.status === "em_contagem").length;
    const pendentes = locs.filter((l) => l.status === "pendente").length;
    const divergentes = locs.filter((l) => l.status === "divergente").length;
    const pct = total > 0 ? Math.round((contadas / total) * 100) : 0;
    return { total, contadas, emContagem, pendentes, divergentes, pct };
  }, [locs]);

  // Velocidade média do galpão (locs/h)
  const velocidadeMedia = useMemo(() => {
    const ativos = operadores.filter((o) => o.finalizado_em === null);
    if (ativos.length === 0) return 0;
    const totalLocs = ativos.reduce((acc, o) => acc + o.locs_contadas, 0);
    const horas =
      ativos.reduce((acc, o) => {
        const ms = Date.now() - new Date(o.entrou_em).getTime();
        return acc + ms / 1000 / 3600;
      }, 0) / ativos.length;
    return horas > 0 ? Math.round(totalLocs / horas) : 0;
  }, [operadores]);

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
  const anyPending =
    iniciar.isPending ||
    encerrar.isPending ||
    aprovarSessao.isPending ||
    aplicar.isPending ||
    cancelar.isPending ||
    estornar.isPending;
  const guide = status ? STATUS_GUIDE[status] : undefined;
  const podeCancelar = status === "planejada" || status === "em_andamento";

  const meuOp = user
    ? operadores.find(
        (o) => o.usuario_id === user.id && o.finalizado_em === null,
      )
    : undefined;

  return (
    <>
      <PageHeader
        title={sessao?.nome ?? `Sessão ${id.slice(0, 8)}`}
        subtitle={
          sessao
            ? `${sessao.tipo === "cycle_count" ? "Cycle count" : "Inventário completo"} · modo ${sessao.modo_contagem} · ${sessao.galpao?.nome ?? "—"}`
            : undefined
        }
      >
        <StatusBadge status={status ?? "planejada"} size="lg" />
      </PageHeader>

      <div className="wms-kpis">
        <Kpi label="Pool total" value={stats.total} />
        <Kpi label="Contadas" value={`${stats.contadas} (${stats.pct}%)`} />
        <Kpi label="Em contagem" value={stats.emContagem} />
        <Kpi label="Pendentes" value={stats.pendentes} />
        <Kpi
          label="Divergências"
          value={
            divStats.total > 0
              ? `${divStats.pendentes}/${divStats.total}`
              : status === "em_andamento" || status === "planejada"
                ? "—"
                : "0"
          }
          danger={divStats.pendentes > 0}
        />
        <Kpi label="Velocidade média" value={`${velocidadeMedia} locs/h`} />
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
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{guide.titulo}</div>
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

      {/* Ações de supervisor */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 20,
        }}
      >
        {status === "planejada" && podeSupervisar && (
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            disabled={anyPending}
            onClick={() => iniciar.mutate()}
          >
            <Icon name="check" size={11} />
            {iniciar.isPending ? "Iniciando…" : "Iniciar sessão"}
          </button>
        )}
        {(status === "planejada" || status === "em_andamento") && (
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={() => router.push(`/wms/inventario/${id}/contar`)}
          >
            <Icon name="clipboard" size={11} />
            {meuOp ? "Continuar contando" : "Entrar na party"}
          </button>
        )}
        {status === "em_andamento" && podeSupervisar && (
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            disabled={anyPending}
            onClick={() => {
              if (stats.pendentes > 0) {
                setEncerrarOpen(true);
                return;
              }
              if (
                confirm(
                  "Encerrar a contagem? Todas as locs foram contadas. As divergências serão computadas.",
                )
              ) {
                encerrar.mutate(false);
              }
            }}
          >
            <Icon name="check" size={11} />
            {encerrar.isPending ? "Encerrando…" : "Encerrar contagem"}
          </button>
        )}
        {podeCancelar && podeSupervisar && (
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            disabled={anyPending}
            onClick={() => setCancelarOpen(true)}
          >
            <Icon name="x" size={11} />
            Cancelar sessão
          </button>
        )}
        {(status === "revisao" || status === "aprovada" || status === "aplicada") && (
          <Link
            href={`/wms/inventario/${id}/divergencias`}
            className={
              status === "revisao" && divStats.pendentes > 0
                ? "wms-btn wms-btn-primary"
                : "wms-btn wms-btn-ghost"
            }
          >
            <Icon name="alert" size={11} />
            {status === "aplicada"
              ? "Ver relatório"
              : status === "revisao" && divStats.pendentes > 0
                ? `Resolver ${divStats.pendentes} divergência(s)`
                : `Divergências (${divStats.total})`}
          </Link>
        )}
        {status === "revisao" && podeSupervisar && (
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            disabled={
              anyPending ||
              divStats.pendentes > 0 ||
              (divQuery.isLoading && divStats.total === 0)
            }
            title={
              divStats.pendentes > 0
                ? "Resolva todas as divergências pendentes antes de aprovar"
                : "Aprovar sessão (próximo: aplicar no estoque)"
            }
            onClick={() => {
              if (
                confirm(
                  `Aprovar a sessão? ${divStats.aprovadas} divergência(s) serão liberadas pra aplicação no estoque (gera movimentações no ledger).`,
                )
              ) {
                aprovarSessao.mutate();
              }
            }}
          >
            <Icon name="check" size={11} />
            {aprovarSessao.isPending ? "Aprovando…" : "Aprovar sessão"}
          </button>
        )}
        {status === "aprovada" && podeSupervisar && (
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            disabled={anyPending}
            onClick={() => aplicar.mutate()}
          >
            <Icon name="check" size={11} />
            {aplicar.isPending ? "Aplicando…" : "Aplicar no estoque"}
          </button>
        )}
        {status === "aplicada" && podeEstornar && (
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            disabled={anyPending}
            onClick={() => {
              setEstornarMotivo("");
              setEstornarOpen(true);
            }}
            title="Reverte as movs aplicadas e devolve a sessão pra revisão (admin only)"
          >
            <Icon name="rotate" size={11} />
            Estornar sessão
          </button>
        )}
      </div>

      {/* Na party — lista dinâmica de operadores ativos */}
      {(() => {
        const ativos = operadores.filter((o) => o.finalizado_em === null);
        return (
          <>
            <h3 className="wms-sec-h">
              Na party
              {ativos.length > 0 ? (
                <span
                  className="wms-td-mute"
                  style={{ marginLeft: 6, fontSize: 12, fontWeight: 400 }}
                >
                  · {ativos.length} operador
                  {ativos.length > 1 ? "es" : ""}
                </span>
              ) : null}
            </h3>
            {ativos.length === 0 ? (
              <div
                style={{
                  border: "1.5px dashed var(--wms-c-border)",
                  borderRadius: "var(--wms-r-3)",
                  padding: "32px 16px",
                  textAlign: "center",
                  marginBottom: 24,
                  color: "var(--wms-c-mute)",
                  fontStyle: "italic",
                  fontSize: 13,
                }}
              >
                Ninguém na party ainda. Aguardando o primeiro operador entrar.
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: 10,
                  marginBottom: 24,
                }}
              >
                {ativos.map((op) => (
                  <ParticipanteCard key={op.id} op={op} locs={locs} />
                ))}
              </div>
            )}
          </>
        );
      })()}

      {/* Painel ao vivo */}
      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">Painel ao vivo</h2>
        <FeedEventos sessaoId={id} />
      </section>

      {/* Últimos bipes */}
      {contagens.length > 0 && (
        <>
          <h3 className="wms-sec-h">Últimas contagens</h3>
          <div className="wms-tbl" style={{ maxHeight: 280, overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Operador</th>
                  <th>SKU</th>
                  <th className="wms-tar">Qty</th>
                </tr>
              </thead>
              <tbody>
                {contagens.slice(0, 50).map((c) => (
                  <tr key={c.id}>
                    <td className="wms-td-mute wms-mono" style={{ fontSize: 11.5 }}>
                      {new Date(c.criado_em).toLocaleTimeString("pt-BR")}
                    </td>
                    <td>{c.contada_por_user?.nome ?? "—"}</td>
                    <td className="wms-mono">{c.produto?.sku ?? "—"}</td>
                    <td className="wms-tar wms-mono">{c.qty_contada}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {encerrarOpen && (
        <Modal
          title="Encerrar contagem"
          subtitle={`Pool de ${stats.total} loc(s) — ${stats.contadas} contada(s), ${stats.pendentes} pendente(s)`}
          width={520}
          onClose={() => !anyPending && setEncerrarOpen(false)}
          footer={
            <>
              <button
                type="button"
                className="wms-btn wms-btn-ghost"
                disabled={anyPending}
                onClick={() => setEncerrarOpen(false)}
              >
                Voltar
              </button>
              <button
                type="button"
                className="wms-btn wms-btn-danger"
                disabled={anyPending}
                onClick={() => {
                  if (
                    confirm(
                      "Cancelar a sessão? Tudo que foi bipado será descartado. Não dá pra desfazer.",
                    )
                  ) {
                    cancelar.mutate();
                  }
                }}
              >
                <Icon name="x" size={11} />
                {cancelar.isPending ? "Cancelando…" : "Cancelar tudo"}
              </button>
              <button
                type="button"
                className="wms-btn wms-btn-primary"
                disabled={anyPending}
                onClick={() => encerrar.mutate(true)}
              >
                <Icon name="check" size={11} />
                {encerrar.isPending
                  ? "Enviando…"
                  : `Subir parcial (${stats.contadas})`}
              </button>
            </>
          }
        >
          <p style={{ fontSize: 13, marginBottom: 12 }}>
            Você ainda tem <strong>{stats.pendentes}</strong> localização(ões)
            sem terminar. Escolha o que fazer:
          </p>
          <ul
            style={{
              fontSize: 13,
              lineHeight: 1.6,
              paddingLeft: 18,
              marginBottom: 4,
            }}
          >
            <li>
              <strong>Subir parcial</strong> — só as {stats.contadas} loc(s)
              finalizada(s) viram divergência. As {stats.pendentes} pendente(s)
              ficam intocadas (estoque do sistema mantido).
            </li>
            <li>
              <strong>Cancelar tudo</strong> — sessão é cancelada, locks são
              liberados e nenhuma divergência é gerada.
            </li>
          </ul>
        </Modal>
      )}

      {estornarOpen && (
        <Modal
          title="Estornar sessão aplicada"
          subtitle={`${sessao?.nome ?? "Sessão"} · ${status}`}
          width={520}
          onClose={() => !anyPending && setEstornarOpen(false)}
          footer={
            <>
              <button
                type="button"
                className="wms-btn wms-btn-ghost"
                disabled={anyPending}
                onClick={() => setEstornarOpen(false)}
              >
                Voltar
              </button>
              <button
                type="button"
                className="wms-btn wms-btn-danger"
                disabled={anyPending || estornarMotivo.trim().length < 3}
                onClick={() => estornar.mutate(estornarMotivo.trim())}
              >
                <Icon name="rotate" size={11} />
                {estornar.isPending ? "Estornando…" : "Estornar"}
              </button>
            </>
          }
        >
          <p style={{ fontSize: 13, marginBottom: 10 }}>
            Reverte as movimentações aplicadas no ledger, recoloca as
            divergências em <strong>pendente</strong> e a sessão volta pra{" "}
            <strong>revisão</strong>. Não dá pra desfazer o estorno — só
            re-aprovando + re-aplicando.
          </p>
          <label
            style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}
          >
            Motivo do estorno (≥3 chars)
          </label>
          <textarea
            className="wms-textarea"
            value={estornarMotivo}
            onChange={(e) => setEstornarMotivo(e.target.value)}
            placeholder="Ex.: contagem aplicada com saldo errado, reaplicar após correção"
            rows={3}
            autoFocus
            disabled={anyPending}
          />
        </Modal>
      )}

      {cancelarOpen && (
        <Modal
          title="Cancelar sessão"
          subtitle={`${sessao?.nome ?? "Sessão"} · ${status}`}
          width={460}
          onClose={() => !anyPending && setCancelarOpen(false)}
          footer={
            <>
              <button
                type="button"
                className="wms-btn wms-btn-ghost"
                disabled={anyPending}
                onClick={() => setCancelarOpen(false)}
              >
                Voltar
              </button>
              <button
                type="button"
                className="wms-btn wms-btn-danger"
                disabled={anyPending}
                onClick={() => cancelar.mutate()}
              >
                <Icon name="x" size={11} />
                {cancelar.isPending ? "Cancelando…" : "Cancelar sessão"}
              </button>
            </>
          }
        >
          <p style={{ fontSize: 13 }}>
            A sessão será marcada como <strong>cancelada</strong>, os locks
            externos das {stats.total} loc(s) são liberados e nenhuma
            movimentação de estoque é gerada.
          </p>
          {stats.contadas > 0 || contagens.length > 0 ? (
            <p style={{ fontSize: 12.5, marginTop: 8 }} className="wms-td-mute">
              <Icon name="alert" size={11} /> Você já tem {stats.contadas}{" "}
              loc(s) contada(s) e {contagens.length} bipe(s) registrados — eles
              serão descartados.
            </p>
          ) : null}
        </Modal>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Card de participante — mostra estado ao vivo de um operador na party
// ─────────────────────────────────────────────────────────────────────

function ParticipanteCard({
  op,
  locs,
}: {
  op: Operador;
  locs: Array<{
    status: string;
    bloqueada_por: string | null;
    localizacao?: { codigo?: string };
  }>;
}) {
  const locAtual = locs.find(
    (l) => l.bloqueada_por === op.usuario_id && l.status === "em_contagem",
  );

  const horasAtivo = Math.max(
    0.001,
    (Date.now() - new Date(op.entrou_em).getTime()) / 3600000,
  );
  const velocidade =
    horasAtivo > 0 ? Math.round(op.locs_contadas / horasAtivo) : 0;

  // Render do claim ao vivo (rua / prédio / colisão + direção)
  const claimLabel = op.claim_tipo
    ? (() => {
        const arrow =
          op.claim_direcao === "desc" ? "↑" : op.claim_direcao === "asc" ? "↓" : "";
        if (op.claim_tipo === "rua") {
          return `rua ${op.claim_codigo ?? "?"} ${arrow}`.trim();
        }
        if (op.claim_tipo === "predio") {
          return `prédio ${op.claim_codigo ?? "?"} ${arrow}`.trim();
        }
        return `colisão ${op.claim_codigo ?? "?"} ${arrow}`.trim();
      })()
    : null;

  const reentradaLabel = op.ultima_reentrada_em
    ? `↻ voltou às ${new Date(op.ultima_reentrada_em).toLocaleTimeString(
        "pt-BR",
        { hour: "2-digit", minute: "2-digit" },
      )}`
    : null;

  return (
    <div
      style={{
        border: "1px solid var(--wms-c-border)",
        background: "var(--wms-c-faint)",
        borderRadius: "var(--wms-r-3)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minHeight: 130,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Avatar
            nome={op.usuario?.nome ?? "Operador"}
            fotoUrl={op.usuario?.foto_url ?? null}
            size="md"
            ring
          />
          <strong
            style={{
              fontSize: 13,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {op.usuario?.nome ?? "Operador"}
          </strong>
        </div>
        <span
          className="wms-mono wms-td-mute"
          style={{ fontSize: 11, fontFamily: "var(--wms-mono)" }}
        >
          {velocidade} locs/h
        </span>
      </div>
      <div className="wms-td-mute" style={{ fontSize: 11.5 }}>
        {op.locs_contadas} loc(s) contada(s)
      </div>
      {claimLabel && (
        <div
          className="wms-mono"
          style={{
            fontSize: 11,
            color:
              op.claim_tipo === "colisao"
                ? "var(--wms-c-warn)"
                : "var(--wms-c-accent)",
          }}
        >
          {claimLabel}
        </div>
      )}
      {locAtual?.localizacao?.codigo && (
        <div className="wms-mono wms-td-mute" style={{ fontSize: 10.5 }}>
          contando: {locAtual.localizacao.codigo}
        </div>
      )}
      {reentradaLabel && (
        <div className="wms-td-mute" style={{ fontSize: 10.5 }}>
          {reentradaLabel}
        </div>
      )}
    </div>
  );
}
