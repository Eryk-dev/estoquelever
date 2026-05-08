"use client";
import Link from "next/link";
import { Package, MapPin, BarChart3, ScrollText } from "lucide-react";

const cards = [
  {
    href: "/wms/produtos",
    icon: Package,
    title: "Catálogo de produtos",
    desc: "Buscar, criar, sincronizar com Tiny",
  },
  {
    href: "/wms/localizacoes",
    icon: MapPin,
    title: "Localizações",
    desc: "Configurar prateleiras por galpão",
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
];

export default function WmsHome() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {cards.map((c) => (
        <Link
          key={c.href}
          href={c.href}
          className="block p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900"
        >
          <c.icon className="w-5 h-5 mb-2" />
          <div className="font-medium">{c.title}</div>
          <div className="text-sm text-zinc-500">{c.desc}</div>
        </Link>
      ))}
    </div>
  );
}
