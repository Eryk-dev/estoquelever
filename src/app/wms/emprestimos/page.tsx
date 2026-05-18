"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, PageHeader, fmtNum } from "@/components/wms/ui/wms-ui";
import type { SaldoDevedor } from "@/lib/wms/emprestimos";

interface EmpresaRow {
  id: string;
  nome: string;
}

interface GalpaoRow {
  id: string;
  empresas?: EmpresaRow[];
}

export default function EmprestimosPage() {
  const { data: galpoes } = useQuery({
    queryKey: ["galpoes"],
    queryFn: async () => {
      const raw = await wmsApi<
        Array<{
          id: string;
          nome: string;
          siso_empresas?: Array<{ id: string; nome: string; ativo?: boolean }>;
        }>
      >("/api/wms/admin/galpoes");
      return raw.map<GalpaoRow>((g) => ({
        id: g.id,
        nome: g.nome,
        empresas: (g.siso_empresas ?? [])
          .filter((e) => e.ativo !== false)
          .map((e) => ({ id: e.id, nome: e.nome })),
      }));
    },
  });
  const empresas: EmpresaRow[] = (galpoes ?? []).flatMap(
    (g) => g.empresas ?? [],
  );

  const saldosQuery = useQuery({
    queryKey: ["wms-saldos-devedores"],
    queryFn: () =>
      wmsApi<{ rows: SaldoDevedor[] }>("/api/wms/emprestimos/saldos"),
  });

  const empresaNome = (id: string) =>
    empresas.find((e) => e.id === id)?.nome ?? id;

  const saldos = saldosQuery.data?.rows ?? [];

  return (
    <>
      <PageHeader
        title="Saldos devedores"
        subtitle="Saldo líquido bidirecional credora ↔ devedora por produto, calculado via wms_saldos_devedores()"
      >
        <Link
          href="/wms/configuracoes"
          className="wms-btn wms-btn-ghost"
          title="Editar regras de empréstimo e swap"
        >
          <Icon name="sliders" size={12} />
          Configurar regras
        </Link>
      </PageHeader>

      {saldosQuery.isLoading && (
        <div className="wms-loading-pane">Carregando saldos…</div>
      )}
      {saldosQuery.isError && (
        <div className="wms-empty-block">
          <h3>Erro</h3>
          <p>{(saldosQuery.error as Error).message}</p>
        </div>
      )}
      {!saldosQuery.isLoading && saldos.length === 0 && (
        <div className="wms-empty-block">
          <h3>Sem saldos devedores</h3>
          <p>Nenhum empréstimo pendente entre empresas no momento.</p>
        </div>
      )}
      {saldos.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th>Credora</th>
                <th>Devedora</th>
                <th>Produto</th>
                <th className="wms-tar">Saldo líquido</th>
              </tr>
            </thead>
            <tbody>
              {saldos.map((s, i) => (
                <tr key={i}>
                  <td className="wms-td-mute">{empresaNome(s.credora)}</td>
                  <td className="wms-td-mute">{empresaNome(s.devedora)}</td>
                  <td className="wms-mono" style={{ fontSize: 12 }}>
                    {s.produto_id}
                  </td>
                  <td className="wms-tar wms-mono">
                    {fmtNum(Number(s.saldo_liquido))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
