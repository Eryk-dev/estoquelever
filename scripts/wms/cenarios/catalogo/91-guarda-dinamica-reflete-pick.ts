/**
 * 91 — Guarda dinâmica: a_guardar reflete pick do recebimento
 *
 * Prova que quando um pedido consome estoque diretamente da loc de RECEBIMENTO
 * (antes do put-away ser concluído), o campo derivado a_guardar cai para refletir
 * o que ainda está fisicamente presente — enquanto qty_pendente (GENERATED) fica
 * intacto como verdade contábil.
 *
 * Fluxo:
 *   1. Receber 40 un → pendência qty_pendente=40, RECEBIMENTO saldo=40
 *   2. Webhook NetAir qty=30 → auto-aprovação (status concluido, status_separacao aguardando_separacao)
 *   3. iniciarSeparacao + bipar 30 (marcar-item) → L+S atômico no RECEBIMENTO
 *      RECEBIMENTO saldo=10 (40 − 30 consumidos pelo pick)
 *   4. GET /api/wms/guarda → pendência.a_guardar === 10, qty_pendente === 40
 */

import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "91 — Guarda dinâmica: a_guardar reflete pick do recebimento",
  descricao:
    "Recebe 40; pedido bipa 30 da loc RECEBIMENTO. Pendência qty_pendente=40 mas a_guardar=10.",
  tags: ["guarda", "a_guardar", "recebimento", "dinamico"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("91");
    await ctx.criarProduto({ sku, descricao: "Guarda dinamica 91" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // Passo 1: recebe 40 unidades → saldo chega em RECEBIMENTO, pendência qty_pendente=40
    const res = await ctx.receber({ galpao: "CWB", items: [{ sku, qty: 40 }] });
    ctx.log("pendencias criadas", { ids: res.pendencias });

    // Passo 2: pedido que vai consumir 30 diretamente do RECEBIMENTO
    // (única loc com saldo para este sku novo)
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 30 }],
    });
    ctx.log("pedido_id", { id: pedido.id });

    // Aguarda auto-aprovação (propria) + aguarda NF webhook (simula automaticamente)
    // → status_separacao = aguardando_separacao
    await ctx.aguardarStatus(pedido.id, "concluido", undefined, { timeout_ms: 10_000 });
    await ctx.aguardarStatusSeparacao(pedido.id, "aguardando_separacao", { timeout_ms: 15_000 });

    // Passo 3: pick das 30 unidades na loc de RECEBIMENTO
    // marcar-item chama wms_pick_item_atomico → L (libera R) + S (saída nf_venda)
    // Após isso: RECEBIMENTO saldo=10, reservado=0
    await ctx.iniciarSeparacao(pedido.id);
    await ctx.bipar({ pedido: pedido.id, item: sku, qty: 30 });
    await ctx.concluirSeparacao(pedido.id);
    await ctx.aguardarStatusSeparacao(pedido.id, "separado", { timeout_ms: 10_000 });
  },

  assertEsperado: async (ctx, { sku }) => {
    // Verifica saldo físico residual em RECEBIMENTO (deve ser 10 = 40 - 30 bipados)
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 10);

    // Resolve produto_id para localizar a pendência
    const { data: prod } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    if (!prod) throw new Error(`produto ${sku} não encontrado`);

    const galpaoId = ctx.staging.galpoes.cwb.id;

    // Localiza a pendência ainda ativa (pendente ou em_guarda) no DB
    const { data: dbRow } = await ctx.sb
      .from("siso_wms_pendencias_guarda")
      .select("id, qty_pendente, status")
      .eq("produto_id", prod.id)
      .eq("galpao_id", galpaoId)
      .not("status", "in", '("guardada","cancelada")')
      .order("criada_em", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!dbRow) {
      throw new Error(`pendência ativa para sku=${sku} não encontrada no DB`);
    }

    // qty_pendente (coluna GENERATED) deve estar intacto em 40
    if (Number(dbRow.qty_pendente) !== 40) {
      throw new Error(
        `qty_pendente esperado 40, recebido ${dbRow.qty_pendente} (coluna GENERATED não deve mudar)`,
      );
    }

    // Busca a lista de guarda via API para verificar a_guardar
    const resp = await ctx.http.get<{
      rows: Array<{ id: string; qty_pendente: number; a_guardar?: number; status: string }>;
    }>(`/api/wms/guarda?galpao_id=${galpaoId}`);

    const apiRow = resp.rows.find((r) => r.id === dbRow.id);
    if (!apiRow) {
      throw new Error(
        `pendência ${dbRow.id} (sku=${sku}) não aparece em /api/wms/guarda (status=${dbRow.status})`,
      );
    }

    // a_guardar deve refletir saldo disponível na loc RECEBIMENTO = 10
    // min(qty_pendente=40, saldo=10, reservado_alheio=0) = 10
    if (apiRow.a_guardar !== 10) {
      throw new Error(
        `a_guardar esperado 10 (qty_pendente=40, saldo_recebimento=10), recebido ${apiRow.a_guardar}`,
      );
    }

    ctx.log("a_guardar dinamico validado", {
      qty_pendente: apiRow.qty_pendente,
      a_guardar: apiRow.a_guardar,
    });
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
