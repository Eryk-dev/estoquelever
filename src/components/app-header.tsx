"use client";

import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface AppHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  accentColor?: string;
  rightSlot?: React.ReactNode;
  leftSlot?: React.ReactNode;
  containerClassName?: string;
  headerClassName?: string;
}

export function AppHeader({
  title,
  subtitle,
  accentColor,
  rightSlot,
  leftSlot,
  containerClassName,
  headerClassName,
}: AppHeaderProps) {
  return (
    <header
      className={cn("sticky top-0 z-10 border-b border-line bg-paper", headerClassName)}
    >
      {accentColor && (
        <div
          className="h-[2px] transition-colors duration-300"
          style={{ backgroundColor: accentColor }}
        />
      )}
      <div
        className={cn(
          "mx-auto flex min-h-[4.5rem] max-w-5xl items-center gap-3 px-3 py-3 sm:px-4 sm:py-3.5",
          containerClassName,
        )}
      >
        <Link
          href="/"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          aria-label="Voltar ao início"
        >
          <Image
            src="/logo.svg"
            alt="Estoque Lever"
            width={32}
            height={32}
            className="h-8 w-8 object-contain"
            priority
          />
        </Link>

        {leftSlot && <div className="shrink-0">{leftSlot}</div>}

        <div className="flex min-w-0 flex-1 flex-col justify-center self-stretch py-0.5">
          <h1 className="truncate text-base font-bold leading-tight tracking-tight text-ink">
            {title}
          </h1>
          {subtitle && (
            <div className="mt-0.5 min-w-0 text-xs leading-4 text-ink-faint">
              {subtitle}
            </div>
          )}
        </div>

        {rightSlot && (
          <div className="shrink-0 self-center">
            {rightSlot}
          </div>
        )}
      </div>
    </header>
  );
}
