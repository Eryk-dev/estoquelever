"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

interface AppShellProps {
  title: string;
  subtitle?: string;
  backHref?: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  mainClassName?: string;
  requireAdmin?: boolean;
}

export function AppShell({
  title,
  subtitle,
  backHref,
  headerRight,
  children,
  mainClassName,
  requireAdmin = false,
}: AppShellProps) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
    if (!loading && requireAdmin && user && user.cargo !== "admin") {
      router.replace("/");
    }
  }, [user, loading, requireAdmin, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <Loader2 className="h-6 w-6 animate-spin text-ink-faint" />
      </div>
    );
  }

  if (!user) return null;
  if (requireAdmin && user.cargo !== "admin") return null;

  return (
    <div className="min-h-screen bg-surface">
      <header className="sticky top-0 z-10 border-b border-line bg-paper">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          {backHref && (
            <Link
              href={backHref}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface hover:text-ink"
            >
              <ArrowLeft className="h-4 w-4" />
              Voltar
            </Link>
          )}
          <div className="flex-1">
            <h1 className="text-base font-bold tracking-tight text-ink">
              {title}
            </h1>
            {subtitle && (
              <p className="text-[11px] text-ink-faint">{subtitle}</p>
            )}
          </div>
          {headerRight && (
            <div className="flex items-center gap-2">{headerRight}</div>
          )}
        </div>
      </header>
      <main className={cn("mx-auto max-w-3xl px-4 py-6", mainClassName)}>
        {children}
      </main>
    </div>
  );
}
