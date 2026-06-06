// scripts/wms/cenarios/catalogo/85-cancelar-job-fila-estorno.ts
import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 85 — estornar pedido cancela o job na fila e alinha status (P008).
 *
 * Aprova manualmente um pedido propria (enfileira lancar_estoque), estorna,
 * e assevera: job na fila → 'cancelado' E siso_pedidos.status → 'cancelado'.
 * RED hoje: estornar seta só status_separacao='cancelado' e deixa o job vivo.
 */
type Setup = { sku: string; pedidoId: string; jobId: string };

export default {
  nome: "85 — estornar pedido cancela job na fila + alinha status (P008)",
  descricao:
    "Aprova propria (gera job lancar_estoque pendente), estorna o pedido. " +
    "Espera: job → cancelado E siso_pedidos.status → cancelado.",
  tags: ["estorno", "fila", "cancelamento", "P008"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("85");
    await ctx.criarProduto({ sku, descricao: "Cancel job fila 85" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-02", qty: 10 });

    // Garante que o role 'admin' tenha a perm 'pedidos.estornar'
    // (a rota exige; a perm existe no registry mas não estava no seed inicial).
    const { data: adminRole } = await ctx.sb
      .from("siso_roles")
      .select("id")
      .eq("codigo", "admin")
      .maybeSingle();
    if (adminRole) {
      await ctx.sb
        .from("siso_role_permissoes")
        .upsert(
          { role_id: (adminRole as { id: string }).id, permissao_codigo: "pedidos.estornar" },
          { onConflict: "role_id,permissao_codigo", ignoreDuplicates: true },
        );
    }

    return { sku, pedidoId: "", jobId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;

    // Cria pedido via webhook + aguarda processamento inicial.
    const { id } = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 1 }],
    });
    setup.pedidoId = id;
    // Aguarda o pedido chegar a qualquer status processado (executando ou concluido).
    await ctx.aguardar(8000);

    // Cancela todos os jobs existentes e reseta o pedido pra 'pendente' pra
    // podermos injetar um novo job pendente de forma controlada (sem kickWorker).
    await ctx.sb
      .from("siso_fila_execucao")
      .update({ status: "cancelado", atualizado_em: new Date().toISOString() })
      .eq("pedido_id", id);
    await ctx.sb
      .from("siso_pedidos")
      .update({ status: "pendente", decisao_final: "propria", status_separacao: null })
      .eq("id", id);

    // Resolve empresa e galpão pra montar o job diretamente no banco,
    // SEM chamar aprovar/kickWorker — isso garante que o job fica 'pendente'
    // enquanto fazemos o estorno.
    const { data: pedidoRow } = await ctx.sb
      .from("siso_pedidos")
      .select("empresa_origem_id, separacao_galpao_id")
      .eq("id", id)
      .single();
    const row = pedidoRow as { empresa_origem_id: string | null; separacao_galpao_id: string | null };

    const { data: jobInserted, error: jobErr } = await ctx.sb
      .from("siso_fila_execucao")
      .insert({
        pedido_id: id,
        tipo: "lancar_estoque",
        filial_execucao: "CWB",
        empresa_id: row.empresa_origem_id,
        decisao: "propria",
        status: "pendente",
        tentativas: 0,
        max_tentativas: 3,
        prioridade: false,
      })
      .select("id")
      .single();
    if (jobErr) throw new Error(`85: falha ao inserir job na fila: ${jobErr.message}`);
    setup.jobId = (jobInserted as { id: string }).id;

    // Estorna o pedido (admin) — deve cancelar o job pendente e alinhar status.
    await ctx.http.post(`/api/wms/pedidos/${id}/estornar`, { motivo: "teste cancelamento job fila" });
    await ctx.aguardar(500);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { pedidoId, jobId } = setup;

    const { data: pedido } = await ctx.sb
      .from("siso_pedidos")
      .select("status")
      .eq("id", pedidoId)
      .single();
    if ((pedido as { status: string }).status !== "cancelado") {
      throw new Error(`P008: esperava siso_pedidos.status='cancelado', got '${(pedido as { status: string }).status}'`);
    }

    if (jobId) {
      const { data: job } = await ctx.sb
        .from("siso_fila_execucao")
        .select("status")
        .eq("id", jobId)
        .single();
      const st = (job as { status: string }).status;
      if (st !== "cancelado" && st !== "concluido") {
        throw new Error(`P008: job ${jobId} ficou '${st}', esperava 'cancelado' (worker pode ter drenado antes → 'concluido' aceito)`);
      }
    }
  },
} satisfies Cenario<Setup>;

import { runStandalone } from "../_harness/standalone";
const _isMain = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
