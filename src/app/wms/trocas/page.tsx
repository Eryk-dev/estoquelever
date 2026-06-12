"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  PageHeader,
  Icon,
  fmtRelative,
  StatusBadge,
} from "@/components/wms/ui/wms-ui";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";
import {
  TrocaAprovacaoModal,
  type Troca,
} from "@/components/wms/trocas/troca-aprovacao-modal";

type Aba = "pendentes" | "historico";

const TIPO_TEXTO: Record<string, string> = {
  upgrade: "Upgrade",
  downgrade: "Downgrade",
  misto: "Misto",
  sem_classificacao: "Sem classificação",
  mesmo_nivel: "Mesmo nível",
};

const TIPO_CLS: Record<string, string> = {
  upgrade: "info",
  downgrade: "warn",
  misto: "danger",
  sem_classificacao: "warn",
  mesmo_nivel: "mute",
};

const ORIGEM_TEXTO: Record<string, string> = {
  roteamento: "Roteamento",
  separacao: "Separação",
  compras: "Compras",
  painel: "Painel",
};

function useTrocas(status: "pendente" | "todas") {
  return useQuery({
    queryKey: ["wms-trocas", status],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/trocas?status=${status}`);
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      const json = (await r.json()) as { trocas: Troca[] };
      return json.trocas ?? [];
    },
    refetchInterval: 30_000,
  });
}

export default function WmsTrocasPage() {
  const { can } = usePermissoes();
  const podeDecidir = can("vendas.aprovar_troca");

  const [aba, setAba] = useState<Aba>("pendentes");
  const [aberta, setAberta] = useState<Troca | null>(null);

  const status = aba === "pendentes" ? "pendente" : "todas";
  const query = useTrocas(status);

  const lista = useMemo(() => {
    const all = query.data ?? [];
    return aba === "historico"
      ? all.filter((t) => t.status !== "pendente")
      : all;
  }, [query.data, aba]);

  return (
    <>
      <PageHeader
        title="Trocas de Equivalência"
        subtitle="Aprovação de troca de peça equivalente (upgrade, downgrade, misto, sem classificação)"
      />

      <div className="wms-vtab" style={{ marginBottom: 16 }}>
        <button
          className={`wms-vtab-btn ${aba === "pendentes" ? "is-active" : ""}`}
          onClick={() => setAba("pendentes")}
        >
          Pendentes
          {aba === "pendentes" && (
            <span className="wms-vtab-n">{lista.length}</span>
          )}
        </button>
        <button
          className={`wms-vtab-btn ${aba === "historico" ? "is-active" : ""}`}
          onClick={() => setAba("historico")}
        >
          Histórico
          {aba === "historico" && (
            <span className="wms-vtab-n">{lista.length}</span>
          )}
        </button>
      </div>

      {query.isLoading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="wms-skel"
              style={{ height: 56, borderRadius: "var(--wms-r-2)" }}
            />
          ))}
        </div>
      )}

      {query.isError && !query.isLoading && (
        <div className="wms-td-danger" style={{ fontSize: 13 }}>
          Erro ao carregar trocas: {(query.error as Error).message}
        </div>
      )}

      {!query.isLoading && !query.isError && lista.length === 0 && (
        <div className="wms-empty-block">
          <h3>
            {aba === "pendentes"
              ? "Nenhuma troca aguardando aprovação"
              : "Nenhuma troca no histórico"}
          </h3>
          <p>
            {aba === "pendentes"
              ? "Solicitações de troca de peça equivalente que exigem decisão humana aparecem aqui."
              : "Trocas já aprovadas ou rejeitadas aparecem aqui."}
          </p>
        </div>
      )}

      {!query.isLoading && !query.isError && lista.length > 0 && (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Troca</th>
                <th className="wms-tar">Qty</th>
                <th>Origem</th>
                <th>Solicitante</th>
                <th>Quando</th>
                {aba === "historico" && <th>Status</th>}
              </tr>
            </thead>
            <tbody>
              {lista.map((t) => (
                <tr
                  key={t.id}
                  className="wms-tr-clickable"
                  onClick={() => setAberta(t)}
                >
                  <td>
                    <span
                      className={`wms-badge wms-badge-${TIPO_CLS[t.tipo] ?? "mute"}`}
                    >
                      {TIPO_TEXTO[t.tipo] ?? t.tipo}
                    </span>
                  </td>
                  <td className="wms-mono" style={{ fontSize: 12 }}>
                    {t.sku_vendido}{" "}
                    <Icon name="arrow-right" size={10} /> {t.sku_substituto}
                  </td>
                  <td className="wms-tar wms-mono">{t.quantidade}</td>
                  <td>
                    <span className="wms-td-mute" style={{ fontSize: 12 }}>
                      {ORIGEM_TEXTO[t.origem_solicitacao] ?? t.origem_solicitacao}
                    </span>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {t.solicitante?.nome ?? (
                      <span className="wms-td-mute">automático</span>
                    )}
                  </td>
                  <td className="wms-td-mute" style={{ fontSize: 12 }}>
                    {fmtRelative(t.solicitado_em)}
                  </td>
                  {aba === "historico" && (
                    <td>
                      <StatusBadge status={t.status} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!podeDecidir && lista.length > 0 && (
        <div
          className="wms-td-mute"
          style={{ fontSize: 11.5, marginTop: 10 }}
        >
          <Icon name="alert" size={10} /> Você pode visualizar as trocas, mas não
          tem permissão pra aprovar ou rejeitar.
        </div>
      )}

      {aberta && (
        <TrocaAprovacaoModal
          troca={aberta}
          onClose={() => setAberta(null)}
          onDecidido={() => query.refetch()}
        />
      )}
    </>
  );
}
