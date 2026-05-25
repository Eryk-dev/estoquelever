/**
 * Feature flags do Plano 2 (cutover WMS).
 *
 * Lidas via `process.env` — settabis em .env.local pra dev/staging,
 * ou via Vercel env vars pra cada ambiente em prod.
 */

/**
 * Quando true (default desde 2026-05-25), webhook-processor lê estoque de
 * siso_estoque (não Tiny), e execution-worker grava saídas via
 * wms_inserir_movimentacao (não lancarEstoqueNota / movimentarEstoque).
 *
 * Opt-out: setar WMS_AS_SOURCE=false explicitamente pra reverter pro caminho
 * legado (Tiny como source of truth). Rollback de emergência leva ~5min:
 * setar a env var no Vercel + redeploy.
 */
export function wmsAsSource(): boolean {
  return process.env.WMS_AS_SOURCE !== "false";
}
