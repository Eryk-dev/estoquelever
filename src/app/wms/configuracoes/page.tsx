"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, PageHeader } from "@/components/wms/ui/wms-ui";
import { AbaGalpoes } from "@/components/wms/configuracoes/aba-galpoes";
import { AbaEmpresas } from "@/components/wms/configuracoes/aba-empresas";
import { AbaEmprestimos } from "@/components/wms/configuracoes/aba-emprestimos";
import type { GalpaoHierarquiaWms } from "@/components/wms/configuracoes/types";
import { useAuth } from "@/lib/auth-context";

type AbaId = "galpoes" | "empresas" | "emprestimos";

const ABAS: { id: AbaId; label: string }[] = [
  { id: "galpoes", label: "Galpões" },
  { id: "empresas", label: "Empresas" },
  { id: "emprestimos", label: "Empréstimos & Swaps" },
];

export default function WmsConfiguracoesPage() {
  const { user } = useAuth();
  const isAdmin = (user?.cargos ?? [user?.cargo]).includes("admin");
  const [aba, setAba] = useState<AbaId>("galpoes");

  const galpoesQuery = useQuery({
    queryKey: ["wms-cfg-galpoes"],
    queryFn: () => wmsApi<GalpaoHierarquiaWms[]>("/api/admin/galpoes"),
  });

  const galpoes = galpoesQuery.data ?? [];

  const counts = {
    galpoes: galpoes.length,
    empresas: new Set(
      galpoes.flatMap((g) => g.siso_empresas.map((e) => e.id)),
    ).size,
    emprestimos: "—" as const,
  };

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Configurações" />
        <div className="wms-empty-block">
          <h3>Acesso restrito</h3>
          <p>Apenas administradores podem editar a configuração do WMS.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Configurações"
        subtitle="Galpões, empresas e regras de empréstimo/swap"
      >
        <Link
          href="/wms/configuracoes/conexoes"
          className="wms-btn wms-btn-ghost"
          title="Conexão Tiny OAuth2, depósitos, PrintNode e webhook"
        >
          <Icon name="sliders" size={12} />
          Conexões &amp; impressoras
        </Link>
      </PageHeader>

      <div className="wms-stab" role="tablist" style={{ marginBottom: 16 }}>
        {ABAS.map((t) => {
          const ativa = aba === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={ativa}
              className={`wms-stab-btn${ativa ? " is-active" : ""}`}
              onClick={() => setAba(t.id)}
            >
              <span className="wms-stab-btn-lbl">{t.label}</span>
              <span className="wms-stab-btn-n">{counts[t.id]}</span>
            </button>
          );
        })}
      </div>

      {galpoesQuery.isError && (
        <div className="wms-empty-block">
          <h3>Erro ao carregar dados</h3>
          <p>{(galpoesQuery.error as Error).message}</p>
        </div>
      )}

      {aba === "galpoes" && (
        <AbaGalpoes galpoes={galpoes} isLoading={galpoesQuery.isLoading} />
      )}
      {aba === "empresas" && (
        <AbaEmpresas galpoes={galpoes} isLoading={galpoesQuery.isLoading} />
      )}
      {aba === "emprestimos" && (
        <AbaEmprestimos
          galpoes={galpoes}
          isLoading={galpoesQuery.isLoading}
        />
      )}
    </>
  );
}
