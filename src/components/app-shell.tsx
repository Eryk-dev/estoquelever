"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { AppHeader } from "@/components/app-header";
import { getGalpaoAccent } from "@/lib/domain-helpers";
import { cn } from "@/lib/utils";

interface AppShellProps {
  title: string;
  subtitle?: React.ReactNode;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  mainClassName?: string;
  requireAdmin?: boolean;
}

export function AppShell({
  title,
  subtitle,
  headerRight,
  children,
  mainClassName,
  requireAdmin = false,
}: AppShellProps) {
  const { user, loading, activeGalpaoNome } = useAuth();
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

  const accent = getGalpaoAccent(activeGalpaoNome);

  return (
    <div className="min-h-screen bg-surface">
      <AppHeader
        title={title}
        subtitle={subtitle}
        accentColor={accent.color}
        rightSlot={headerRight}
      />
      <main className={cn("mx-auto max-w-5xl px-3 sm:px-4 py-4 sm:py-6", mainClassName)}>
        {children}
      </main>
    </div>
  );
}
