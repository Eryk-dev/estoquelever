"use client";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Link from "next/link";
import { wmsApi } from "@/lib/wms/api-client";
import { useGalpoes, useLocalizacoes } from "@/components/wms/ui/modals";
import {
  Icon,
  Modal,
  PageHeader,
  StatusBadge,
  Field,
  fmtNum,
} from "@/components/wms/ui/wms-ui";
import type { SugestaoLoc, MotivoLoc, ModoContagem, TipoSessao } from "@/lib/wms/inventario";

interface SessaoRow {
  id: string;
  tipo: string;
  status: string;
  modo_contagem?: string;
  galpao?: { nome?: string };
  criado_em?: string;
  nome?: string;
  tamanho_pool?: number;
}

type TipoCriacao = "inteligente" | "manual" | "completo";

const MOTIVO_LABEL: Record<MotivoLoc, string> = {
  curva_a: "Curva A",
  divergente_recente: "Divergente recente",
  sem_contagem_recente: "Sem contagem 30d+",
  manual: "Manual",
  completo: "Completo",
};

export default function InventarioListaPage() {
  const queryClient = useQueryClient();
  const [openTipo, setOpenTipo] = useState<TipoCriacao | null>(null);

  const sessoesQuery = useQuery({
    queryKey: ["wms-inv-sessoes"],
    queryFn: () => wmsApi<{ rows: SessaoRow[] }>("/api/wms/inventario"),
  });

  const rows = sessoesQuery.data?.rows ?? [];

  return (
    <>
      <PageHeader
        title="Inventários"
        subtitle="Pool compartilhado · 5 slots de operador · sugestão inteligente"
      >
        <Link href="/wms/inventario/metricas" className="wms-btn wms-btn-ghost">
          <Icon name="gauge" size={12} />
          Métricas
        </Link>
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          onClick={() => setOpenTipo("inteligente")}
        >
          <Icon name="plus" size={12} />
          Nova sessão
        </button>
      </PageHeader>

      {sessoesQuery.isLoading && (
        <div className="wms-loading-pane">Carregando sessões…</div>
      )}
      {sessoesQuery.isError && (
        <div className="wms-empty-block">
          <h3>Erro</h3>
          <p>{(sessoesQuery.error as Error).message}</p>
        </div>
      )}
      {!sessoesQuery.isLoading && rows.length === 0 && (
        <div className="wms-empty-block">
          <h3>Nenhuma sessão criada</h3>
          <p>
            Inicie um cycle count ou inventário completo para começar. A
            sugestão inteligente já chega com proposta pronta.
          </p>
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            onClick={() => setOpenTipo("inteligente")}
          >
            <Icon name="plus" size={11} />
            Nova sessão
          </button>
        </div>
      )}
      {rows.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th>Sessão</th>
                <th>Tipo</th>
                <th>Modo</th>
                <th>Galpão</th>
                <th className="wms-tar">Pool</th>
                <th>Status</th>
                <th style={{ width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="wms-tr-clickable">
                  <td>
                    <Link
                      href={`/wms/inventario/${s.id}`}
                      className="wms-link-row"
                    >
                      {s.nome ?? (
                        <span className="wms-mono">{s.id.slice(0, 8)}</span>
                      )}
                    </Link>
                  </td>
                  <td className="wms-td-mute">
                    {s.tipo === "cycle_count" ? "Cycle count" : "Completo"}
                  </td>
                  <td className="wms-td-mute">{s.modo_contagem ?? "—"}</td>
                  <td className="wms-td-mute">{s.galpao?.nome ?? "—"}</td>
                  <td className="wms-tar wms-mono wms-td-mute">
                    {s.tamanho_pool ?? "—"}
                  </td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="wms-td-actions">
                    <Link
                      href={`/wms/inventario/${s.id}`}
                      className="wms-btn-icon"
                    >
                      <Icon name="chevron-r" size={11} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openTipo && (
        <NovaSessaoModal
          tipoInicial={openTipo}
          onClose={() => setOpenTipo(null)}
          onCreated={() => {
            setOpenTipo(null);
            queryClient.invalidateQueries({ queryKey: ["wms-inv-sessoes"] });
          }}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Modal de criação — 3 tipos: inteligente / manual / completo
// ─────────────────────────────────────────────────────────────────────

function NovaSessaoModal({
  tipoInicial,
  onClose,
  onCreated,
}: {
  tipoInicial: TipoCriacao;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [tipoCriacao, setTipoCriacao] = useState<TipoCriacao>(tipoInicial);
  const [nome, setNome] = useState("");
  const [galpaoId, setGalpaoId] = useState("");
  const [empresaDonaId, setEmpresaDonaId] = useState("");
  const [modo, setModo] = useState<ModoContagem>("blind");
  const [toleranciaPct, setToleranciaPct] = useState(2);
  const [exigeAprovacaoValor, setExigeAprovacaoValor] = useState(1000);
  const [tamanhoPool, setTamanhoPool] = useState(30);
  const [sugestao, setSugestao] = useState<SugestaoLoc[] | null>(null);
  const [removidas, setRemovidas] = useState<Set<string>>(new Set());
  const [locsManual, setLocsManual] = useState<Set<string>>(new Set());

  const galpoesQuery = useGalpoes();
  const locsQuery = useLocalizacoes(galpaoId || null);
  const empresasDoGalpao = useMemo(
    () =>
      galpoesQuery.data?.find((g) => g.id === galpaoId)?.empresas ?? [],
    [galpoesQuery.data, galpaoId],
  );

  const sugerir = useMutation({
    mutationFn: () =>
      wmsApi<{ localizacoes: SugestaoLoc[] }>("/api/wms/inventario/sugerir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          galpao_id: galpaoId,
          empresa_dona_id: empresaDonaId || null,
          tamanho: tamanhoPool,
        }),
      }),
    onSuccess: (r) => {
      setSugestao(r.localizacoes);
      setRemovidas(new Set());
      if (r.localizacoes.length === 0) {
        toast.error(
          "Nenhuma localização candidata. Pode ser que não haja saldo > 0 ou curva ABC ainda não calculada.",
        );
      } else {
        toast.success(`${r.localizacoes.length} localizações sugeridas`);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const criar = useMutation({
    mutationFn: (body: unknown) =>
      wmsApi<{ id: string }>("/api/wms/inventario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast.success("Sessão criada");
      onCreated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function handleCriar() {
    if (!galpaoId) return toast.error("Selecione um galpão");

    const tipo: TipoSessao =
      tipoCriacao === "completo" ? "completo" : "cycle_count";

    let localizacoes: Array<{ localizacao_id: string; motivo?: MotivoLoc }> =
      [];

    if (tipoCriacao === "inteligente") {
      if (!sugestao || sugestao.length === 0) {
        return toast.error("Gere a sugestão primeiro");
      }
      localizacoes = sugestao
        .filter((l) => !removidas.has(l.localizacao_id))
        .map((l) => ({ localizacao_id: l.localizacao_id, motivo: l.motivo }));
    } else if (tipoCriacao === "manual") {
      if (locsManual.size === 0) {
        return toast.error("Selecione pelo menos uma localização");
      }
      localizacoes = Array.from(locsManual).map((id) => ({
        localizacao_id: id,
        motivo: "manual" as const,
      }));
    } else {
      const todas = locsQuery.data?.rows ?? [];
      if (todas.length === 0) {
        return toast.error("Galpão sem localizações cadastradas");
      }
      localizacoes = todas.map((l) => ({
        localizacao_id: l.id,
        motivo: "completo" as const,
      }));
    }

    if (localizacoes.length === 0)
      return toast.error("Nenhuma localização selecionada");

    criar.mutate({
      tipo,
      nome: nome || undefined,
      galpao_id: galpaoId,
      empresa_dona_id: empresaDonaId || null,
      modo_contagem: modo,
      tolerancia_pct: toleranciaPct,
      exige_aprovacao_acima_valor: exigeAprovacaoValor,
      localizacoes,
    });
  }

  const totalSelecionado =
    tipoCriacao === "inteligente"
      ? (sugestao?.length ?? 0) - removidas.size
      : tipoCriacao === "manual"
        ? locsManual.size
        : (locsQuery.data?.rows?.length ?? 0);

  return (
    <Modal
      title="Nova sessão de inventário"
      onClose={onClose}
      width={720}
      footer={
        <>
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={onClose}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            disabled={!galpaoId || totalSelecionado === 0 || criar.isPending}
            onClick={handleCriar}
          >
            <Icon name="check" size={11} />
            {criar.isPending
              ? "Criando…"
              : `Criar sessão (${totalSelecionado} locs)`}
          </button>
        </>
      }
    >
      {/* Seleção do tipo de criação */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 8,
          marginBottom: 18,
        }}
      >
        <TipoCard
          tipo="inteligente"
          ativo={tipoCriacao === "inteligente"}
          onClick={() => setTipoCriacao("inteligente")}
          icone="sparkle"
          titulo="Cycle Inteligente"
          descricao="Sistema sugere curva A + divergentes + antigos"
        />
        <TipoCard
          tipo="manual"
          ativo={tipoCriacao === "manual"}
          onClick={() => setTipoCriacao("manual")}
          icone="clipboard"
          titulo="Cycle Manual"
          descricao="Você escolhe quais localizações contar"
        />
        <TipoCard
          tipo="completo"
          ativo={tipoCriacao === "completo"}
          onClick={() => setTipoCriacao("completo")}
          icone="building"
          titulo="Inventário Completo"
          descricao="Todas as localizações ativas do galpão"
        />
      </div>

      {/* Comuns */}
      <div className="wms-row-3">
        <Field label="Galpão" required>
          <select
            className="wms-select"
            value={galpaoId}
            onChange={(e) => {
              setGalpaoId(e.target.value);
              setEmpresaDonaId("");
              setSugestao(null);
              setLocsManual(new Set());
            }}
          >
            <option value="">— selecione —</option>
            {galpoesQuery.data?.map((g) => (
              <option key={g.id} value={g.id}>
                {g.nome}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Empresa dona"
          hint="opcional · filtra produtos desta dona"
        >
          <select
            className="wms-select"
            value={empresaDonaId}
            onChange={(e) => setEmpresaDonaId(e.target.value)}
            disabled={!galpaoId}
          >
            <option value="">todas</option>
            {empresasDoGalpao.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nome}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Modo de contagem" required>
          <select
            className="wms-select"
            value={modo}
            onChange={(e) => setModo(e.target.value as ModoContagem)}
          >
            <option value="blind">
              Blind (operador não vê esperado)
            </option>
            <option value="aberto">
              Aberto (operador vê esperado)
            </option>
          </select>
        </Field>
      </div>

      <div className="wms-row-3" style={{ marginTop: 10 }}>
        <Field label="Nome da sessão" hint="opcional">
          <input
            className="wms-input"
            type="text"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="Ex: Cycle Rua A — 12/05"
          />
        </Field>
        <Field label="Tolerância" hint="%">
          <input
            className="wms-input wms-mono wms-tar"
            type="number"
            step="0.5"
            value={toleranciaPct}
            onChange={(e) => setToleranciaPct(Number(e.target.value))}
          />
        </Field>
        <Field label="Aprovar acima de" hint="R$">
          <input
            className="wms-input wms-mono wms-tar"
            type="number"
            value={exigeAprovacaoValor}
            onChange={(e) =>
              setExigeAprovacaoValor(Number(e.target.value))
            }
          />
        </Field>
      </div>

      {/* Específico por tipo */}
      <div style={{ marginTop: 18 }}>
        {tipoCriacao === "inteligente" && (
          <>
            <div className="wms-row-3" style={{ marginBottom: 12 }}>
              <Field label="Tamanho do pool">
                <input
                  className="wms-input wms-mono wms-tar"
                  type="number"
                  min={5}
                  max={200}
                  value={tamanhoPool}
                  onChange={(e) => setTamanhoPool(Number(e.target.value))}
                />
              </Field>
              <div style={{ alignSelf: "end" }}>
                <button
                  type="button"
                  className="wms-btn wms-btn-ghost"
                  disabled={!galpaoId || sugerir.isPending}
                  onClick={() => sugerir.mutate()}
                >
                  <Icon name="sparkle" size={11} />
                  {sugerir.isPending ? "Gerando…" : "Gerar sugestão"}
                </button>
              </div>
              <div />
            </div>

            {sugestao && sugestao.length > 0 && (
              <div
                style={{
                  border: "1px solid var(--wms-c-border)",
                  borderRadius: "var(--wms-r-3)",
                  maxHeight: 280,
                  overflowY: "auto",
                }}
              >
                <table className="wms-mini-tbl" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ width: 28 }}></th>
                      <th>Localização</th>
                      <th>Motivo</th>
                      <th className="wms-tar">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sugestao.map((l) => {
                      const removida = removidas.has(l.localizacao_id);
                      return (
                        <tr
                          key={l.localizacao_id}
                          style={{
                            opacity: removida ? 0.4 : 1,
                            textDecoration: removida ? "line-through" : "none",
                          }}
                        >
                          <td>
                            <input
                              type="checkbox"
                              checked={!removida}
                              onChange={() => {
                                const ns = new Set(removidas);
                                if (removida) ns.delete(l.localizacao_id);
                                else ns.add(l.localizacao_id);
                                setRemovidas(ns);
                              }}
                            />
                          </td>
                          <td className="wms-mono">{l.codigo}</td>
                          <td className="wms-td-mute">
                            {MOTIVO_LABEL[l.motivo] ?? l.motivo}
                          </td>
                          <td className="wms-tar wms-mono wms-td-mute">
                            {fmtNum(l.score)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {!sugestao && galpaoId && (
              <div className="wms-exp-empty">
                Clique em &quot;Gerar sugestão&quot; pra ver a proposta do
                sistema (mix 50% curva A + 30% divergentes recentes + 20% sem
                contagem em 30d+).
              </div>
            )}
          </>
        )}

        {tipoCriacao === "manual" && (
          <>
            {!galpaoId ? (
              <div className="wms-exp-empty">Selecione um galpão primeiro.</div>
            ) : locsQuery.isLoading ? (
              <div className="wms-exp-empty">Carregando localizações…</div>
            ) : (
              <>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 8,
                  }}
                >
                  <div className="wms-td-mute" style={{ fontSize: 12 }}>
                    {locsManual.size} de {locsQuery.data?.rows?.length ?? 0}{" "}
                    selecionada(s)
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      className="wms-btn wms-btn-ghost wms-btn-sm"
                      onClick={() =>
                        setLocsManual(
                          new Set(
                            (locsQuery.data?.rows ?? []).map((l) => l.id),
                          ),
                        )
                      }
                    >
                      Marcar todas
                    </button>
                    <button
                      type="button"
                      className="wms-btn wms-btn-ghost wms-btn-sm"
                      onClick={() => setLocsManual(new Set())}
                    >
                      Limpar
                    </button>
                  </div>
                </div>
                <div
                  style={{
                    border: "1px solid var(--wms-c-border)",
                    borderRadius: "var(--wms-r-3)",
                    maxHeight: 280,
                    overflowY: "auto",
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                    gap: 4,
                    padding: 8,
                  }}
                >
                  {(locsQuery.data?.rows ?? []).map((l) => {
                    const checked = locsManual.has(l.id);
                    return (
                      <label
                        key={l.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          fontSize: 12,
                          cursor: "pointer",
                          padding: "4px 6px",
                          borderRadius: 4,
                          background: checked
                            ? "var(--wms-c-faint)"
                            : "transparent",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const ns = new Set(locsManual);
                            if (checked) ns.delete(l.id);
                            else ns.add(l.id);
                            setLocsManual(ns);
                          }}
                        />
                        <span className="wms-mono">{l.codigo}</span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}

        {tipoCriacao === "completo" && galpaoId && (
          <div
            style={{
              background: "var(--wms-c-faint)",
              border: "1px solid var(--wms-c-border)",
              borderRadius: "var(--wms-r-3)",
              padding: 14,
              fontSize: 13,
            }}
          >
            <div style={{ marginBottom: 4 }}>
              <strong>
                {locsQuery.data?.rows?.length ?? 0} localizações
              </strong>{" "}
              do galpão serão incluídas no inventário.
            </div>
            <div className="wms-td-mute" style={{ fontSize: 12 }}>
              Inventário completo costuma demorar várias horas com 5 operadores.
              Considere fazer cycle counts inteligentes mais frequentes.
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function TipoCard({
  ativo,
  onClick,
  icone,
  titulo,
  descricao,
}: {
  tipo: TipoCriacao;
  ativo: boolean;
  onClick: () => void;
  icone: "sparkle" | "clipboard" | "building";
  titulo: string;
  descricao: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: 12,
        borderRadius: "var(--wms-r-3)",
        border: ativo
          ? "2px solid var(--wms-c-fg)"
          : "1px solid var(--wms-c-border)",
        background: ativo ? "var(--wms-c-faint)" : "transparent",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minHeight: 88,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}
      >
        <Icon name={icone} size={14} />
        <span style={{ fontSize: 13 }}>{titulo}</span>
      </div>
      <div
        className="wms-td-mute"
        style={{ fontSize: 11.5, lineHeight: 1.35 }}
      >
        {descricao}
      </div>
    </button>
  );
}
