/**
 * @deprecated Use empresa-lookup.ts instead.
 *
 * Kept as a thin wrapper for backwards compatibility during migration.
 * Maps CNPJ → branch (filial) using hardcoded values.
 */

const CNPJ_MAP: Record<string, "CWB" | "SP"> = {
  "34857388000163": "CWB",
  "34857388000244": "SP",
};

const FILIAL_NOME: Record<"CWB" | "SP", string> = {
  CWB: "NetAir",
  SP: "NetParts",
};

/** @deprecated Use getEmpresaByCnpj from empresa-lookup.ts */
export function getFilialByCnpj(cnpj: string): "CWB" | "SP" | null {
  const clean = cnpj.replace(/\D/g, "");
  return CNPJ_MAP[clean] ?? null;
}

/** @deprecated Use getEmpresaById from empresa-lookup.ts */
export function getNomeFilial(filial: "CWB" | "SP"): string {
  return FILIAL_NOME[filial];
}
