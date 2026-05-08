"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowDown,
  ArrowRightLeft,
  BarChart3,
  ClipboardList,
  Clock,
  LayoutDashboard,
  MapPin,
  Network,
  Package,
  PackagePlus,
  Replace,
  ScrollText,
  Settings2,
  TrendingUp,
  Truck,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { GalpaoSelector } from "@/components/galpao-selector";
import { cn } from "@/lib/utils";

interface NavGroup {
  titulo: string;
  itens: NavItem[];
}

interface NavItem {
  href: string;
  icon: LucideIcon;
  label: string;
}

const NAV_GROUPS: NavGroup[] = [
  {
    titulo: "Visibilidade",
    itens: [
      { href: "/wms/dashboard", icon: LayoutDashboard, label: "Dashboard" },
      { href: "/wms/estoque", icon: BarChart3, label: "Saldos" },
      { href: "/wms/ledger", icon: ScrollText, label: "Ledger" },
      { href: "/wms/cobertura", icon: TrendingUp, label: "Cobertura" },
    ],
  },
  {
    titulo: "Operação",
    itens: [
      { href: "/wms/receber", icon: PackagePlus, label: "Receber" },
      { href: "/wms/transferir", icon: ArrowRightLeft, label: "Transferir" },
      { href: "/wms/replenishment", icon: ArrowDown, label: "Replenishment" },
      { href: "/wms/ajuste", icon: Settings2, label: "Ajuste" },
      { href: "/wms/devolucoes", icon: Undo2, label: "Devoluções" },
      { href: "/wms/troca-sku", icon: Replace, label: "Troca SKU" },
      { href: "/wms/retroativos", icon: Clock, label: "Retroativos" },
    ],
  },
  {
    titulo: "Inventário",
    itens: [
      { href: "/wms/inventario", icon: ClipboardList, label: "Sessões" },
      { href: "/wms/inventario/metricas", icon: BarChart3, label: "Métricas" },
    ],
  },
  {
    titulo: "Cadastros",
    itens: [
      { href: "/wms/produtos", icon: Package, label: "Catálogo" },
      { href: "/wms/localizacoes", icon: MapPin, label: "Localizações" },
      { href: "/wms/fornecedores", icon: Truck, label: "Fornecedores" },
      { href: "/wms/emprestimos", icon: Network, label: "Empréstimos" },
    ],
  },
];

interface PageMeta {
  title: string;
  subtitle?: string;
}

function resolveMeta(pathname: string): PageMeta {
  const exact: Record<string, PageMeta> = {
    "/wms": { title: "WMS", subtitle: "Operações de estoque" },
    "/wms/dashboard": { title: "Dashboard", subtitle: "Eventos críticos agregados" },
    "/wms/estoque": { title: "Saldos", subtitle: "4 perspectivas: dono, galpão, localização, produto" },
    "/wms/ledger": { title: "Ledger", subtitle: "Histórico imutável de movimentações" },
    "/wms/cobertura": { title: "Cobertura", subtitle: "Dias de cobertura por giro 30d" },
    "/wms/receber": { title: "Receber", subtitle: "Recebimento com sugestão automática de putaway" },
    "/wms/transferir": { title: "Transferir", subtitle: "Inter-galpão (origem → destino)" },
    "/wms/replenishment": { title: "Replenishment", subtitle: "Intra-galpão (overstock → picking)" },
    "/wms/ajuste": { title: "Ajuste manual", subtitle: "Entrada ou saída com motivo" },
    "/wms/devolucoes": { title: "Devoluções", subtitle: "Fila pendente de classificação" },
    "/wms/troca-sku": { title: "Troca de SKU", subtitle: "Substituir SKU físico por catálogo" },
    "/wms/retroativos": { title: "Retroativos", subtitle: "Lançamentos pendentes de reconciliação" },
    "/wms/produtos": { title: "Catálogo", subtitle: "Produtos sincronizados com Tiny" },
    "/wms/localizacoes": { title: "Localizações", subtitle: "Endereços por galpão" },
    "/wms/fornecedores": { title: "Fornecedores", subtitle: "Cadastro + lead times + auto-cadastro" },
    "/wms/emprestimos": { title: "Empréstimos", subtitle: "Matriz N×N + saldos devedores" },
    "/wms/inventario": { title: "Inventário", subtitle: "Sessões de cycle count e completo" },
    "/wms/inventario/metricas": { title: "Métricas de inventário", subtitle: "Acuracidade por operador e localização" },
  };
  if (exact[pathname]) return exact[pathname];
  // Dynamic patterns
  if (/^\/wms\/devolucoes\/[^/]+$/.test(pathname)) {
    return { title: "Classificar devolução", subtitle: "Definir destino A/B/C/D" };
  }
  if (/^\/wms\/inventario\/[^/]+\/contar$/.test(pathname)) {
    return { title: "Contagem", subtitle: "Modo handheld" };
  }
  if (/^\/wms\/inventario\/[^/]+\/divergencias$/.test(pathname)) {
    return { title: "Divergências", subtitle: "Aprovar, recontar ou rejeitar" };
  }
  if (/^\/wms\/inventario\/[^/]+$/.test(pathname)) {
    return { title: "Sessão de inventário", subtitle: "Painel do supervisor" };
  }
  return { title: "WMS", subtitle: "Operações de estoque" };
}

function isActive(pathname: string, href: string): boolean {
  if (href === pathname) return true;
  // /wms/inventario should be active for /wms/inventario/[id]/* but not /wms/inventario/metricas
  if (href === "/wms/inventario") {
    return pathname.startsWith("/wms/inventario/") && !pathname.startsWith("/wms/inventario/metricas");
  }
  return pathname.startsWith(`${href}/`);
}

export function WmsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/wms";
  const meta = resolveMeta(pathname);

  return (
    <AppShell
      title={meta.title}
      subtitle={meta.subtitle}
      headerRight={<GalpaoSelector />}
      mainClassName="space-y-5"
    >
      <WmsSubNav pathname={pathname} />
      <div>{children}</div>
    </AppShell>
  );
}

function WmsSubNav({ pathname }: { pathname: string }) {
  return (
    <nav
      aria-label="Navegação WMS"
      className="-mx-3 sm:-mx-4 overflow-x-auto"
    >
      <div className="flex items-stretch gap-3 sm:gap-4 px-3 sm:px-4 pb-1">
        {NAV_GROUPS.map((grupo, idx) => (
          <div
            key={grupo.titulo}
            className={cn(
              "flex flex-col gap-1 shrink-0",
              idx > 0 && "border-l border-line pl-3 sm:pl-4",
            )}
          >
            <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
              {grupo.titulo}
            </span>
            <div className="flex items-center gap-1">
              {grupo.itens.map((item) => {
                const Icon = item.icon;
                const active = isActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                      active
                        ? "bg-ink text-paper"
                        : "text-ink-muted hover:bg-surface hover:text-ink",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </nav>
  );
}
