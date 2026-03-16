"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList, PackageSearch, ShoppingCart, Settings, LogOut } from "lucide-react";
import Link from "next/link";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { CARGO_LABELS } from "@/types";
import { cn } from "@/lib/utils";

interface Module {
  id: string;
  href: string;
  title: string;
  subtitle: string;
  description: string;
  icon: typeof ClipboardList;
  color: string;
  soon?: boolean;
}

const MODULES: Module[] = [
  {
    id: "siso",
    href: "/siso",
    title: "SISO",
    subtitle: "Separação de Ordens",
    description:
      "Processamento e aprovação de pedidos entre filiais, com sugestão automática de decisão.",
    icon: ClipboardList,
    color: "var(--color-info)",
  },
  {
    id: "separacao",
    href: "/separacao",
    title: "Separação",
    subtitle: "Agregador por Galpão",
    description:
      "Separação física com scan de itens, localização correta por galpão e impressão automática de etiquetas.",
    icon: PackageSearch,
    color: "var(--color-positive)",
  },
  {
    id: "compras",
    href: "/compras",
    title: "Compras",
    subtitle: "Ordens de Compra",
    description:
      "Pedidos sem estoque agrupados por fornecedor para formular ordens de compra rapidamente.",
    icon: ShoppingCart,
    color: "var(--color-caution)",
  },
];

interface DashboardCounts {
  siso: number;
  separacao: number;
  compras: number;
}

export default function HomePage() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const [counts, setCounts] = useState<DashboardCounts | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

  // Fetch module counts
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    async function fetchCounts() {
      try {
        const res = await sisoFetch("/api/dashboard/counts");
        if (res.ok && !cancelled) {
          setCounts(await res.json());
        }
      } catch {
        // silent — badge is optional
      }
    }

    fetchCounts();
    const interval = setInterval(fetchCounts, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [user]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-faint border-t-ink" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <header className="border-b border-line bg-paper">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <div className="flex-1">
            <h1 className="text-base font-bold tracking-tight text-ink">
              SISO Platform
            </h1>
            <p className="text-[11px] text-ink-faint">
              Gestão de Pedidos & Separação
            </p>
          </div>
          <div className="flex items-center gap-2">
            {user.cargo === "admin" && (
              <Link
                href="/configuracoes"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
                title="Configurações"
              >
                <Settings className="h-4 w-4" />
              </Link>
            )}
            <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5">
              <span className="font-mono text-xs font-semibold text-ink">
                {user.nome}
              </span>
              <span className="text-[10px] text-ink-faint">
                {CARGO_LABELS[user.cargo]}
              </span>
            </div>
            <button
              type="button"
              onClick={logout}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink"
              title="Sair"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Module cards */}
      <main className="mx-auto max-w-3xl px-4 py-8">
        <p className="mb-5 text-sm text-ink-muted">
          Selecione um módulo para começar:
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {MODULES.map((mod) => {
            const Icon = mod.icon;
            const count = counts?.[mod.id as keyof DashboardCounts] ?? 0;
            return (
              <Link
                key={mod.id}
                href={mod.soon ? "#" : mod.href}
                aria-disabled={mod.soon}
                className={cn(
                  "group relative flex flex-col gap-3 rounded-xl border border-line bg-paper p-5 transition-all",
                  mod.soon
                    ? "pointer-events-none opacity-50"
                    : "hover:border-ink-faint hover:shadow-sm active:scale-[0.98]",
                )}
              >
                {mod.soon && (
                  <span className="absolute right-3 top-3 rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-faint">
                    Em breve
                  </span>
                )}
                {count > 0 && (
                  <span className="absolute right-3 top-3 flex h-6 min-w-6 items-center justify-center rounded-full bg-red-500 px-1.5 font-mono text-[11px] font-bold text-white shadow-sm">
                    {count > 99 ? "99+" : count}
                  </span>
                )}
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-lg"
                  style={{
                    backgroundColor: `color-mix(in srgb, ${mod.color} 12%, transparent)`,
                    color: mod.color,
                  }}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-ink">{mod.title}</h2>
                  <p className="text-xs text-ink-muted">{mod.subtitle}</p>
                </div>
                <p className="text-xs leading-relaxed text-ink-faint">
                  {mod.description}
                </p>
              </Link>
            );
          })}
        </div>
      </main>
    </div>
  );
}
