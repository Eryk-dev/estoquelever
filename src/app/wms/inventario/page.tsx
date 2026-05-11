"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Link from "next/link";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Icon,
  PageHeader,
  StatusBadge,
  Field,
} from "@/components/wms/ui/wms-ui";

interface SessaoRow {
  id: string;
  tipo: string;
  status: string;
  modo_contagem?: string;
  galpao?: { nome?: string };
  criado_em?: string;
  progresso?: {
    total: number;
    contadas: number;
    divergentes: number;
    pendentes: number;
  };
  nome?: string;
}

interface GalpaoRow {
  id: string;
  nome: string;
}

interface LocRow {
  id: string;
  codigo: string;
}

interface NovoSessao {
  tipo: "cycle_count" | "completo";
  galpao_id: string;
  modo_contagem: "aberto" | "blind" | "duplo_blind";
  tolerancia_pct: number;
  exige_aprovacao_acima_valor: number;
  areas: { nome: string; localizacao_ids: string[] }[];
}

export default function InventarioListaPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [novo, setNovo] = useState<NovoSessao>({
    tipo: "cycle_count",
    galpao_id: "",
    modo_contagem: "blind",
    tolerancia_pct: 2,
    exige_aprovacao_acima_valor: 1000,
    areas: [],
  });

  const sessoesQuery = useQuery({
    queryKey: ["wms-inv-sessoes"],
    queryFn: () => wmsApi<{ rows: SessaoRow[] }>("/api/wms/inventario"),
  });

  const { data: galpoes } = useQuery({
    queryKey: ["galpoes"],
    queryFn: () => wmsApi<GalpaoRow[]>("/api/admin/galpoes"),
  });

  const { data: locs } = useQuery({
    queryKey: ["wms-locs", novo.galpao_id],
    queryFn: () =>
      wmsApi<{ rows: LocRow[] }>(
        `/api/wms/localizacoes?galpao_id=${novo.galpao_id}`,
      ),
    enabled: !!novo.galpao_id,
  });

  const criar = useMutation({
    mutationFn: () =>
      wmsApi<{ id: string }>("/api/wms/inventario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(novo),
      }),
    onSuccess: () => {
      toast.success("Sessão criada");
      setNovo((p) => ({ ...p, areas: [] }));
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["wms-inv-sessoes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function adicionarArea(localizacao_ids: string[]) {
    setNovo((p) => ({
      ...p,
      areas: [
        ...p.areas,
        { nome: `Área ${p.areas.length + 1}`, localizacao_ids },
      ],
    }));
  }

  const rows = sessoesQuery.data?.rows ?? [];

  return (
    <>
      <PageHeader
        title="Inventários"
        subtitle="Multi-operador, anti-colisão, com tolerâncias e workflow de divergências"
      >
        <Link href="/wms/inventario/metricas" className="wms-btn wms-btn-ghost">
          <Icon name="gauge" size={12} />
          Métricas
        </Link>
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          onClick={() => setShowForm((s) => !s)}
        >
          <Icon name="plus" size={12} />
          Nova sessão
        </button>
      </PageHeader>

      {showForm && (
        <div
          style={{
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-3)",
            padding: 18,
            marginBottom: 20,
          }}
        >
          <h3 className="wms-sec-h" style={{ marginTop: 0 }}>
            Nova sessão
          </h3>
          <div className="wms-row-3">
            <Field label="Tipo" required>
              <select
                className="wms-select"
                value={novo.tipo}
                onChange={(e) =>
                  setNovo({
                    ...novo,
                    tipo: e.target.value as "cycle_count" | "completo",
                  })
                }
              >
                <option value="cycle_count">Cycle count</option>
                <option value="completo">Inventário completo</option>
              </select>
            </Field>
            <Field label="Galpão" required>
              <select
                className="wms-select"
                value={novo.galpao_id}
                onChange={(e) =>
                  setNovo({ ...novo, galpao_id: e.target.value, areas: [] })
                }
              >
                <option value="">— selecione —</option>
                {galpoes?.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.nome}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Modo de contagem" required>
              <select
                className="wms-select"
                value={novo.modo_contagem}
                onChange={(e) =>
                  setNovo({
                    ...novo,
                    modo_contagem: e.target.value as NovoSessao["modo_contagem"],
                  })
                }
              >
                <option value="aberto">Aberto</option>
                <option value="blind">Blind</option>
                <option value="duplo_blind">Duplo blind</option>
              </select>
            </Field>
          </div>

          <div className="wms-row-2">
            <Field
              label="Tolerância"
              hint="%"
            >
              <input
                className="wms-input wms-mono wms-tar"
                type="number"
                step="0.5"
                value={novo.tolerancia_pct}
                onChange={(e) =>
                  setNovo({ ...novo, tolerancia_pct: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Exige aprovação acima de" hint="R$">
              <input
                className="wms-input wms-mono wms-tar"
                type="number"
                value={novo.exige_aprovacao_acima_valor}
                onChange={(e) =>
                  setNovo({
                    ...novo,
                    exige_aprovacao_acima_valor: Number(e.target.value),
                  })
                }
              />
            </Field>
          </div>

          {novo.galpao_id && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="wms-btn wms-btn-ghost wms-btn-sm"
                onClick={() =>
                  adicionarArea((locs?.rows ?? []).map((l) => l.id))
                }
              >
                <Icon name="plus" size={11} />
                Adicionar todas localizações como nova área
              </button>
              <div
                className="wms-td-mute"
                style={{ fontSize: 12, marginTop: 6 }}
              >
                {novo.areas.length} área(s) configurada(s)
              </div>
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 14,
              paddingTop: 14,
              borderTop: "1px solid var(--wms-c-border)",
            }}
          >
            <button
              type="button"
              className="wms-btn wms-btn-ghost"
              onClick={() => setShowForm(false)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              disabled={
                !novo.galpao_id || novo.areas.length === 0 || criar.isPending
              }
              onClick={() => criar.mutate()}
            >
              <Icon name="check" size={11} />
              {criar.isPending ? "Criando…" : "Criar sessão"}
            </button>
          </div>
        </div>
      )}

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
          <p>Inicie um cycle count ou inventário completo para começar.</p>
          <button
            type="button"
            className="wms-btn wms-btn-primary"
            onClick={() => setShowForm(true)}
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
                <th className="wms-tar">Progresso</th>
                <th>Status</th>
                <th style={{ width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const total = s.progresso?.total ?? 0;
                const contadas = s.progresso?.contadas ?? 0;
                const pct = total > 0 ? (contadas / total) * 100 : 0;
                return (
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
                    <td className="wms-tar">
                      {total > 0 ? (
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                            justifyContent: "flex-end",
                          }}
                        >
                          <div
                            style={{
                              width: 80,
                              height: 5,
                              background: "var(--wms-c-panel-2)",
                              borderRadius: 3,
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                height: "100%",
                                width: `${pct}%`,
                                background: "var(--wms-c-fg)",
                              }}
                            />
                          </div>
                          <span
                            className="wms-mono wms-td-mute"
                            style={{ fontSize: 11.5 }}
                          >
                            {contadas}/{total}
                          </span>
                        </div>
                      ) : (
                        <span className="wms-td-mute">—</span>
                      )}
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
