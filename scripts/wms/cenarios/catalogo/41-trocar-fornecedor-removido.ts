import type { Cenario, Ctx } from "../_harness/types";
import { HttpError } from "../_harness/http";

export default {
  nome: "41 — Endpoint deprecated /compras/itens/[id]/trocar-fornecedor retorna 404",
  descricao:
    "POST /api/wms/compras/itens/<id>/trocar-fornecedor foi removido. Substituido por compras-equivalencia.ts (equivalente + confirmar).",
  tags: ["compras", "deprecated", "cleanup", "P6"],

  setup: async (_ctx: Ctx) => {
    return {};
  },

  run: async (ctx) => {
    const fakeUuid = "00000000-0000-0000-0000-000000000000";
    let status = 0;
    try {
      await ctx.http.post(
        `/api/wms/compras/itens/${fakeUuid}/trocar-fornecedor`,
        { fornecedor_oc: "x" },
      );
      status = 200;
    } catch (err) {
      if (err instanceof HttpError) status = err.status;
      else throw err;
    }
    if (status !== 404) {
      throw new Error(
        `Esperava 404 (rota removida), recebi ${status}. Endpoint /trocar-fornecedor ainda existe.`,
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
