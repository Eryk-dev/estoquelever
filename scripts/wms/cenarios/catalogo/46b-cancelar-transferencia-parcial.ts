import type { Cenario, Ctx } from "../_harness/types";

/**
 * P3 #8.3 — Cancelar transferência inter-galpão com **recebimento parcial**.
 *
 * Contexto: o schema só conhece status ∈ {'em_transito','recebida','cancelada'}.
 * `receberTransferencia` é atômico (recebe todos itens ou rejeita), então o
 * cenário "header=em_transito + item já recebido" só nasce de:
 *   - race entre recebimento + cancelamento;
 *   - undo de recebimento que deixou estado intermediário;
 *   - manipulação direta no banco (operador power-user, migration).
 *
 * Esse cenário **simula** esse estado manipulando o DB:
 *   1) Cria transferência CWB→SP de 6 unidades.
 *   2) Recebe normal (header='recebida', item.mov_entrada_id setado).
 *   3) Força header de volta pra 'em_transito' via UPDATE direto, MANTENDO
 *      mov_entrada_id (e o saldo no destino SP) — simula recebimento parcial.
 *   4) Cancela. Deve estornar leg E (SP) **e** leg S (CWB), zerando ambos
 *      saldos, e retornar `itensComRecebimentoParcial=1`.
 *
 * Cobertura adicional:
 *   - Tenta cancelar uma transferência já recebida (status='recebida') →
 *     deve rejeitar com mensagem apontando pra /desfazer-recebimento.
 *   - Cancelar 2x na mesma transferência → 2ª chamada falha (status='cancelada').
 */
