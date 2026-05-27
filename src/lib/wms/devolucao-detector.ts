/**
 * Detecta se um payload de NF representa uma devolução.
 *
 * Heurísticas (ordem importa — primeira que casa basta):
 *   1. finalidade=4 (devolução, conforme schema Tiny/SEFAZ)
 *   2. CFOP 1201/1202/5201/5202 (devolução de compra/venda)
 *   3. natureza_operacao contém "devolução" (case/diacritic insensitive)
 *   4. payload tem `nf_referenciada` com chaves preenchidas (NF referenciando outra)
 *
 * Helper centralizado em 2026-05-27 [#P6-6.32] — substitui chamadas inline
 * dispersas em webhook-processor.ts, nf-webhook-handler.ts e
 * api/wms/webhook/tiny/route.ts.
 */
interface NfPayload {
  finalidade?: string | number;
  nf_referenciada?: unknown;
  natureza_operacao?: string;
  cfop?: string;
}

export function isDevolucao(payload: NfPayload): boolean {
  if (String(payload.finalidade ?? "") === "4") return true;
  const cfop = String(payload.cfop ?? "");
  if (/^[15]20[12]$/.test(cfop)) return true;
  if (/devolu[çc][ãa]o/i.test(payload.natureza_operacao ?? "")) return true;
  if (payload.nf_referenciada && Object.keys(payload.nf_referenciada).length > 0) return true;
  return false;
}
