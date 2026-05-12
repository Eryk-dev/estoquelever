/**
 * Feature flags do Plano 2 (cutover WMS).
 *
 * Lidas via `process.env` — settabis em .env.local pra dev/staging,
 * ou via Vercel env vars pra cada ambiente em prod.
 */

/**
 * Quando true, webhook-processor lê estoque de siso_estoque (não Tiny),
 * e execution-worker grava saídas via wms_inserir_movimentacao (não
 * lancarEstoqueNota / movimentarEstoque).
 *
 * Tipicamente combinada com TINY_DISABLED=true em staging.
 */
export function wmsAsSource(): boolean {
  return process.env.WMS_AS_SOURCE === "true";
}
