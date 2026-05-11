"use client";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { PageHeader, fmtNum } from "@/components/wms/ui/wms-ui";

interface OperadorRow {
  operador_id: string;
  nome: string;
  contagens: number;
  erro_medio_pct: number | null;
}

interface LocalizacaoRow {
  localizacao_id: string;
  codigo: string;
  total: number;
  sem_div: number;
  erro_medio_pct: number | null;
}

interface Metricas {
  porOperador: OperadorRow[];
  porLocalizacao: LocalizacaoRow[];
}

export default function MetricasPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["wms-inv-metricas"],
    queryFn: () => wmsApi<Metricas>("/api/wms/inventario/metricas"),
  });

  const operadores = data?.porOperador ?? [];
  const localizacoes = data?.porLocalizacao ?? [];

  return (
    <>
      <PageHeader
        title="Métricas de inventário"
        subtitle="Acuracidade por operador e localização nos últimos 30 dias"
      />

      {isLoading && (
        <div className="wms-loading-pane">Carregando métricas…</div>
      )}
      {isError && (
        <div className="wms-empty-block">
          <h3>Erro</h3>
          <p>{(error as Error).message}</p>
        </div>
      )}

      <section style={{ marginBottom: 28 }}>
        <h3 className="wms-sec-h">Acuracidade por operador (30d)</h3>
        {operadores.length === 0 ? (
          <div className="wms-empty-block">
            <h3>Sem contagens nos últimos 30 dias</h3>
          </div>
        ) : (
          <div className="wms-tbl">
            <table>
              <thead>
                <tr>
                  <th>Operador</th>
                  <th className="wms-tar">Contagens</th>
                  <th className="wms-tar">Erro médio</th>
                </tr>
              </thead>
              <tbody>
                {operadores.map((r) => (
                  <tr key={r.operador_id}>
                    <td>{r.nome}</td>
                    <td className="wms-tar wms-mono">
                      {fmtNum(r.contagens)}
                    </td>
                    <td className="wms-tar wms-mono wms-td-mute">
                      {r.erro_medio_pct != null
                        ? `${r.erro_medio_pct.toFixed(2)}%`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="wms-sec-h">Acuracidade por localização</h3>
        {localizacoes.length === 0 ? (
          <div className="wms-empty-block">
            <h3>Sem dados de localização ainda</h3>
          </div>
        ) : (
          <div className="wms-tbl">
            <table>
              <thead>
                <tr>
                  <th>Código</th>
                  <th className="wms-tar">Total</th>
                  <th className="wms-tar">Sem divergência</th>
                  <th className="wms-tar">Erro médio</th>
                </tr>
              </thead>
              <tbody>
                {localizacoes.map((r) => (
                  <tr key={r.localizacao_id}>
                    <td className="wms-mono">{r.codigo}</td>
                    <td className="wms-tar wms-mono">{fmtNum(r.total)}</td>
                    <td className="wms-tar wms-mono wms-td-mute">
                      {fmtNum(r.sem_div)}
                    </td>
                    <td className="wms-tar wms-mono wms-td-mute">
                      {r.erro_medio_pct != null
                        ? `${r.erro_medio_pct.toFixed(2)}%`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
