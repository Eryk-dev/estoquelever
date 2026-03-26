/**
 * Maps SKU prefix → supplier name + default galpão for purchase orders.
 *
 * Prefixes are tried longest-first (3 chars, then 2) so that e.g. "MAN"
 * (Multiqualita) is matched before "MA" could ever be ambiguous.
 */

interface FornecedorInfo {
  fornecedor: string;
  /** Galpão name where this supplier's OC should be placed */
  filialOC: string;
}

const DEFAULT: FornecedorInfo = { fornecedor: "Diversos", filialOC: "CWB" };

const PREFIX_MAP: Record<string, FornecedorInfo> = {
  // ── Diversos ──
  "19": { fornecedor: "Diversos", filialOC: "CWB" },

  // ── Tiger (SP) ──
  "EW": { fornecedor: "Tiger", filialOC: "SP" },
  "TG": { fornecedor: "Tiger", filialOC: "SP" },

  // ── LDRU (SP) ──
  "LD": { fornecedor: "LDRU", filialOC: "SP" },

  // ── LEFS (SP) ──
  "L0": { fornecedor: "LEFS", filialOC: "SP" },

  // ── GAUSS (CWB) ──
  "GB": { fornecedor: "GAUSS", filialOC: "CWB" },
  "GE": { fornecedor: "GAUSS", filialOC: "CWB" },
  "GS": { fornecedor: "GAUSS", filialOC: "CWB" },
  "GI": { fornecedor: "GAUSS", filialOC: "CWB" },

  // ── MRMK (SP) ──
  "MK": { fornecedor: "MRMK", filialOC: "SP" },
  "M0": { fornecedor: "MRMK", filialOC: "SP" },
  "B0": { fornecedor: "MRMK", filialOC: "SP" },

  // ── Delphi (SP) ──
  "CAK": { fornecedor: "Delphi", filialOC: "SP" },
  "CS":  { fornecedor: "Delphi", filialOC: "SP" },

  // ── Kintop (SP) ──
  "KT": { fornecedor: "Kintop", filialOC: "SP" },

  // ── Multiqualita (CWB) ──
  "MQ":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "APX": { fornecedor: "Multiqualita", filialOC: "CWB" },
  "WDC": { fornecedor: "Multiqualita", filialOC: "CWB" },
  "AT":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "FD":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "FI":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "GM":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "HO":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "HY":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "KI":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "MAN": { fornecedor: "Multiqualita", filialOC: "CWB" },
  "MB":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "NI":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "PG":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "RN":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "SC":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "TO":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "UN":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "VO":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "VW":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "AG":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "BI":  { fornecedor: "Multiqualita", filialOC: "CWB" },
  "BA":  { fornecedor: "Multiqualita", filialOC: "CWB" },
};

/** Sorted descending by length so longest prefixes match first */
const SORTED_PREFIXES = Object.keys(PREFIX_MAP).sort((a, b) => b.length - a.length);

export function getFornecedorBySku(sku: string | undefined | null): FornecedorInfo {
  if (!sku) return DEFAULT;
  const upper = sku.toUpperCase();

  for (const prefix of SORTED_PREFIXES) {
    if (upper.startsWith(prefix)) return PREFIX_MAP[prefix];
  }

  // 6-digit all-numeric → ACA
  if (upper.length === 6 && /^\d+$/.test(upper)) {
    return { fornecedor: "ACA", filialOC: "CWB" };
  }

  return DEFAULT;
}
