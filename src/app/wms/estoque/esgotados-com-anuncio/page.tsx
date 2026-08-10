"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, Kpi, PageHeader, fmtDateTime, fmtNum } from "@/components/wms/ui/wms-ui";

interface Row {
  produto_id: string;
  sku: string;
  descricao: string;
  saldo: number;
  anuncios: Array<{ mlb_id: string; conta_nickname: string }>;
}
interface Response {
  rows: Row[];
  total_skus: number;
  total_anuncios: number;
  cobertura_completa: boolean;
  indice_atualizado_em: string | null;
}

export default function EsgotadosComAnuncioPage() {
  const { activeGalpaoId, activeGalpaoNome } = useAuth();
  const query = useQuery({
    queryKey: ["wms-esgotados-com-anuncio", activeGalpaoId],
    queryFn: () => wmsApi<Response>(
      `/api/wms/estoque/esgotados-com-anuncio${activeGalpaoId ? `?galpao_id=${activeGalpaoId}` : ""}`,
    ),
  });
  const data = query.data;
  return (
    <>
      <PageHeader
        title="Esgotados com anúncio ativo"
        subtitle={`Anúncios do Mercado Livre que precisam ser pausados${activeGalpaoNome ? ` · ${activeGalpaoNome}` : ""}`}
        backHref="/wms/estoque"
        backLabel="Voltar ao estoque"
      />
      {data && (
        <>
          <div className={`wms-hint-card${data.cobertura_completa ? "" : " wms-hint-danger"}`}>
            <Icon name="alert" />
            <span>
              {data.cobertura_completa
                ? `Relatório baseado na varredura completa de todas as contas${data.indice_atualizado_em ? ` em ${fmtDateTime(data.indice_atualizado_em)}` : ""}.`
                : "O índice de alguma conta está incompleto ou vencido; use este relatório como parcial até o próximo scan."}
            </span>
          </div>
          <div className="wms-kpis">
            <Kpi label="SKUs esgotados" value={fmtNum(data.total_skus)} />
            <Kpi label="Anúncios a pausar" value={fmtNum(data.total_anuncios)} />
          </div>
          <div className="wms-tbl"><table>
            <thead><tr><th>SKU</th><th>Descrição</th><th className="wms-tar">Saldo</th><th>Conta</th><th>MLB</th></tr></thead>
            <tbody>{data.rows.flatMap((row) => row.anuncios.map((anuncio, index) => (
              <tr key={`${row.produto_id}-${anuncio.mlb_id}`}>
                <td className="wms-mono wms-td-strong">{index === 0 ? row.sku : ""}</td>
                <td>{index === 0 ? row.descricao : ""}</td>
                <td className="wms-tar wms-mono">{index === 0 ? fmtNum(row.saldo) : ""}</td>
                <td>{anuncio.conta_nickname}</td>
                <td><a href={`https://www.mercadolivre.com.br/anuncios/${anuncio.mlb_id}/modificar`} target="_blank" rel="noreferrer" className="wms-btn-link">{anuncio.mlb_id}</a></td>
              </tr>
            )))}</tbody>
          </table></div>
          {data.rows.length === 0 && <div className="wms-empty-block"><h3>Nenhum anúncio para pausar</h3><p>Não há SKU esgotado com anúncio ativo no snapshot.</p></div>}
        </>
      )}
      {query.isLoading && <div className="wms-loading-pane">Montando relatório…</div>}
      {query.isError && <div className="wms-empty-block"><h3>Erro</h3><p>{(query.error as Error).message}</p></div>}
    </>
  );
}
