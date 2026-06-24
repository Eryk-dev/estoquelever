"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";
import { PageHeader, Icon, fmtRelative } from "@/components/wms/ui/wms-ui";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ErrorBanner } from "@/components/ui/error-banner";

// Pista de SEPARAÇÃO FUTURA (ML buffered): vendas pagas com etiqueta segurada
// pra data futura. Reservam/separam/compram JÁ, sem gerar NF. Tela distinta da
// normal pra não confundir a operação. O pick é o MESMO checklist (com futura=1),
// mas PARA em `separado` (peça na caixa do dia) — sem embalagem/expedição. A
// promoção (etiqueta liberou) tira o pedido daqui e manda pro fluxo normal.

type FuturaStatus =
  | "aguardando_compra"
  | "aguardando_separacao"
  | "em_separacao"
  | "separado";

const TABS: Array<{ key: FuturaStatus; label: string; hint: string }> = [
  { key: "aguardando_compra", label: "Aguardando compra", hint: "OC aberta, sem NF" },
  { key: "aguardando_separacao", label: "A separar", hint: "reservado, pronto pra picar" },
  { key: "em_separacao", label: "Em separação", hint: "picando agora" },
  { key: "separado", label: "Na caixa do dia", hint: "picado, aguardando etiqueta" },
];

interface FuturaPedido {
  id: string;
  numero_pedido: string | null;
  numero_ec: string | null;
  cliente: string | null;
  nome_ecommerce: string | null;
  prazo_envio: string | null;
  data_pedido: string | null;
  status_separacao: FuturaStatus;
  separacao_tags: string[];
  total_itens: number;
  total_pecas: number;
  itens_marcados: number;
}

interface FuturaResponse {
  counts: Record<string, number>;
  pedidos: FuturaPedido[];
  error?: string;
}

export default function SeparacaoFuturaPage() {
  const router = useRouter();
  const { can } = usePermissoes();
  const [tab, setTab] = useState<FuturaStatus>("aguardando_separacao");
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());

  const podeSeparar = can("separacao.executar");

  const { data, isLoading, isError, error, refetch } = useQuery<FuturaResponse>({
    queryKey: ["wms-separacao-futura", tab],
    queryFn: async () => {
      const r = await sisoFetch(
        `/api/wms/separacao?futura=1&status_separacao=${tab}`,
      );
      if (!r.ok) throw new Error((await r.json()).error ?? "Erro ao carregar");
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const counts = data?.counts;
  const pedidos = useMemo(() => data?.pedidos ?? [], [data]);

  // Só aguardando_separacao/em_separacao são picáveis na pista futura.
  const picavel = tab === "aguardando_separacao" || tab === "em_separacao";

  function toggle(id: string) {
    setSelecionados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function separarSelecionados() {
    const ids = [...selecionados];
    if (ids.length === 0) return;
    router.push(`/wms/separacao/checklist?pedidos=${ids.join(",")}&futura=1`);
  }

  return (
    <>
      <PageHeader
        title="Separação futura"
        subtitle="Vendas com etiqueta segurada (ML) — reserva e separa cedo, sem NF até a etiqueta liberar"
        backHref="/wms"
        backLabel="Voltar ao WMS"
      >
        {picavel && podeSeparar ? (
          <button
            className="wms-btn wms-btn-primary"
            disabled={selecionados.size === 0}
            onClick={separarSelecionados}
          >
            <Icon name="list" size={14} /> Separar selecionados ({selecionados.size})
          </button>
        ) : null}
      </PageHeader>

      <div
        className="wms-toolbar"
        style={{ marginTop: 16, gap: 6, flexWrap: "wrap" }}
      >
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              className="wms-btn"
              title={t.hint}
              onClick={() => {
                setTab(t.key);
                setSelecionados(new Set());
              }}
              style={
                active
                  ? {
                      background: "var(--wms-c-fg)",
                      color: "var(--wms-c-bg)",
                      borderColor: "var(--wms-c-fg)",
                    }
                  : undefined
              }
            >
              {t.label}
              <span style={{ marginLeft: 6, opacity: 0.8, fontVariantNumeric: "tabular-nums" }}>
                {counts?.[t.key] ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 16 }}>
        {isLoading ? (
          <LoadingSpinner />
        ) : isError ? (
          <ErrorBanner
            message={error instanceof Error ? error.message : "Erro"}
            onRetry={() => refetch()}
          />
        ) : pedidos.length === 0 ? (
          <div className="wms-empty-block">
            Nenhum pedido futura em <strong>{TABS.find((t) => t.key === tab)?.label}</strong>.
          </div>
        ) : (
          <table className="wms-tbl">
            <thead>
              <tr>
                {picavel && podeSeparar ? <th style={{ width: 32 }} /> : null}
                <th>Pedido</th>
                <th>Cliente</th>
                <th>Canal</th>
                <th>Itens</th>
                <th>Prazo (etiqueta)</th>
                <th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {pedidos.map((p) => (
                <tr key={p.id}>
                  {picavel && podeSeparar ? (
                    <td>
                      <input
                        type="checkbox"
                        checked={selecionados.has(p.id)}
                        onChange={() => toggle(p.id)}
                      />
                    </td>
                  ) : null}
                  <td>
                    <strong>{p.numero_pedido ?? p.id}</strong>
                    {p.numero_ec ? (
                      <div className="wms-td-mute" style={{ fontSize: 11 }}>
                        {p.numero_ec}
                      </div>
                    ) : null}
                  </td>
                  <td>{p.cliente ?? "—"}</td>
                  <td>{p.nome_ecommerce ?? "—"}</td>
                  <td>
                    {p.itens_marcados}/{p.total_itens} itens · {p.total_pecas} pç
                  </td>
                  <td>{p.prazo_envio ? fmtRelative(p.prazo_envio) : "—"}</td>
                  <td>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {(p.separacao_tags ?? []).map((t) => (
                        <span
                          key={t}
                          style={{
                            fontSize: 10,
                            padding: "1px 5px",
                            background: "var(--wms-c-info-bg)",
                            color: "var(--wms-c-info)",
                            border: "1px solid var(--wms-c-info-bd)",
                            borderRadius: 3,
                            fontWeight: 500,
                          }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
