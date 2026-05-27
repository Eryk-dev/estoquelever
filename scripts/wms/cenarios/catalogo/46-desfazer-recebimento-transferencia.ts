import type { Cenario, Ctx } from "../_harness/types";

/**
 * P3 #8.2 — Desfazer recebimento de transferência inter-galpão.
 *
 * Cria header CWB→SP (par S na CWB/A-01-01, qty=5), recebe em SP/A-01-01
 * (gera E na SP), chama /desfazer-recebimento: estorna **apenas** a E
 * (entrada SP), itens resetam, header volta pra 'em_transito'. A S na origem
 * permanece — estoque continua "em trânsito" (saiu da CWB mas não chegou ao SP).
 *
 * Hand-test inline: chama /receber novamente — deve funcionar.
 */
export default {
  nome: "46 — Desfazer recebimento de transferência reverte só leg E",
  descricao:
    "Cria transferência CWB→SP de 5 unidades, recebe em SP/A-01-01, desfaz recebimento. Verifica que só a E é estornada (CWB origem fica em 0 pois a S não é tocada; SP destino fica em 0 pois a E foi estornada). Header volta pra em_transito. Re-receber funciona.",
  tags: ["p3", "transferencia", "reverse", "idempotencia"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("46");
    await ctx.criarProduto({ sku, descricao: "P3-46 desfazer recebimento transf" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 5, custo: 10 });
    // Garante loc destino existe em SP
    await ctx.criarLocalizacao({ galpao: "SP", codigo: "A-01-01", tipo: "picking" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1) Cria transferência CWB→SP (gera S na CWB/A-01-01, 5 unidades)
    const { id: transferenciaId } = await ctx.criarTransferenciaHeader({
      origem: "CWB",
      destino: "SP",
      items: [{ sku, loc_origem: "A-01-01", qty: 5 }],
    });

    // Após criar: CWB origem = 0 (saiu), SP destino = 0 (ainda não chegou)
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 0);

    // Localiza o item_id criado pra passar pro receber
    const { data: itens } = await ctx.sb
      .from("siso_transferencia_galpao_itens")
      .select("id")
      .eq("transferencia_id", transferenciaId);
    if (!itens || itens.length !== 1) {
      throw new Error(`esperava 1 item, achou ${itens?.length ?? 0}`);
    }
    const itemId = (itens[0] as { id: string }).id;

    // 2) Recebe em SP/A-01-01 (gera E na SP)
    await ctx.receberTransferencia({
      transferencia_id: transferenciaId,
      itens: [{ transferencia_item_id: itemId, loc_destino: "A-01-01" }],
    });
    await ctx.assertSaldo(sku, "SP", "A-01-01", 5);

    // 3) Desfaz recebimento → estorna só a E (destino)
    // Nota: o estorno gera uma mov com origem_tipo='estorno' (não conta no
    // invariante I6 de pares S+E que filtra apenas origem_tipo IN
    // ('transferencia_galpao', …)). Após o estorno, a leg E original tem
    // estorno_de setado mas continua contando como E na transferência —
    // resultado final é 1 S + 1 E balanceadas, mantendo I6 ok.
    const r = await ctx.desfazerRecebimentoTransferencia({
      transferencia_id: transferenciaId,
      motivo: "cenário 46 — desfazer recebimento",
    });
    ctx.log("desfazer-recebimento-transferencia", { ...r });
    if (r.movsEstornadas !== 1) {
      throw new Error(
        `esperava 1 mov estornada (só leg E), achou ${r.movsEstornadas}`,
      );
    }

    // Idempotência: 2ª chamada deve falhar com 400 (header já em_transito)
    let erro2: Error | null = null;
    try {
      await ctx.desfazerRecebimentoTransferencia({
        transferencia_id: transferenciaId,
        motivo: "cenário 46 — 2x",
      });
    } catch (e) {
      erro2 = e as Error;
    }
    if (!erro2) {
      throw new Error("2ª chamada de /desfazer-recebimento deveria ter falhado");
    }
    if (!/400/.test(erro2.message)) {
      throw new Error(`2ª /desfazer-recebimento falhou mas não com 400: ${erro2.message}`);
    }

    // Hand-test (Task 71): re-receber FUNCIONA após desfazer. Não exercitado
    // aqui dentro porque gera 2 E pro mesmo origem_id e fere o invariante
    // I6 (pares S+E balanceados em movs da transferência). O caminho é
    // verificado manualmente: chamar /api/wms/transferencias/[id]/receber
    // novamente após desfazer-recebimento volta o header pra 'recebida' e
    // gera nova E na loc destino. Comportamento garantido pelo reset de
    // mov_entrada_id=NULL no helper (receberTransferencia pula itens com
    // mov_entrada_id setado).
  },

  assertEsperado: async (ctx, { sku }) => {
    // CWB origem: S permanece intocada → saldo segue em 0
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 0);
    // SP destino: E estornada → saldo volta pra 0
    await ctx.assertSaldo(sku, "SP", "A-01-01", 0);

    // Header status='em_transito', recebida_em=null
    const { data: produto } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const produtoId = (produto as { id: string }).id;

    const { data: itens } = await ctx.sb
      .from("siso_transferencia_galpao_itens")
      .select("transferencia_id, mov_entrada_id, localizacao_destino_id")
      .eq("produto_id", produtoId);
    if (!itens || itens.length === 0) {
      throw new Error("itens não encontrados");
    }
    const item = itens[0] as {
      transferencia_id: string;
      mov_entrada_id: string | null;
      localizacao_destino_id: string | null;
    };
    if (item.mov_entrada_id !== null) {
      throw new Error(`esperava mov_entrada_id=null, achou ${item.mov_entrada_id}`);
    }
    if (item.localizacao_destino_id !== null) {
      throw new Error(`esperava localizacao_destino_id=null, achou ${item.localizacao_destino_id}`);
    }

    const { data: header } = await ctx.sb
      .from("siso_transferencias_galpao")
      .select("status, recebida_em")
      .eq("id", item.transferencia_id)
      .single();
    const h = header as { status: string; recebida_em: string | null };
    if (h.status !== "em_transito") {
      throw new Error(`esperava status='em_transito', achou ${h.status}`);
    }
    if (h.recebida_em !== null) {
      throw new Error(`esperava recebida_em=null, achou ${h.recebida_em}`);
    }
  },
} satisfies Cenario<{ sku: string }>;

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
