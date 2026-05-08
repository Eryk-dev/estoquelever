"use client";
import Link from "next/link";
import { Package, MapPin, BarChart3, ScrollText } from "lucide-react";

export function WmsShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-2 flex-wrap text-sm">
        <Link
          href="/wms"
          className="px-3 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <Package className="inline w-4 h-4 mr-1" /> WMS
        </Link>
        <Link
          href="/wms/produtos"
          className="px-3 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          Catálogo
        </Link>
        <Link
          href="/wms/localizacoes"
          className="px-3 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <MapPin className="inline w-4 h-4 mr-1" /> Localizações
        </Link>
        <Link
          href="/wms/estoque"
          className="px-3 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <BarChart3 className="inline w-4 h-4 mr-1" /> Estoque
        </Link>
        <Link
          href="/wms/ledger"
          className="px-3 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <ScrollText className="inline w-4 h-4 mr-1" /> Ledger
        </Link>
      </nav>
      <div>{children}</div>
    </div>
  );
}
