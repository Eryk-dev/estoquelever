/**
 * Maps SKU prefix → supplier name + default branch for purchase orders.
 * Based on the n8n workflow mapping.
 */

interface FornecedorInfo {
  fornecedor: string;
  filialOC: "CWB" | "SP";
}

const SKU_RULES: { test: (sku: string) => boolean; info: FornecedorInfo }[] = [
  { test: (s) => s.startsWith("19"), info: { fornecedor: "Diversos", filialOC: "CWB" } },
  { test: (s) => s.startsWith("EW"), info: { fornecedor: "Eletricway", filialOC: "SP" } },
  { test: (s) => s.startsWith("LD"), info: { fornecedor: "LDRU", filialOC: "SP" } },
  { test: (s) => s.startsWith("TH"), info: { fornecedor: "Tiger", filialOC: "SP" } },
  { test: (s) => s.startsWith("TG"), info: { fornecedor: "Tiger", filialOC: "SP" } },
  { test: (s) => s.startsWith("L0"), info: { fornecedor: "LEFS", filialOC: "SP" } },
  { test: (s) => s.length === 6 && /^\d+$/.test(s), info: { fornecedor: "ACA", filialOC: "CWB" } },
  { test: (s) => s.startsWith("G"), info: { fornecedor: "GAUSS", filialOC: "CWB" } },
  { test: (s) => s.startsWith("M"), info: { fornecedor: "MRMK", filialOC: "SP" } },
  { test: (s) => s.startsWith("CAK"), info: { fornecedor: "Delphi", filialOC: "SP" } },
  { test: (s) => s.startsWith("CS"), info: { fornecedor: "Delphi", filialOC: "SP" } },
];

export function getFornecedorBySku(sku: string | undefined | null): FornecedorInfo | null {
  if (!sku) return null;
  for (const rule of SKU_RULES) {
    if (rule.test(sku)) return rule.info;
  }
  return null;
}
