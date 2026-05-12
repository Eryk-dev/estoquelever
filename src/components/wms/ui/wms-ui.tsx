"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// ──────────────────────────────────────────────────────────────────
// Icon — replica os SVGs do design para evitar peso de uma lib extra.

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export type IconName =
  | "box"
  | "gauge"
  | "list"
  | "arrows"
  | "shuffle"
  | "rotate"
  | "history"
  | "clipboard"
  | "tag"
  | "pin"
  | "truck"
  | "handshake"
  | "search"
  | "plus"
  | "minus"
  | "arrow-right"
  | "arrow-left"
  | "chevron-r"
  | "chevron-l"
  | "chevron-d"
  | "chevron-u"
  | "check"
  | "x"
  | "alert"
  | "dot"
  | "filter"
  | "columns"
  | "edit"
  | "sparkle"
  | "building"
  | "trash"
  | "download"
  | "sliders";

export function Icon({ name, size = 14, className }: IconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
  };

  switch (name) {
    case "box":
      return (
        <svg {...common}>
          <path d="M2 4.5l6-2.5 6 2.5v7L8 14l-6-2.5v-7z" />
          <path d="M2 4.5L8 7l6-2.5" />
          <path d="M8 7v7" />
        </svg>
      );
    case "gauge":
      return (
        <svg {...common}>
          <path d="M2 10a6 6 0 0112 0" />
          <path d="M8 10l3-3" />
          <circle cx="8" cy="10" r=".8" fill="currentColor" />
        </svg>
      );
    case "list":
      return (
        <svg {...common}>
          <path d="M2 4h12M2 8h12M2 12h12" />
        </svg>
      );
    case "arrows":
      return (
        <svg {...common}>
          <path d="M3 5h9l-2-2M13 11H4l2 2" />
        </svg>
      );
    case "shuffle":
      return (
        <svg {...common}>
          <path d="M2 4h2.5L8 8l3.5-4H14" />
          <path d="M2 12h2.5L8 8M11.5 12H14" />
          <path d="M12 2l2 2-2 2M12 10l2 2-2 2" />
        </svg>
      );
    case "rotate":
      return (
        <svg {...common}>
          <path d="M14 8a6 6 0 11-1.7-4.2" />
          <path d="M14 2v3.5h-3.5" />
        </svg>
      );
    case "history":
      return (
        <svg {...common}>
          <path d="M2 8a6 6 0 106-6" />
          <path d="M2 2v3.5h3.5" />
          <path d="M8 4.5V8l2.5 1.5" />
        </svg>
      );
    case "clipboard":
      return (
        <svg {...common}>
          <rect x="3.5" y="3" width="9" height="11" rx="1.5" />
          <rect x="5.5" y="1.5" width="5" height="2.5" rx=".5" />
          <path d="M5.5 8h5M5.5 11h3" />
        </svg>
      );
    case "tag":
      return (
        <svg {...common}>
          <path d="M2 8V2h6l6 6-6 6-6-6z" />
          <circle cx="5.5" cy="5.5" r=".8" fill="currentColor" />
        </svg>
      );
    case "pin":
      return (
        <svg {...common}>
          <path d="M8 14s5-4.5 5-8A5 5 0 003 6c0 3.5 5 8 5 8z" />
          <circle cx="8" cy="6" r="1.5" />
        </svg>
      );
    case "truck":
      return (
        <svg {...common}>
          <rect x="1.5" y="4" width="8" height="6.5" rx=".5" />
          <path d="M9.5 6h3l2 2v2.5h-5" />
          <circle cx="4" cy="11.5" r="1.2" />
          <circle cx="11.5" cy="11.5" r="1.2" />
        </svg>
      );
    case "handshake":
      return (
        <svg {...common}>
          <path d="M2 8l3-3 2 2 2-2 3 3M2 8v2l3 2 3-2 3 2 3-2V8" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M8 3v10M3 8h10" />
        </svg>
      );
    case "minus":
      return (
        <svg {...common}>
          <path d="M3 8h10" />
        </svg>
      );
    case "arrow-right":
      return (
        <svg {...common}>
          <path d="M3 8h10M9 4l4 4-4 4" />
        </svg>
      );
    case "arrow-left":
      return (
        <svg {...common}>
          <path d="M13 8H3M7 4L3 8l4 4" />
        </svg>
      );
    case "chevron-r":
      return (
        <svg {...common}>
          <path d="M6 3l5 5-5 5" />
        </svg>
      );
    case "chevron-l":
      return (
        <svg {...common}>
          <path d="M10 3l-5 5 5 5" />
        </svg>
      );
    case "chevron-d":
      return (
        <svg {...common}>
          <path d="M3 6l5 5 5-5" />
        </svg>
      );
    case "chevron-u":
      return (
        <svg {...common}>
          <path d="M3 10l5-5 5 5" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="M3 8.5L6.5 12 13 4.5" />
        </svg>
      );
    case "x":
      return (
        <svg {...common}>
          <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
        </svg>
      );
    case "alert":
      return (
        <svg {...common}>
          <path d="M8 2l6.5 11.5h-13L8 2z" />
          <path d="M8 7v3M8 12v.5" />
        </svg>
      );
    case "dot":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2.5" fill="currentColor" />
        </svg>
      );
    case "filter":
      return (
        <svg {...common}>
          <path d="M2 3h12l-4.5 6v4l-3 1.5V9L2 3z" />
        </svg>
      );
    case "columns":
      return (
        <svg {...common}>
          <rect x="2" y="3" width="12" height="10" rx="1" />
          <path d="M6 3v10M10 3v10" />
        </svg>
      );
    case "edit":
      return (
        <svg {...common}>
          <path d="M11 2.5l2.5 2.5L6 12.5 3 13.5l1-3L11 2.5z" />
        </svg>
      );
    case "sparkle":
      return (
        <svg {...common}>
          <path d="M8 2v4M8 10v4M2 8h4M10 8h4" />
        </svg>
      );
    case "building":
      return (
        <svg {...common}>
          <rect x="3" y="2.5" width="10" height="11" rx=".5" />
          <path d="M6 5.5v.5M10 5.5v.5M6 8.5v.5M10 8.5v.5M7 13.5v-2h2v2" />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <path d="M3 4.5h10M5.5 4.5V3a1 1 0 011-1h3a1 1 0 011 1v1.5M4 4.5l.7 8.5h6.6L12 4.5" />
        </svg>
      );
    case "download":
      return (
        <svg {...common}>
          <path d="M8 2v9M4.5 7.5L8 11l3.5-3.5M2.5 13.5h11" />
        </svg>
      );
    case "sliders":
      return (
        <svg {...common}>
          <path d="M2 4h12M2 8h12M2 12h12" />
          <circle cx="5" cy="4" r="1.5" fill="white" />
          <circle cx="11" cy="8" r="1.5" fill="white" />
          <circle cx="6" cy="12" r="1.5" fill="white" />
        </svg>
      );
    default:
      return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// Page header

