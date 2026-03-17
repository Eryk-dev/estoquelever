import type { Decisao } from "@/types";

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

/**
 * Normalize nome_ecommerce to a canonical marketplace name.
 * E.g. "Mercado Livre - Classic" → "Mercado Livre", "Shopee - Express" → "Shopee"
 */
export function getMarketplaceName(nome: string): string {
  const lower = nome.toLowerCase();
  if (lower.includes("mercado livre")) return "Mercado Livre";
  if (lower.includes("shopee")) return "Shopee";
  if (lower.includes("amazon")) return "Amazon";
  if (lower.includes("magalu")) return "Magalu";
  return nome;
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

// ─── Galpão ────────────────────────────────────────────────────────────────

const GALPAO_COLORS: Record<string, string> = {
  CWB: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
  SP: "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
};
const DEFAULT_GALPAO_COLOR = "bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300";

export function getFilialColors(galpao: string): string {
  return GALPAO_COLORS[galpao] ?? DEFAULT_GALPAO_COLOR;
}

// ─── Localizacao (natural sort) ─────────────────────────────────────────────

/**
 * Compare two localizacao strings with natural ordering.
 * Pattern: LETTERS-NUMBER-NUMBER (e.g., "B-10-1", "AB-2-3").
 * Numeric segments are compared as numbers, not strings.
 * Nulls and non-standard formats sort to the end.
 */
export function naturalLocCompare(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  const partsA = a.split("-");
  const partsB = b.split("-");
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const pa = partsA[i];
    const pb = partsB[i];
    if (pa === undefined && pb === undefined) return 0;
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;

    const numA = parseInt(pa, 10);
    const numB = parseInt(pb, 10);
    const aIsNum = !isNaN(numA) && String(numA) === pa;
    const bIsNum = !isNaN(numB) && String(numB) === pb;

    if (aIsNum && bIsNum) {
      if (numA !== numB) return numA - numB;
    } else if (aIsNum !== bIsNum) {
      // letters before numbers
      return aIsNum ? 1 : -1;
    } else {
      // Text segments: shorter first (C before CP), then alphabetic
      if (pa.length !== pb.length) return pa.length - pb.length;
      const cmp = pa.localeCompare(pb);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
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
