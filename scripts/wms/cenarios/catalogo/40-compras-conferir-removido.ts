import type { Cenario, Ctx } from "../_harness/types";
import { HttpError } from "../_harness/http";

export default {
  nome: "40 — Endpoint deprecated /compras/conferir retorna 404",
  descricao:
    "POST /api/wms/compras/conferir foi removido. Qualquer cliente legado deve receber 404 (não 200 silencioso).",
  tags: ["compras", "deprecated", "cleanup", "P6"],

  setup: async (_ctx: Ctx) => {
    return {};
  },

  run: async (ctx) => {
    let status = 0;
    try {
      await ctx.http.post("/api/wms/compras/conferir", {});
      status = 200;
    } catch (err) {
      if (err instanceof HttpError) status = err.status;
      else throw err;
    }
    if (status !== 404) {
      throw new Error(
        `Esperava 404 (rota removida), recebi ${status}. Endpoint /api/wms/compras/conferir ainda existe.`,
      );
    }
  },

  assertEsperado: async (_ctx) => {
    // Sem efeito colateral esperado — endpoint não existe mais.
  },
} satisfies Cenario<Record<string, never>>;

import { runStandalone } from "../_harness/standalone";

// ESM-puro: roda só se invocado direto via `tsx <arquivo.ts>`.
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
