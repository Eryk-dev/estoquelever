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
} from "lucide-react";

const linkClass =
  "px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 inline-flex items-center text-xs";
const sep = <span className="mx-1 text-zinc-400">·</span>;

export function WmsShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 flex-wrap text-sm items-center">
        <Link href="/wms" className={linkClass}>
          <Package className="inline w-3.5 h-3.5 mr-1" /> WMS
        </Link>
        <Link href="/wms/dashboard" className={linkClass}>
          <LayoutDashboard className="inline w-3.5 h-3.5 mr-1" /> Dashboard
        </Link>
        {sep}
        <span className="text-xs text-zinc-500 px-1">Visibilidade</span>
        <Link href="/wms/estoque" className={linkClass}>
          <BarChart3 className="inline w-3.5 h-3.5 mr-1" /> Estoque
        </Link>
        <Link href="/wms/ledger" className={linkClass}>
          <ScrollText className="inline w-3.5 h-3.5 mr-1" /> Ledger
        </Link>
        <Link href="/wms/cobertura" className={linkClass}>
          <TrendingUp className="inline w-3.5 h-3.5 mr-1" /> Cobertura
        </Link>
        {sep}
        <span className="text-xs text-zinc-500 px-1">Operação</span>
        <Link href="/wms/receber" className={linkClass}>
          <PackagePlus className="inline w-3.5 h-3.5 mr-1" /> Receber
        </Link>
        <Link href="/wms/transferir" className={linkClass}>
          <ArrowRightLeft className="inline w-3.5 h-3.5 mr-1" /> Transferir
        </Link>
        <Link href="/wms/replenishment" className={linkClass}>
          <ArrowDown className="inline w-3.5 h-3.5 mr-1" /> Replenishment
        </Link>
        <Link href="/wms/ajuste" className={linkClass}>
          <Settings2 className="inline w-3.5 h-3.5 mr-1" /> Ajuste
        </Link>
        <Link href="/wms/devolucoes" className={linkClass}>
          <Undo2 className="inline w-3.5 h-3.5 mr-1" /> Devoluções
        </Link>
        <Link href="/wms/troca-sku" className={linkClass}>
          <Replace className="inline w-3.5 h-3.5 mr-1" /> Troca SKU
        </Link>
        <Link href="/wms/retroativos" className={linkClass}>
          <Clock className="inline w-3.5 h-3.5 mr-1" /> Retroativos
        </Link>
        {sep}
        <span className="text-xs text-zinc-500 px-1">Inventário</span>
        <Link href="/wms/inventario" className={linkClass}>
          <ClipboardList className="inline w-3.5 h-3.5 mr-1" /> Sessões
        </Link>
        <Link href="/wms/inventario/metricas" className={linkClass}>
          Métricas
        </Link>
        {sep}
        <span className="text-xs text-zinc-500 px-1">Cadastros</span>
        <Link href="/wms/produtos" className={linkClass}>
          Catálogo
        </Link>
        <Link href="/wms/localizacoes" className={linkClass}>
          <MapPin className="inline w-3.5 h-3.5 mr-1" /> Localizações
        </Link>
        <Link href="/wms/fornecedores" className={linkClass}>
          <Truck className="inline w-3.5 h-3.5 mr-1" /> Fornecedores
        </Link>
        <Link href="/wms/emprestimos" className={linkClass}>
          <Network className="inline w-3.5 h-3.5 mr-1" /> Empréstimos
        </Link>
      </nav>
      <div>{children}</div>
    </div>
  );
}
