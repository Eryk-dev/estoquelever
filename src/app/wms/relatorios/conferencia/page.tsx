"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { Kpi, PageHeader } from "@/components/wms/ui/wms-ui";

interface GalpaoLite {
  id: string;
  nome: string;
}

interface RelatorioConferencia {
  periodo: { de: string; ate: string };
  geral: {
    embalados_periodo: number;
    com_embalador: number;
    conferidos: number;
    divergencias: number;
    pct_rastreado: number | null;
    pct_conferido: number | null;
  };
  por_embalador: Array<{
    usuario_id: string;
    nome: string;
    embalados: number;
    conferidos: number;
    divergencias: number;
    pct_conferido: number | null;
    taxa_acerto: number | null;
    por_tipo: Record<string, number>;
  }>;
  por_conferente: Array<{
    usuario_id: string;
    nome: string;
    conferidos: number;
    divergencias_encontradas: number;
  }>;
}

const TIPO_LABELS: Record<string, string> = {
  produto_errado: "produto errado",
  faltou_item: "faltou",
  sobrou_item: "sobrou",
  quantidade_errada: "qty errada",
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pct(v: number | null): string {
  if (v == null) return "—";
  return `${Math.round(v * 100)}%`;
}

export default function RelatorioConferenciaPage() {
  const [de, setDe] = useState(() => isoDate(new Date(Date.now() - 7 * 86400_000)));
  const [ate, setAte] = useState(() => isoDate(new Date()));
  const [galpaoId, setGalpaoId] = useState<string>("all");

  const galpoesQuery = useQuery({
    queryKey: ["wms-galpoes-lite"],
    queryFn: () =>
      wmsApi<GalpaoLite[]>(`/api/wms/admin/galpoes`).then((arr) =>
        arr.map((g) => ({ id: g.id, nome: g.nome })),
      ),
  });

  const relQuery = useQuery({
    queryKey: ["wms-relatorio-conferencia", de, ate, galpaoId],
    queryFn: () => {
      const params = new URLSearchParams({ de, ate });
      if (galpaoId !== "all") params.set("galpao_id", galpaoId);
      return wmsApi<RelatorioConferencia>(`/api/wms/relatorios/conferencia?${params}`);
    },
  });

  const r = relQuery.data;

  function preset(dias: number) {
    setDe(isoDate(new Date(Date.now() - dias * 86400_000)));
    setAte(isoDate(new Date()));
  }

  return (
    <>
      <PageHeader
        title="Conferência de embalagem"
        subtitle="Taxa de acerto por embalador e volume por conferente"
        backHref="/wms"
        backLabel="Voltar ao WMS"
      />

      {/* Filtros */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <button type="button" className="wms-btn wms-btn-ghost wms-btn-sm" onClick={() => preset(7)}>
          7 dias
        </button>
        <button type="button" className="wms-btn wms-btn-ghost wms-btn-sm" onClick={() => preset(30)}>
          30 dias
        </button>
        <input
          type="date"
          className="wms-input"
          value={de}
          onChange={(e) => setDe(e.target.value)}
          style={{ width: 150 }}
        />
        <span className="wms-td-mute">até</span>
        <input
          type="date"
          className="wms-input"
          value={ate}
          onChange={(e) => setAte(e.target.value)}
          style={{ width: 150 }}
        />
        <select
          className="wms-input"
          value={galpaoId}
          onChange={(e) => setGalpaoId(e.target.value)}
          style={{ width: 160 }}
        >
          <option value="all">Todos galpões</option>
          {(galpoesQuery.data ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.nome}
            </option>
          ))}
        </select>
      </div>

      {relQuery.isLoading && <div className="wms-loading-pane">Carregando…</div>}
      {relQuery.isError && (
        <div className="wms-td-empty wms-td-danger">
          Erro: {(relQuery.error as Error).message}
        </div>
      )}

      {r && (
        <>
          {/* KPIs gerais */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            <Kpi label="Pacotes embalados" value={r.geral.embalados_periodo} />
            <Kpi label="Com embalador registrado" value={`${r.geral.com_embalador} (${pct(r.geral.pct_rastreado)})`} />
            <Kpi label="Conferidos" value={`${r.geral.conferidos} (${pct(r.geral.pct_conferido)})`} />
            <Kpi
              label="Divergências"
              value={r.geral.divergencias}
              danger={r.geral.divergencias > 0}
            />
          </div>

          {/* Por embalador */}
          <h3 className="wms-sec-h" style={{ marginTop: 20 }}>
            Por embalador
          </h3>
          {r.por_embalador.length === 0 ? (
            <div className="wms-td-mute" style={{ fontSize: 12.5 }}>
              Nenhum pacote com embalador registrado no período.
            </div>
          ) : (
            <div className="wms-tbl">
              <table>
                <thead>
                  <tr>
                    <th>Embalador</th>
                    <th className="wms-tar">Embalados</th>
                    <th className="wms-tar">Conferidos</th>
                    <th className="wms-tar">% conferido</th>
                    <th className="wms-tar">Divergências</th>
                    <th className="wms-tar">Taxa de acerto</th>
                    <th>Tipos de erro</th>
                  </tr>
                </thead>
                <tbody>
                  {r.por_embalador.map((e) => (
                    <tr key={e.usuario_id}>
                      <td>{e.nome}</td>
                      <td className="wms-tar wms-mono">{e.embalados}</td>
                      <td className="wms-tar wms-mono">{e.conferidos}</td>
                      <td className="wms-tar wms-mono">{pct(e.pct_conferido)}</td>
                      <td className="wms-tar wms-mono" style={e.divergencias > 0 ? { color: "var(--wms-c-danger)" } : undefined}>
                        {e.divergencias}
                      </td>
                      <td className="wms-tar wms-mono" style={{ fontWeight: 600 }}>
                        {pct(e.taxa_acerto)}
                      </td>
                      <td className="wms-td-mute" style={{ fontSize: 11.5 }}>
                        {Object.entries(e.por_tipo)
                          .map(([t, n]) => `${TIPO_LABELS[t] ?? t}: ${n}`)
                          .join(" · ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Por conferente */}
          <h3 className="wms-sec-h" style={{ marginTop: 20 }}>
            Por conferente
          </h3>
          {r.por_conferente.length === 0 ? (
            <div className="wms-td-mute" style={{ fontSize: 12.5 }}>
              Nenhuma conferência no período.
            </div>
          ) : (
            <div className="wms-tbl">
              <table>
                <thead>
                  <tr>
                    <th>Conferente</th>
                    <th className="wms-tar">Conferidos</th>
                    <th className="wms-tar">Divergências encontradas</th>
                  </tr>
                </thead>
                <tbody>
                  {r.por_conferente.map((c) => (
                    <tr key={c.usuario_id}>
                      <td>{c.nome}</td>
                      <td className="wms-tar wms-mono">{c.conferidos}</td>
                      <td className="wms-tar wms-mono">{c.divergencias_encontradas}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