export function PageHeader({
  title,
  subtitle,
  backHref,
  backLabel,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  backHref?: string;
  backLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="wms-ph">
      <div className="wms-ph-title">
        {backHref ? (
          <a
            href={backHref}
            className="wms-link-back"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              color: "var(--wms-c-muted)",
              textDecoration: "none",
              marginBottom: 4,
            }}
          >
            <Icon name="chevron-l" size={11} />
            {backLabel ?? "Voltar"}
          </a>
        ) : null}
        <h1>{title}</h1>
        {subtitle ? <p className="wms-ph-sub">{subtitle}</p> : null}
      </div>
      {children ? <div className="wms-ph-actions">{children}</div> : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Status badges

export type StatusKey =
  | "ok"
  | "atencao"
  | "critico"
  | "lead_time_risco"
  | "sem_giro"
  | "aguardando_classificacao"
  | "classificada"
  | "aplicada"
  | "pendente"
  | "reconciliado"
  | "em_andamento"
  | "planejada"
  | "revisao"
  | "aprovada"
  | "cancelada";

const STATUS_MAP: Record<StatusKey, { label: string; cls: string }> = {
  ok: { label: "OK", cls: "ok" },
  atencao: { label: "Atenção", cls: "warn" },
  critico: { label: "Crítico", cls: "danger" },
  lead_time_risco: { label: "Sem fornec.", cls: "warn" },
  sem_giro: { label: "Sem giro", cls: "mute" },
  aguardando_classificacao: { label: "Aguardando", cls: "warn" },
  classificada: { label: "Classificada", cls: "info" },
  // Inventário: ciclo de status com 6 cores distintas.
  // planejada (cinza claro) → em_andamento (azul) → revisao (amarelo)
  // → aprovada (verde outlined) → aplicada (verde sólido) | cancelada (slate riscado).
  planejada: { label: "Planejada", cls: "mute" },
  em_andamento: { label: "Em andamento", cls: "info" },
  revisao: { label: "Revisão", cls: "warn" },
  aprovada: { label: "Aprovada", cls: "ok" },
  aplicada: { label: "Aplicada", cls: "aplicada" },
  cancelada: { label: "Cancelada", cls: "cancelada" },
  // Outros contextos
  pendente: { label: "Pendente", cls: "warn" },
  reconciliado: { label: "Reconciliado", cls: "ok" },
};

export function StatusBadge({
  status,
  size = "sm",
}: {
  status: StatusKey | string;
  size?: "sm" | "lg";
}) {
  const m = STATUS_MAP[status as StatusKey] ?? { label: status, cls: "mute" };
  return (
    <span
      className={cn(
        "wms-badge",
        `wms-badge-${m.cls}`,
        size === "lg" && "wms-badge-lg",
      )}
    >
      {m.label}
    </span>
  );
}

// Tipo de localização
export function LocTipoBadge({ tipo }: { tipo: string }) {
  const colors: Record<string, string> = {
    picking: "info",
    overstock: "mute",
    recebimento: "warn",
    expedicao: "warn",
    quarentena: "danger",
  };
  return (
    <span className={`wms-badge wms-badge-${colors[tipo] ?? "mute"}`}>
      {tipo}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────
// KPI

export function Kpi({
  label,
  value,
  sub,
  danger,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="wms-kpi">
      <div className="wms-kpi-lbl">{label}</div>
      <div className={cn("wms-kpi-val", danger && "danger")}>{value}</div>
      {sub ? <div className="wms-kpi-pct">{sub}</div> : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Card

export function Card({
  title,
  actions,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="wms-card">
      {(title || actions) && (
        <div className="wms-card-h">
          {title ? <h3>{title}</h3> : <span />}
          {actions ?? null}
        </div>
      )}
      <div className="wms-card-body">{children}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Modal

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 560,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="wms-md-overlay" onClick={onClose}>
      <div
        className="wms-md"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wms-md-hd">
          <div>
            <h3>{title}</h3>
            {subtitle ? <p className="wms-td-mute">{subtitle}</p> : null}
          </div>
          <button
            className="wms-btn-icon wms-btn-icon-lg"
            onClick={onClose}
            aria-label="Fechar"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="wms-md-body">{children}</div>
        {footer ? <div className="wms-md-ft">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="wms-field">
      <label className="wms-field-lbl">
        {label}
        {required && <span className="wms-req">*</span>}
        {hint && <span className="wms-field-hint">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Helpers de formatação

export function fmtBRL(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(n);
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "0";
  return new Intl.NumberFormat("pt-BR").format(n);
}

export function fmtDateTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${mi}`;
}

export function fmtDate(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

export function fmtRelative(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return "—";
  const now = new Date();
  const diffMin = Math.round((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `${diffMin}min atrás`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h atrás`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return `${diffD}d atrás`;
  return fmtDate(d);
}

// ──────────────────────────────────────────────────────────────────
// useAutoFocus — utilitário para inputs

export function useAutoFocus<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (active) {
      const id = setTimeout(() => ref.current?.focus(), 30);
      return () => clearTimeout(id);
    }
  }, [active]);
  return ref;
}
