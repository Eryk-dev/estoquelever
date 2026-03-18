"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import Image from "next/image";
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
    if (!loading && requireAdmin && user && !(user.cargos ?? [user.cargo]).includes("admin")) {
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
  if (requireAdmin && !(user.cargos ?? [user.cargo]).includes("admin")) return null;

  return (
    <div className="min-h-screen bg-surface">
      <header className="sticky top-0 z-10 border-b border-line bg-paper">
        <div className="mx-auto flex max-w-3xl items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3">
          <Link href="/" className="shrink-0">
            <Image
              src="/logo.svg"
              alt="Estoque Lever"
              width={28}
              height={28}
              className="h-7 w-7"
              priority
            />
          </Link>
          {backHref && (
            <Link
              href={backHref}
              className="inline-flex items-center justify-center rounded-lg p-1.5 sm:px-2 sm:py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface hover:text-ink"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline ml-1.5">Voltar</span>
            </Link>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-sm sm:text-base font-bold tracking-tight text-ink truncate">
              {title}
            </h1>
            {subtitle && (
              <p className="text-[11px] text-ink-faint truncate">{subtitle}</p>
            )}
          </div>
          {headerRight && (
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">{headerRight}</div>
          )}
        </div>
      </header>
      <main className={cn("mx-auto max-w-3xl px-3 sm:px-4 py-4 sm:py-6", mainClassName)}>
        {children}
      </main>
    </div>
  );
}
