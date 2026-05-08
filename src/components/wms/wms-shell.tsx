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
} from "lucide-react";

const linkClass =
  "px-3 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 inline-flex items-center";

export function WmsShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 flex-wrap text-sm">
        <Link href="/wms" className={linkClass}>
          <Package className="inline w-4 h-4 mr-1" /> WMS
        </Link>
        <Link href="/wms/produtos" className={linkClass}>
          Catálogo
        </Link>
        <Link href="/wms/localizacoes" className={linkClass}>
          <MapPin className="inline w-4 h-4 mr-1" /> Localizações
        </Link>
        <Link href="/wms/estoque" className={linkClass}>
          <BarChart3 className="inline w-4 h-4 mr-1" /> Estoque
        </Link>
        <Link href="/wms/ledger" className={linkClass}>
          <ScrollText className="inline w-4 h-4 mr-1" /> Ledger
        </Link>
        <span className="mx-1 text-zinc-400">·</span>
        <Link href="/wms/receber" className={linkClass}>
          <PackagePlus className="inline w-4 h-4 mr-1" /> Receber
        </Link>
        <Link href="/wms/transferir" className={linkClass}>
          <ArrowRightLeft className="inline w-4 h-4 mr-1" /> Transferir
        </Link>
        <Link href="/wms/replenishment" className={linkClass}>
          <ArrowDown className="inline w-4 h-4 mr-1" /> Replenishment
        </Link>
        <Link href="/wms/ajuste" className={linkClass}>
          <Settings2 className="inline w-4 h-4 mr-1" /> Ajuste
        </Link>
        <Link href="/wms/retroativos" className={linkClass}>
          <Clock className="inline w-4 h-4 mr-1" /> Retroativos
        </Link>
      </nav>
      <div>{children}</div>
    </div>
  );
}
