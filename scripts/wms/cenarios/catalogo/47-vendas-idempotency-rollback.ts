import type { Cenario, Ctx } from "../_harness/types";

/**
 * P3 #7.7 — Idempotência de vendas distingue pedido vivo vs cancelado.
 *
 * Hoje o lookup por `idempotency_key` retorna QUALQUER pedido com a key,
 * inclusive cancelados. Isso bloqueia recovery após cancelamento — re-tentar
 * com a mesma key sempre devolve o pedido cancelado.
 *
 * Fix: filtra `.neq("status", "cancelado")` no lookup. Resultado:
 *   - Pedido vivo com a key → retorna existente (idempotente).
 *   - Apenas pedido cancelado com a key → cria novo (rollback recovery).
 *
 * Fluxo:
 *   1. Semear saldo CWB/A-01-08 = 30 (cobre 3 vendas de qty=3).
 *   2. criarVendaDireta(key='abc') → pedido_id_1 (idempotente=undefined).
 *   3. cancelarVenda(pedido_id_1) → status='cancelado'.
 *   4. criarVendaDireta(key='abc') → DEVE criar novo pedido_id_2 ≠ pedido_id_1.
 *   5. criarVendaDireta(key='def') → pedido_id_3.
 *   6. criarVendaDireta(key='def') de novo → DEVE devolver pedido_id_3
 *      (idempotente=true).
 *
 * assertEsperado:
 *   - pedido_id_2 ≠ pedido_id_1.
 *   - pedido_id_3 == pedido_id_3' (re-attempt retorna o mesmo).
 *   - Total pedidos com key 'abc' = 2 (um cancelado, um ativo).
 *   - Total pedidos com key 'def' = 1.
 */
