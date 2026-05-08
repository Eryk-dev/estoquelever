"use client";
import Link from "next/link";
import {
  Package,
  MapPin,
  BarChart3,
  ScrollText,
  PackagePlus,
  ArrowRightLeft,
  ArrowDown,
  Settings2,
  Clock,
  Truck,
  Network,
  ClipboardList,
  Undo2,
  Replace,
  TrendingUp,
  LayoutDashboard,
  type LucideIcon,
} from "lucide-react";

interface CardData {
  href: string;
  icon: LucideIcon;
  title: string;
  desc: string;
}

interface Group {
  titulo: string;
  cards: CardData[];
}

const groups: Group[] = [
  {
    titulo: "Visibilidade",
    cards: [
      {
        href: "/wms/dashboard",
        icon: LayoutDashboard,
        title: "Dashboard geral",
        desc: "Eventos críticos agregados, refresh 30s",
      },
      {
        href: "/wms/estoque",
        icon: BarChart3,
        title: "Saldos",
        desc: "4 perspectivas: dono, galpão, localização, produto",
      },
      {
        href: "/wms/ledger",
        icon: ScrollText,
        title: "Ledger",
        desc: "Histórico imutável de movimentações",
      },
      {
        href: "/wms/cobertura",
        icon: TrendingUp,
        title: "Cobertura",
        desc: "Dias de cobertura por giro 30d + lead time",
      },
    ],
  },
  {
    titulo: "Operação",
    cards: [
      {
        href: "/wms/receber",
        icon: PackagePlus,
        title: "Receber",
        desc: "Recebimento com sugestão de putaway",
      },
      {
        href: "/wms/transferir",
        icon: ArrowRightLeft,
        title: "Transferir",
        desc: "Inter-galpão (origem → destino)",
      },
      {
        href: "/wms/replenishment",
        icon: ArrowDown,
        title: "Replenishment",
        desc: "Intra-galpão (overstock → picking)",
      },
      {
        href: "/wms/ajuste",
        icon: Settings2,
        title: "Ajuste manual",
        desc: "Entrada ou saída com motivo",
      },
      {
        href: "/wms/devolucoes",
        icon: Undo2,
        title: "Devoluções",
        desc: "Fila + classificação A/B/C/D",
      },
      {
        href: "/wms/troca-sku",
        icon: Replace,
        title: "Troca SKU",
        desc: "Substituir SKU na separação",
      },
      {
        href: "/wms/retroativos",
        icon: Clock,
        title: "Retroativos",
        desc: "Lançamentos pendentes de reconciliação",
      },
    ],
  },
  {
    titulo: "Inventário",
    cards: [
      {
        href: "/wms/inventario",
        icon: ClipboardList,
        title: "Sessões",
        desc: "Cycle count e inventário completo",
      },
      {
        href: "/wms/inventario/metricas",
        icon: BarChart3,
        title: "Métricas",
        desc: "Acuracidade por operador e localização",
      },
    ],
  },
  {
    titulo: "Cadastros",
    cards: [
      {
        href: "/wms/produtos",
        icon: Package,
        title: "Catálogo",
        desc: "Produtos + sync com Tiny",
      },
      {
        href: "/wms/localizacoes",
        icon: MapPin,
        title: "Localizações",
        desc: "Por galpão (picking, recebimento, quarentena)",
      },
      {
        href: "/wms/fornecedores",
        icon: Truck,
        title: "Fornecedores",
        desc: "CRUD + lead times + auto-cadastro",
      },
      {
        href: "/wms/emprestimos",
        icon: Network,
        title: "Empréstimos",
        desc: "Matriz N×N + saldos devedores",
      },
    ],
  },
];

export default function WmsHome() {
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.titulo} className="space-y-2">
          <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-faint">
            {g.titulo}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {g.cards.map((c) => {
              const Icon = c.icon;
              return (
                <Link
                  key={c.href}
                  href={c.href}
                  className="group flex items-start gap-3 rounded-xl border border-line bg-paper p-4 transition-colors hover:border-ink/15 hover:bg-surface"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-ink-muted transition-colors group-hover:bg-ink group-hover:text-paper">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium text-ink">{c.title}</div>
                    <div className="text-xs text-ink-muted">{c.desc}</div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
