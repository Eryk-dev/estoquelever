import type { Cenario, Ctx } from "../_harness/types";
import { HttpError } from "../_harness/http";

// P005 — Aprovar enfileira de forma durável (RPC wms_aprovar_e_enfileirar).
// Não-regressão do caminho feliz + idempotência de duplo-clique:
//   (a) pedido transiciona pra executando + decisao_final correta
//   (b) EXATAMENTE 1 job lancar_estoque (não 0 = sem estado-fantasma, não 2)
//   (c) 2ª aprovação NÃO duplica job.
//
// NOTA DE DIVERGÊNCIA DO PLANO: o plano esperava a 2ª aprovação responder 200
// (RPC dedupa). Na rota real, porém, há um guard ANTERIOR à RPC
// (`pedido.status !== 'pendente' → 409`) — então o duplo-clique via HTTP é
// rejeitado com 409 (o pedido já saiu de 'pendente' na 1ª). A idempotência que
// importa — NÃO criar 2º job, NÃO corromper estado — se sustenta nos dois
// caminhos. A dedup explícita da RPC é provada no nível de RPC pelo teste de
// integração aprovar-enfileirar-rpc (caso "2ª chamada não duplica job").

export default {
  nome: "84 — Aprovar enfileira duravel (P005)",
  descricao:
    "Aprovação de transferência transiciona o pedido e enfileira lancar_estoque na mesma tx (durável, sem estado-fantasma). Duplo-clique não duplica job.",
  tags: ["pedido", "transferencia", "fila", "durabilidade", "P005"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("84d");
    await ctx.criarProduto({ sku, descricao: "Filtro 84d" });
    // saldo em SP → NetAir (CWB) vende → roteia transferência
    await ctx.semearSaldo({ produto: sku, galpao: "SP", loc: "C-01-01", qty: 4 });
    // pedidoId é preenchido no run (assertEsperado recebe ESTE objeto, não o
    // retorno do run — o harness passa setupData pras 3 fases).
    return { sku, pedidoId: "" };
  },

  run: async (ctx, setup) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku: setup.sku, qty: 2 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente", { decisao: "transferencia" });
    await ctx.aprovar(pedido.id, "transferencia");
    setup.pedidoId = pedido.id;
  },

  assertEsperado: async (ctx, setup) => {
    const { pedidoId } = setup;

    // (a) pedido transicionou pra executando + decisao_final
    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .select("status, decisao_final")
      .eq("id", pedidoId)
      .single();
    if ((ped as { status: string }).status !== "executando") {
      throw new Error(`status ${(ped as { status: string }).status} != executando`);
    }
    if ((ped as { decisao_final: string }).decisao_final !== "transferencia") {
      throw new Error("decisao_final != transferencia");
    }

    // (b) EXATAMENTE 1 job lancar_estoque (não 0 = sem estado-fantasma, não 2)
    const { data: jobs } = await ctx.sb
      .from("siso_fila_execucao")
      .select("id, tipo, status")
      .eq("pedido_id", pedidoId)
      .eq("tipo", "lancar_estoque");
    if ((jobs ?? []).length !== 1) {
      throw new Error(`esperava 1 job, achou ${(jobs ?? []).length}`);
    }

    // (c) duplo-clique: 2ª aprovação é rejeitada (409 — guard de status já-não-
    // pendente) e NÃO cria 2º job.
    let status2 = 0;
    try {
      await ctx.http.post("/api/wms/pedidos/aprovar", {
        pedidoId,
        decisao: "transferencia",
      });
      status2 = 200;
    } catch (e) {
      if (e instanceof HttpError) status2 = e.status;
      else throw e;
    }
    if (status2 !== 409) {
      throw new Error(`2ª aprovação retornou ${status2} (esperava 409 — guard status)`);
    }
    const { data: jobs2 } = await ctx.sb
      .from("siso_fila_execucao")
      .select("id")
      .eq("pedido_id", pedidoId)
      .eq("tipo", "lancar_estoque");
    if ((jobs2 ?? []).length !== 1) {
      throw new Error(`duplo-clique criou ${(jobs2 ?? []).length} jobs`);
    }
  },
} satisfies Cenario<{ sku: string; pedidoId: string }>;

import { runStandalone } from "../_harness/standalone";

// ESM-puro: roda só se invocado direto via `tsx <arquivo.ts>`.
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
