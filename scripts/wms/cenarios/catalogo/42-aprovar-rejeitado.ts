import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "42 — Aprovar com decisao='rejeitado' (botão Recusar real)",
  descricao:
    "Pedido entra pendente (sem saldo → sugestao=oc). Operador aciona Recusar: " +
    "POST /api/wms/pedidos/aprovar { decisao: 'rejeitado', motivo: ... } deve " +
    "marcar decisao_final='rejeitado' + status='cancelado' + status_separacao=null. " +
    "Sem fila, sem reservas, sem worker.",
  tags: ["pedido", "aprovar", "rejeitado", "recusar", "P6"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("42");
    await ctx.criarProduto({ sku, descricao: "Aprovar rejeitado 42" });
    // SEM saldo — webhook deve sugerir OC e ficar pendente.
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1. Webhook → pendente
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 5 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente", undefined, {
      timeout_ms: 8_000,
    });

    // 2. Operador recusa explicitamente
    const res = await ctx.http.post<{
      ok: boolean;
      pedidoId: string;
      decisao: string;
    }>("/api/wms/pedidos/aprovar", {
      pedidoId: pedido.id,
      decisao: "rejeitado",
      motivo: "no stock anywhere",
    });

    if (!res?.ok || res.decisao !== "rejeitado") {
      throw new Error(
        `Resposta inesperada de /aprovar rejeitado: ${JSON.stringify(res)}`,
      );
    }

    // 3. Verifica estado no DB
    const { data: dbRow, error } = await ctx.sb
      .from("siso_pedidos")
      .select("decisao_final, status, status_separacao")
      .eq("id", pedido.id)
      .single();
    if (error) throw error;
    if (!dbRow) throw new Error("pedido sumiu após rejeitar");

    if (dbRow.decisao_final !== "rejeitado") {
      throw new Error(
        `decisao_final esperava 'rejeitado', recebi '${dbRow.decisao_final}'`,
      );
    }
    if (dbRow.status !== "cancelado") {
      throw new Error(
        `status esperava 'cancelado', recebi '${dbRow.status}'`,
      );
    }
    if (dbRow.status_separacao !== null) {
      throw new Error(
        `status_separacao esperava NULL, recebi '${dbRow.status_separacao}'`,
      );
    }
  },

  assertEsperado: async (_ctx, _state) => {
    // Sem saldo afetado — não houve mov no ledger.
    // Cenário valida só state machine do pedido + ausência de fila/reserva.
  },
} satisfies Cenario<{ sku: string }>;

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
