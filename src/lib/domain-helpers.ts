import type { Decisao, Filial } from "@/types";

// ─── E-commerce ─────────────────────────────────────────────────────────────

export function getEcommerceAbbr(nome: string): string {
  if (nome.toLowerCase().includes("mercado livre")) return "ML";
  if (nome.toLowerCase().includes("shopee")) return "SH";
  if (nome.toLowerCase().includes("amazon")) return "AZ";
  if (nome.toLowerCase().includes("magalu")) return "MG";
  return nome.slice(0, 2).toUpperCase();
}

export function getEcommerceColors(nome: string): string {
  if (nome.toLowerCase().includes("mercado livre"))
    return "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/60 dark:text-yellow-300";
  if (nome.toLowerCase().includes("shopee"))
    return "bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300";
  if (nome.toLowerCase().includes("amazon"))
    return "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300";
  return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
}

// ─── Decisão ────────────────────────────────────────────────────────────────

export const DECISAO_LABELS: Record<Decisao, string> = {
  propria: "Própria",
  transferencia: "Transferência",
  oc: "Ordem de Compra",
};

export function getDecisaoColors(decisao: Decisao): string {
  if (decisao === "propria") return "text-emerald-700 dark:text-emerald-400";
  if (decisao === "transferencia") return "text-blue-700 dark:text-blue-400";
  return "text-amber-700 dark:text-amber-400";
}

export function getDecisaoStripColor(decisao: Decisao): string {
  if (decisao === "propria") return "bg-emerald-500";
  if (decisao === "transferencia") return "bg-blue-500";
  return "bg-amber-500";
}

// ─── Filial ─────────────────────────────────────────────────────────────────

export function getFilialColors(filial: Filial): string {
  return filial === "CWB"
    ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
    : "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300";
}

// ─── Formatting ─────────────────────────────────────────────────────────────

export function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

export function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return "Nunca";
  const diff = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `há ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

export function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
