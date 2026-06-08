import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 85 — Varredura/reconciliação pós-entrada é DURÁVEL (P082, P149).
 *
 * Pedido OC parado em `validacao_oc` (sem saldo). Estoque entra no galpão MAS a
 * varredura/reconciliação inline NÃO recupera o pedido (no real: falha de banco
 * transitória no write do ledger — fire-and-forget só logava e desistia). Aqui
 * modelamos esse estado com `semearSaldo`, que insere o saldo via RPC crua
 * (sem o gancho TS inline) — o pedido fica preso exatamente como ficaria após
 * uma falha transitória da varredura inline.
 *
 * A durabilidade (P082/P149) é o job na fila que o caminho de fallback enfileira
 * (`varredura_pos_entrada`). Este cenário injeta esse job durável e drena o
 * worker, asseverando que ele RECUPERA o pedido preso.
 *
 * RED (worker antigo, pré-dispatch): `executeJob` lança "Tipo de job
 *   desconhecido: varredura_pos_entrada" → job vira 'erro', pedido segue preso
 *   em validacao_oc → o mecanismo durável não existe.
 * GREEN (worker novo): o dispatch roda varredura + reconciliação → o pedido
 *   destrava (validacao_oc → aguardando_nf) ou ao menos recebe flag_saldo_apareceu.
 */

type Setup = { sku: string; pedidoId: string };

export default {
  nome: "85 — varredura/reconciliação pós-entrada é durável (P082, P149)",
  descricao:
    "Pedido OC preso em validacao_oc com saldo já no galpão (inline não recuperou). " +
    "O job durável varredura_pos_entrada na fila, drenado pelo worker, recupera o pedido.",
  tags: ["reconciliador", "varredura", "durabilidade", "fila", "retry", "P082", "P149"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("85d");
    await ctx.criarProduto({ sku, descricao: "Varredura durável 85" });
    // Sem saldo inicial — pedido precisará de compra → OC.
    return { sku, pedidoId: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;

    // 1. Pedido OC sem saldo → pós F1 (auto-OC): webhook auto-aprova e seta validacao_oc.
    const r = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 5 }],
    });
    setup.pedidoId = r.id;
    // Aguarda validacao_oc setada pelo worker (sem passar por pendente).
    await ctx.aguardarStatusSeparacao(r.id, "validacao_oc", { timeout_ms: 15_000 });

    // 2. Levar o pedido ao estado real "preso em validacao_oc":
    //    item em compra (oc_pendente) + status_separacao=validacao_oc. Montamos via
    //    DB direto (o caminho de compras que normalmente transiciona pra validacao_oc
    //    é ortogonal a este cenário e fica fora do escopo da durabilidade).
    const galpaoId = ctx.staging.galpoes.cwb.id;
    await ctx.sb
      .from("siso_pedidos")
      .update({ status: "executando", decisao_final: "oc", status_separacao: "validacao_oc", separacao_galpao_id: galpaoId })
      .eq("id", r.id);
    await ctx.sb
      .from("siso_pedido_itens")
      .update({ compra_status: "oc_pendente", compra_quantidade_solicitada: 5, compra_solicitada_em: new Date().toISOString() })
      .eq("pedido_id", r.id)
      .eq("sku", sku);
    await ctx.aguardarStatusSeparacao(r.id, "validacao_oc", { timeout_ms: 10000 });

    // 3. Estoque entra numa loc de PICKING via RPC crua (semearSaldo NÃO dispara
    //    o gancho TS inline). Modela o estado pós-falha-transitória da varredura:
    //    o saldo está lá, mas o pedido nunca foi recuperado inline.
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-03", qty: 5 });

    // Sanidade: o pedido continua preso (nada destravou inline).
    const { data: pre } = await ctx.sb
      .from("siso_pedidos")
      .select("status_separacao")
      .eq("id", r.id)
      .single();
    if ((pre as { status_separacao: string }).status_separacao !== "validacao_oc") {
      throw new Error(
        `85 setup inválido: pedido já saiu de validacao_oc antes do job durável (${(pre as { status_separacao: string }).status_separacao})`,
      );
    }

    // 4. Caminho de fallback (P082/P149): enfileira o job durável que a varredura
    //    inline enfileira quando falha. Resolve produto/galpão/loc pro payload.
    const { data: prod } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: loc } = await ctx.sb
      .from("siso_localizacoes")
      .select("id")
      .eq("galpao_id", galpaoId)
      .eq("codigo", "A-01-03")
      .single();
    const { error: jobErr } = await ctx.sb.from("siso_fila_execucao").insert({
      pedido_id: "MAINT",
      tipo: "varredura_pos_entrada",
      filial_execucao: "MAINT",
      decisao: "manutencao",
      status: "pendente",
      max_tentativas: 3,
      payload: {
        produto_id: (prod as { id: string }).id,
        galpao_id: galpaoId,
        localizacao_id: (loc as { id: string }).id,
      },
    });
    if (jobErr) throw new Error(`85: falha ao enfileirar job durável: ${jobErr.message}`);

    // 5. Drena o worker (síncrono). RED: worker antigo joga "tipo desconhecido"
    //    → job 'erro', pedido segue preso. GREEN: dispatch recupera o pedido.
    await ctx.http.post("/api/wms/worker/processar?limit=20");
    await ctx.aguardar(1500);
    // Drena qualquer lancar_estoque que a reconciliação tenha enfileirado, pra
    // não deixar a fila suja pro invariante.
    await ctx.aguardarFilaVazia({ timeout_ms: 20000 });
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { pedidoId } = setup;

    const { data: pedido } = await ctx.sb
      .from("siso_pedidos")
      .select("status_separacao, flag_saldo_apareceu")
      .eq("id", pedidoId)
      .single();
    const p = pedido as { status_separacao: string; flag_saldo_apareceu: boolean | null };

    const destravado = p.status_separacao !== "validacao_oc";
    const flagged = p.flag_saldo_apareceu === true;

    if (!destravado && !flagged) {
      throw new Error(
        "P082/P149: job durável varredura_pos_entrada NÃO recuperou o pedido — " +
          "segue preso em validacao_oc sem flag_saldo_apareceu. " +
          "O mecanismo durável (worker dispatch da varredura/reconciliação) não funcionou.",
      );
    }
  },
} satisfies Cenario<Setup>;

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