export default {
  nome: "46b — Cancelar transferência com recebimento parcial estorna E + S",
  descricao:
    "Cria transferência CWB→SP, recebe e força header pra em_transito (simula parcial). Cancelar estorna leg E (SP=0) e leg S (CWB=6 restaurado). Cancelar /recebida/ rejeita com hint pra /desfazer-recebimento.",
  tags: ["p3", "transferencia", "reverse", "cancelar", "idempotencia"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("46b");
    await ctx.criarProduto({ sku, descricao: "P3-46b cancelar transf parcial" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 6, custo: 10 });
    // Garante loc destino existe em SP
    await ctx.criarLocalizacao({ galpao: "SP", codigo: "A-01-01", tipo: "picking" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // ── Parte A — Tentar cancelar uma /recebida/ rejeita com hint ──
    {
      const skuExtra = ctx.skuUnico("46b-rec");
      await ctx.criarProduto({ sku: skuExtra, descricao: "P3-46b rejeição /recebida/" });
      await ctx.semearSaldo({ produto: skuExtra, galpao: "CWB", loc: "A-01-01", qty: 3, custo: 10 });

      const { id: idRecebida } = await ctx.criarTransferenciaHeader({
        origem: "CWB",
        destino: "SP",
        items: [{ sku: skuExtra, loc_origem: "A-01-01", qty: 3 }],
      });

      const { data: itens } = await ctx.sb
        .from("siso_transferencia_galpao_itens")
        .select("id")
        .eq("transferencia_id", idRecebida);
      const itemId = (itens![0] as { id: string }).id;

      await ctx.receberTransferencia({
        transferencia_id: idRecebida,
        itens: [{ transferencia_item_id: itemId, loc_destino: "A-01-01" }],
      });

      let erroRecebida: Error | null = null;
      try {
        await ctx.http.post(`/api/wms/transferencias/${idRecebida}/cancelar`, {});
      } catch (e) {
        erroRecebida = e as Error;
      }
      if (!erroRecebida) {
        throw new Error("cancelar /recebida/ deveria ter falhado");
      }
      if (!/desfazer-recebimento|recebida/i.test(erroRecebida.message)) {
        throw new Error(
          `cancelar /recebida/ falhou mas mensagem não indica desfazer-recebimento: ${erroRecebida.message}`,
        );
      }
      ctx.log("cancelar /recebida/ rejeitado", { msg: erroRecebida.message });

      // Desfaz pra deixar o estado limpo (caso contrário fica saldo travado em SP).
      await ctx.desfazerRecebimentoTransferencia({
        transferencia_id: idRecebida,
        motivo: "limpando estado da Parte A do cenário 46b",
      });
      // E cancela agora que está em em_transito
      await ctx.http.post<{ ok: boolean }>(
        `/api/wms/transferencias/${idRecebida}/cancelar`,
        {},
      );
    }

    // ── Parte B — Cancelar transferência com recebimento parcial ──
    const { id: transferenciaId } = await ctx.criarTransferenciaHeader({
      origem: "CWB",
      destino: "SP",
      items: [{ sku, loc_origem: "A-01-01", qty: 6 }],
    });

    // Saldo CWB já foi (S na criação)
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 0);

    const { data: itens } = await ctx.sb
      .from("siso_transferencia_galpao_itens")
      .select("id")
      .eq("transferencia_id", transferenciaId);
    if (!itens || itens.length !== 1) {
      throw new Error(`esperava 1 item, achou ${itens?.length ?? 0}`);
    }
    const itemId = (itens[0] as { id: string }).id;

    // 1) Recebe (gera E em SP, header → 'recebida')
    await ctx.receberTransferencia({
      transferencia_id: transferenciaId,
      itens: [{ transferencia_item_id: itemId, loc_destino: "A-01-01" }],
    });
    await ctx.assertSaldo(sku, "SP", "A-01-01", 6);

    // 2) Força header de volta pra 'em_transito' (simula parcial)
    //    — mantém mov_entrada_id setado e saldo SP=6.
    //    Em produção, esse estado nasce de race/migration; o cenário simula
    //    direto pra exercer o caminho parcial do cancelarTransferencia.
    const { error: errSimul } = await ctx.sb
      .from("siso_transferencias_galpao")
      .update({ status: "em_transito", recebida_em: null, recebida_por: null })
      .eq("id", transferenciaId);
    if (errSimul) {
      throw new Error(`falha ao simular estado parcial: ${errSimul.message}`);
    }

    // 3) Cancela — deve estornar leg E (SP→0) + leg S (CWB→6 restaurado)
    const r = await ctx.http.post<{
      ok: boolean;
      movsEstornadas: number;
      itensComRecebimentoParcial: number;
    }>(`/api/wms/transferencias/${transferenciaId}/cancelar`, {});
    ctx.log("cancelar parcial result", r);

    if (r.itensComRecebimentoParcial !== 1) {
      throw new Error(
        `esperava itensComRecebimentoParcial=1, achou ${r.itensComRecebimentoParcial}`,
      );
    }
    if (r.movsEstornadas !== 2) {
      throw new Error(
        `esperava movsEstornadas=2 (E + S), achou ${r.movsEstornadas}`,
      );
    }

    // 4) Idempotência: 2ª chamada deve falhar (header agora 'cancelada')
    let erro2: Error | null = null;
    try {
      await ctx.http.post(`/api/wms/transferencias/${transferenciaId}/cancelar`, {});
    } catch (e) {
      erro2 = e as Error;
    }
    if (!erro2) {
      throw new Error("2ª chamada de /cancelar deveria ter falhado");
    }
  },

  assertEsperado: async (ctx, { sku }) => {
    // CWB origem: leg S estornada → saldo restaurado pra 6
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 6);
    // SP destino: leg E estornada → saldo volta pra 0
    await ctx.assertSaldo(sku, "SP", "A-01-01", 0);

    // Header status='cancelada', cancelada_em != null
    const { data: produto } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const produtoId = (produto as { id: string }).id;

    const { data: itens } = await ctx.sb
      .from("siso_transferencia_galpao_itens")
      .select("transferencia_id, mov_entrada_id, localizacao_destino_id, mov_estorno_id, mov_saida_id")
      .eq("produto_id", produtoId);
    if (!itens || itens.length === 0) {
      throw new Error("itens não encontrados");
    }
    const item = itens[0] as {
      transferencia_id: string;
      mov_entrada_id: string | null;
      localizacao_destino_id: string | null;
      mov_estorno_id: string | null;
      mov_saida_id: string | null;
    };

    // Itens com recebimento parcial: mov_entrada_id + localizacao_destino_id resetam
    if (item.mov_entrada_id !== null) {
      throw new Error(`esperava mov_entrada_id=null após cancelar parcial, achou ${item.mov_entrada_id}`);
    }
    if (item.localizacao_destino_id !== null) {
      throw new Error(`esperava localizacao_destino_id=null após cancelar parcial, achou ${item.localizacao_destino_id}`);
    }
    if (item.mov_estorno_id === null) {
      throw new Error("esperava mov_estorno_id setado (audit da leg S estornada)");
    }
    if (item.mov_saida_id === null) {
      throw new Error("mov_saida_id não deveria ser null (audit preservado)");
    }

    const { data: header } = await ctx.sb
      .from("siso_transferencias_galpao")
      .select("status, cancelada_em")
      .eq("id", item.transferencia_id)
      .single();
    const h = header as { status: string; cancelada_em: string | null };
    if (h.status !== "cancelada") {
      throw new Error(`esperava status='cancelada', achou ${h.status}`);
    }
    if (h.cancelada_em === null) {
      throw new Error("esperava cancelada_em != null");
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
