import { randomUUID } from "crypto";
import type { Cenario, Ctx } from "../_harness/types";

/**
 * P3 #8.10 — receberTransferencia anti-race (conditional UPDATE).
 *
 * 2 operadores chamando POST /transferencias/[id]/receber em paralelo:
 * sem o lock, ambos passariam validação de status='em_transito', ambos
 * inseririam movs E no destino (saldo dobrado), e o último UPDATE de
 * status='recebida' venceria silenciosamente.
 *
 * Fix: UPDATE condicional reivindica o header via
 * `recebimento_em_andamento_por`. Loser → 409 com
 * code='TRANSFERENCIA_OUTRO_RECEBIMENTO'.
 *
 * Simulação (igual cenário 40d): patch direto no banco fingindo que outro
 * operador já reivindicou + tenta a rota → deve levar 409.
 */
export default {
  nome: "48b — receberTransferencia anti-race (conditional UPDATE)",
  descricao:
    "Cria transferência CWB→SP, simula outro operador reivindicando o recebimento via patch direto. POST /receber deve falhar com 409 + code='TRANSFERENCIA_OUTRO_RECEBIMENTO' + recebimento_em_andamento_por apontando pro outro op. Sem o lock, o 2º insert de mov E criaria saldo duplicado em SP.",
  tags: ["p3", "transferencia", "race", "guard"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("48b");
    await ctx.criarProduto({ sku, descricao: "P3-48b receber transferência race" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 5, custo: 10 });
    await ctx.criarLocalizacao({ galpao: "SP", codigo: "A-01-01", tipo: "picking" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1) Cria transferência CWB→SP (gera S na CWB/A-01-01, 5 unidades).
    //    Saldo em CWB sai pra 0, saldo em SP destino ainda em 0.
    const { id: transferenciaId } = await ctx.criarTransferenciaHeader({
      origem: "CWB",
      destino: "SP",
      items: [{ sku, loc_origem: "A-01-01", qty: 5 }],
    });

    const { data: itens } = await ctx.sb
      .from("siso_transferencia_galpao_itens")
      .select("id")
      .eq("transferencia_id", transferenciaId);
    if (!itens || itens.length !== 1) {
      throw new Error(`esperava 1 item, achou ${itens?.length ?? 0}`);
    }
    const itemId = (itens[0] as { id: string }).id;

    // 2) Cria 2º usuário sintético "outro-op" só pra ter um UUID válido pro race.
    const outroOpNome = `outro-op-48b-${randomUUID().slice(0, 8)}`;
    const { data: u, error: uErr } = await ctx.sb
      .from("siso_usuarios")
      .insert({
        nome: outroOpNome,
        pin: "0000",
        cargo: "operador",
        ativo: true,
      })
      .select("id")
      .single();
    if (uErr || !u) throw new Error(`setup: criar outro-op: ${uErr?.message}`);
    const outroOpId = (u as { id: string }).id;

    // 3) Simula o race: patch direto fingindo que outroOp já reivindicou.
    //    Em prod isso aconteceria entre o SELECT e o UPDATE de uma chamada
    //    concorrente. Status permanece 'em_transito' (lock é transient,
    //    não muda status).
    const { error: patchErr } = await ctx.sb
      .from("siso_transferencias_galpao")
      .update({ recebimento_em_andamento_por: outroOpId })
      .eq("id", transferenciaId);
    if (patchErr) throw new Error(`setup: patch race: ${patchErr.message}`);

    // 4) test-runner tenta /receber — deve falhar com 409 + code +
    //    recebimento_em_andamento_por apontando pro outroOpId.
    // Resolve loc destino id pra montar o body.
    const galpaoSp = (await ctx.sb
      .from("siso_galpoes")
      .select("id")
      .eq("nome", "SP")
      .single()).data as { id: string };
    const locDestino = (await ctx.sb
      .from("siso_localizacoes")
      .select("id")
      .eq("galpao_id", galpaoSp.id)
      .eq("codigo", "A-01-01")
      .single()).data as { id: string };

    let erro: Error | null = null;
    try {
      await ctx.http.post(
        `/api/wms/transferencias/${transferenciaId}/receber`,
        {
          itens: [
            {
              transferencia_item_id: itemId,
              localizacao_destino_id: locDestino.id,
            },
          ],
        },
      );
    } catch (e) {
      erro = e as Error;
    }
    if (!erro) {
      throw new Error("/receber deveria ter falhado com 409 mas não falhou");
    }
    if (!/409/.test(erro.message)) {
      throw new Error(`/receber falhou mas não com 409: ${erro.message}`);
    }
    if (!/TRANSFERENCIA_OUTRO_RECEBIMENTO/.test(erro.message)) {
      throw new Error(
        `/receber falhou com 409 mas sem code=TRANSFERENCIA_OUTRO_RECEBIMENTO: ${erro.message}`,
      );
    }
    if (!erro.message.includes(outroOpId)) {
      throw new Error(
        `/receber 409 mas sem recebimento_em_andamento_por=${outroOpId} no body: ${erro.message}`,
      );
    }

    // 5) Saldo em SP destino tem que continuar zero — nenhuma mov E foi
    //    criada pelo test-runner (race perdido antes de inserir movs).
    await ctx.assertSaldo(sku, "SP", "A-01-01", 0);

    // 6) Promise.all race REAL com a MESMA identidade (test-runner). Sem
    //    o claim ESTRITO, ambos passariam o OR=usuario e dobrariam o saldo
    //    em SP. Com claim estrito (recebimento_em_andamento_por IS NULL),
    //    APENAS UM vence — o outro leva 409. Após o vencedor, saldo SP=5
    //    e mov_entrada_id está setado; nenhuma 3ª chamada pode entrar.
    await ctx.sb
      .from("siso_transferencias_galpao")
      .update({ recebimento_em_andamento_por: null })
      .eq("id", transferenciaId);

    const body = {
      itens: [
        {
          transferencia_item_id: itemId,
          localizacao_destino_id: locDestino.id,
        },
      ],
    };
    const results = await Promise.allSettled([
      ctx.http.post(`/api/wms/transferencias/${transferenciaId}/receber`, body),
      ctx.http.post(`/api/wms/transferencias/${transferenciaId}/receber`, body),
    ]);
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    const failCount = results.filter((r) => r.status === "rejected").length;
    ctx.log("race-paralelo-mesma-identidade", { okCount, failCount });
    if (okCount === 0) {
      throw new Error("nenhuma das 2 chamadas paralelas teve sucesso");
    }
    // CRÍTICO: pelo menos 1 chamada falhou (loser leva 409 ou 400 dependendo
    // do timing — se já flipou status='recebida', cai no path 400).
    if (failCount === 0) {
      throw new Error(
        "as 2 chamadas paralelas tiveram sucesso — claim não está estrito",
      );
    }

    return { transferenciaId, itemId, outroOpId };
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldo em SP destino == 5 (uma única entrada E, não dobrada).
    await ctx.assertSaldo(sku, "SP", "A-01-01", 5);
    // Saldo CWB origem permanece 0 (mov S já tinha saído desde criar).
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 0);

    // Header ficou em 'recebida' (happy path foi o vencedor da race).
    const { data: prod } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const produtoId = (prod as { id: string }).id;
    const { data: item } = await ctx.sb
      .from("siso_transferencia_galpao_itens")
      .select("transferencia_id, mov_entrada_id")
      .eq("produto_id", produtoId)
      .single();
    const it = item as { transferencia_id: string; mov_entrada_id: string | null };
    if (!it.mov_entrada_id) {
      throw new Error("esperava mov_entrada_id setado após recebimento bem-sucedido");
    }

    const { data: header } = await ctx.sb
      .from("siso_transferencias_galpao")
      .select("status, recebimento_em_andamento_por")
      .eq("id", it.transferencia_id)
      .single();
    const h = header as {
      status: string;
      recebimento_em_andamento_por: string | null;
    };
    if (h.status !== "recebida") {
      throw new Error(`esperava status='recebida', achou '${h.status}'`);
    }
    // Happy-path limpou o lock atomicamente.
    if (h.recebimento_em_andamento_por !== null) {
      throw new Error(
        `esperava recebimento_em_andamento_por=null após happy-path, achou '${h.recebimento_em_andamento_por}'`,
      );
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
