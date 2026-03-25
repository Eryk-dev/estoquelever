/**
 * Next.js instrumentation — runs once on server startup.
 *
 * Reconciliation polling DISABLED — was pulling in old/non-marketplace
 * orders from Tiny. Can be re-enabled after proper filtering is in place.
 */

export async function register() {
  // Reconciliation disabled — see git history for previous implementation
}