export default {
  nome: "47 — Vendas idempotency rollback (key livre após cancelar)",
  descricao:
    "Lookup por idempotency_key filtra cancelados — re-tentar mesma key após cancelamento cria novo pedido.",
  tags: ["vendas", "idempotency", "cancelar", "rollback", "p3"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("47");
    await ctx.criarProduto({ sku, descricao: "Idempotency rollback 47" });
    // 3 vendas de qty=3 (uma cancelada com estorno + duas ativas) cabem em 30,
    // mas a venda 1 cancelada estorna sua S antes da venda 2 (saldo recuperado).
    // Vendas idempotentes (key='def') compartilham o mesmo pedido — uma só S.
    // Total consumido: 3 (cancelada estornada) + 3 (key='abc' nova) + 3 (key='def') = 9
    // Saldo final esperado: 30 - 9 + 3 (estornado) = 24.
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-08", qty: 30 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const keyAbc = `cen47-abc-${Date.now().toString(36)}`;
    const keyDef = `cen47-def-${Date.now().toString(36)}`;

    // 1) Cria venda com key='abc' → pedido_id_1
    const v1 = await ctx.criarVendaDireta({
      galpao: "CWB",
      empresa: "netair",
      items: [{ sku, qty: 3 }],
      modo: "baixa_direta",
      idempotency_key: keyAbc,
    });
    const pedidoId1 = (v1 as unknown as { pedido_id?: string; id?: string }).pedido_id ?? v1.id;
    if (!pedidoId1) throw new Error("venda 1 sem id retornado");
    if (v1.idempotente) {
      throw new Error("primeira venda nunca pode vir idempotente=true");
    }
    ctx.log(`v1 criado: ${pedidoId1} (key=${keyAbc})`);

    // 2) Cancela pedido_id_1 — estorna mov S, libera a key
    const rCancel = await ctx.cancelarVenda({
      pedido_id: pedidoId1,
      motivo: "cenário 47 — testando rollback recovery",
    });
    if (rCancel.movsEstornadas < 1) {
      throw new Error(
        `cancelarVenda deveria estornar ≥1 mov; retornou ${JSON.stringify(rCancel)}`,
      );
    }
    ctx.log(`cancelado v1: movsEstornadas=${rCancel.movsEstornadas}`);

    // 3) Re-tenta com mesma key='abc' → DEVE criar pedido_id_2 ≠ pedido_id_1
    const v2 = await ctx.criarVendaDireta({
      galpao: "CWB",
      empresa: "netair",
      items: [{ sku, qty: 3 }],
      modo: "baixa_direta",
      idempotency_key: keyAbc,
    });
    const pedidoId2 = (v2 as unknown as { pedido_id?: string; id?: string }).pedido_id ?? v2.id;
    if (!pedidoId2) throw new Error("venda 2 sem id retornado");
    if (pedidoId2 === pedidoId1) {
      throw new Error(
        `BUG: re-tentativa devolveu pedido cancelado ${pedidoId1} em vez de criar novo`,
      );
    }
    if (v2.idempotente) {
      throw new Error(
        `BUG: v2 veio idempotente=true — deveria ser pedido novo após cancelamento`,
      );
    }
    ctx.log(`v2 criado: ${pedidoId2} (mesma key=${keyAbc}, novo pedido)`);

    // 4) Cria pedido com key='def' → pedido_id_3
    const v3 = await ctx.criarVendaDireta({
      galpao: "CWB",
      empresa: "netair",
      items: [{ sku, qty: 3 }],
      modo: "baixa_direta",
      idempotency_key: keyDef,
    });
    const pedidoId3 = (v3 as unknown as { pedido_id?: string; id?: string }).pedido_id ?? v3.id;
    if (!pedidoId3) throw new Error("venda 3 sem id retornado");
    if (v3.idempotente) {
      throw new Error("primeira venda com key='def' nunca pode vir idempotente=true");
    }
    ctx.log(`v3 criado: ${pedidoId3} (key=${keyDef})`);

    // 5) Re-tenta com mesma key='def' (sem cancelar) → DEVE devolver pedido_id_3
    const v4 = await ctx.criarVendaDireta({
      galpao: "CWB",
      empresa: "netair",
      items: [{ sku, qty: 3 }],
      modo: "baixa_direta",
      idempotency_key: keyDef,
    });
    const pedidoId4 = (v4 as unknown as { pedido_id?: string; id?: string }).pedido_id ?? v4.id;
    if (pedidoId4 !== pedidoId3) {
      throw new Error(
        `re-tentativa com key='def' viva deveria retornar mesmo pedido; got ${pedidoId4} ≠ ${pedidoId3}`,
      );
    }
    if (!v4.idempotente) {
      throw new Error(
        "re-tentativa com key viva deveria vir com idempotente=true",
      );
    }
    ctx.log(`v4 idempotente OK — devolveu mesmo pedido_id_3=${pedidoId3}`);

    // Preserva pra assertEsperado
    Object.assign(ctx as unknown as Record<string, unknown>, {
      _cen47_pedidoId1: pedidoId1,
      _cen47_pedidoId2: pedidoId2,
      _cen47_pedidoId3: pedidoId3,
      _cen47_keyAbc: keyAbc,
      _cen47_keyDef: keyDef,
    });
  },

  assertEsperado: async (ctx, { sku: _sku }) => {
    void _sku;
    const state = ctx as unknown as {
      _cen47_pedidoId1?: string;
      _cen47_pedidoId2?: string;
      _cen47_pedidoId3?: string;
      _cen47_keyAbc?: string;
      _cen47_keyDef?: string;
    };
    const { _cen47_pedidoId1, _cen47_pedidoId2, _cen47_pedidoId3, _cen47_keyAbc, _cen47_keyDef } = state;
    if (!_cen47_pedidoId1 || !_cen47_pedidoId2 || !_cen47_pedidoId3 || !_cen47_keyAbc || !_cen47_keyDef) {
      throw new Error("estado do cenário 47 não preservado entre run e assert");
    }

    // Conta pedidos por key
    const { data: pedidosAbc, error: errAbc } = await ctx.sb
      .from("siso_pedidos")
      .select("id, status")
      .eq("payload_original->>idempotency_key", _cen47_keyAbc);
    if (errAbc) throw new Error(`erro contando pedidos key='abc': ${errAbc.message}`);
    if (!pedidosAbc || pedidosAbc.length !== 2) {
      throw new Error(
        `esperado 2 pedidos com key='abc'; got ${pedidosAbc?.length ?? 0}: ${JSON.stringify(pedidosAbc)}`,
      );
    }
    const statusList = pedidosAbc.map((p) => p.status as string).sort();
    // Um deve estar cancelado, o outro deve estar concluido (baixa_direta)
    if (!statusList.includes("cancelado")) {
      throw new Error(`key='abc': nenhum pedido cancelado; statuses=${JSON.stringify(statusList)}`);
    }
    const ativos = pedidosAbc.filter((p) => (p.status as string) !== "cancelado");
    if (ativos.length !== 1) {
      throw new Error(
        `key='abc': esperado 1 pedido vivo (≠cancelado); got ${ativos.length}: ${JSON.stringify(ativos)}`,
      );
    }
    if (ativos[0].id !== _cen47_pedidoId2) {
      throw new Error(
        `key='abc' vivo deveria ser pedido_id_2=${_cen47_pedidoId2}; got ${ativos[0].id}`,
      );
    }

    const { data: pedidosDef, error: errDef } = await ctx.sb
      .from("siso_pedidos")
      .select("id, status")
      .eq("payload_original->>idempotency_key", _cen47_keyDef);
    if (errDef) throw new Error(`erro contando pedidos key='def': ${errDef.message}`);
    if (!pedidosDef || pedidosDef.length !== 1) {
      throw new Error(
        `esperado 1 pedido com key='def'; got ${pedidosDef?.length ?? 0}: ${JSON.stringify(pedidosDef)}`,
      );
    }
    if (pedidosDef[0].id !== _cen47_pedidoId3) {
      throw new Error(
        `key='def' vivo deveria ser pedido_id_3=${_cen47_pedidoId3}; got ${pedidosDef[0].id}`,
      );
    }
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
