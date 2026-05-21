"use client";
import Link from "next/link";
import { Icon, PageHeader, type IconName } from "@/components/wms/ui/wms-ui";
import { useWmsModals } from "@/components/wms/wms-shell";
import { QuadroTarefas } from "@/components/wms/home/quadro-tarefas";

interface CardData {
  href: string;
  icon: IconName;
  title: string;
  desc: string;
}

interface Group {
  titulo: string;
  cards: CardData[];
}

const GROUPS: Group[] = [
  {
    titulo: "Visibilidade",
    cards: [
      {
        href: "/wms/estoque",
        icon: "box",
        title: "Estoque",
        desc: "Saldos atuais com expand inline e drilldown",
      },
      {
        href: "/wms/cobertura",
        icon: "gauge",
        title: "Cobertura",
        desc: "Dias por giro 30d × lead time",
      },
      {
        href: "/wms/ledger",
        icon: "list",
        title: "Movimentações",
        desc: "Ledger imutável com filtros",
      },
      {
        href: "/wms/dashboard",
        icon: "sparkle",
        title: "Dashboard geral",
        desc: "Eventos críticos agregados",
      },
    ],
  },
  {
    titulo: "Operações",
    cards: [
      {
        href: "/wms/transferir",
        icon: "arrows",
        title: "Transferências",
        desc: "Inter-galpão (par S+E com origem_id)",
      },
      {
        href: "/wms/replenishment",
        icon: "shuffle",
        title: "Realocar",
        desc: "Intra-galpão (overstock → picking)",
      },
      {
        href: "/wms/devolucoes",
        icon: "rotate",
        title: "Devoluções",
        desc: "Classificação A/B/C/D",
      },
    ],
  },
  {
    titulo: "Inventário",
    cards: [
      {
        href: "/wms/inventario",
        icon: "clipboard",
        title: "Sessões",
        desc: "Cycle count e completo",
      },
      {
        href: "/wms/inventario/metricas",
        icon: "gauge",
        title: "Métricas",
        desc: "Acuracidade por operador / localização",
      },
    ],
  },
  {
    titulo: "Relatórios",
    cards: [
      {
        href: "/wms/relatorios/movs-por-empresa",
        icon: "columns",
        title: "Movs por Empresa",
        desc: "Compras / vendas / referência por período",
      },
    ],
  },
  {
    titulo: "Cadastros",
    cards: [
      {
        href: "/wms/produtos",
        icon: "tag",
        title: "Produtos",
        desc: "Catálogo + sync com Tiny",
      },
      {
        href: "/wms/localizacoes",
        icon: "pin",
        title: "Localizações",
        desc: "Endereços por galpão",
      },
      {
        href: "/wms/fornecedores",
        icon: "truck",
        title: "Fornecedores",
        desc: "CRUD + lead times",
      },
    ],
  },
];

export default function WmsHome() {
  const modals = useWmsModals();

  return (
    <>
      <PageHeader
        title="WMS"
        subtitle="Operações de estoque · 3D (produto × galpão × localização)"
      >
        <button
          className="wms-btn wms-btn-ghost"
          onClick={() => modals.open("ajuste")}
        >
          <Icon name="sliders" size={12} />
          Ajustar
        </button>
        <button
          className="wms-btn wms-btn-primary"
          onClick={() => modals.open("receber")}
        >
          <Icon name="plus" size={12} />
          Receber mercadoria
        </button>
      </PageHeader>

      <QuadroTarefas />

      {GROUPS.map((g) => (
        <section key={g.titulo} style={{ marginBottom: 24 }}>
          <h2 className="wms-sec-h">{g.titulo}</h2>
          <div className="wms-home-grid">
            {g.cards.map((c) => (
              <Link key={c.href} href={c.href} className="wms-home-card">
                <div className="wms-home-card-icon">
                  <Icon name={c.icon} />
                </div>
                <div>
                  <div className="wms-home-card-title">{c.title}</div>
                  <div className="wms-home-card-desc">{c.desc}</div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
