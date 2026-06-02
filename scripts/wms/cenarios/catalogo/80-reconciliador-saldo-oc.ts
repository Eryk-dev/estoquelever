import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 80 — Reconciliador FIFO: saldo chega após dois pedidos OC do mesmo SKU
 *
 * Dois pedidos OC sem estoque (p1 qty=13, p2 qty=10). Saldo de 15 chega depois.
 * FIFO estrito (p1 mais antigo): 15 cobre p1 (outstanding=13, sobra 2 < 10).
 * Esperado:
 *   - p1: decisao_final='propria', item compra_status=null,
 *         status_separacao='aguardando_nf' (reconciliador reenfileira lancar_estoque)
 *   - p2: item compra_status ainda != null (2 unidades sobrantes não cobrem os 10)
 *
 * Nota: NÃO executado — apenas typecheck.
 */

type Setup = {
  sku: string;
  // Populados durante run (assertEsperado recebe só ctx + setup)
  p1Id: string;
  p2Id: string;
};

export default {
  nome: "80 — Reconciliador FIFO: saldo cobre só o 1º OC, 2º permanece em compra",
  descricao:
    "Dois pedidos OC sem estoque. Saldo de 15 chega (FIFO): cobre p1 (13) → p1 vira própria/aguardando_nf, p2 permanece em compra (só 2 sobrantes, insuficiente para 10).",
  tags: ["reconciliador", "oc", "fifo", "compras"],

  setup: async (ctx: Ctx): Promise<Setup> => {
    const sku = ctx.skuUnico("80");
    await ctx.criarProduto({ sku, descricao: "Reconciliador FIFO 80" });
    // Sem saldo inicial — ambos os pedidos precisarão de compra.
    return { sku, p1Id: "", p2Id: "" };
  },

  run: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku } = setup;

    // ── 1. Disparar os dois webhooks ──
    const r1 = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 13 }],
    });
    const r2 = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 10 }],
    });

    // Guardar IDs no setup para assertEsperado
    setup.p1Id = r1.id;
    setup.p2Id = r2.id;

    // Sem estoque → ambos vão pra pendente (OC) após o worker processar
    await ctx.aguardarStatus(r1.id, "concluido");
    await ctx.aguardarStatus(r2.id, "concluido");

    // ── 2. FIFO determinístico: p1 mais antigo que p2 ──
    // O reconciliador ordena por criado_em; forçamos aqui para evitar empate
    // (pedidos chegam no mesmo segundo em staging).
    await ctx.sb
      .from("siso_pedidos")
      .update({ criado_em: "2026-01-01T00:00:00.000Z" })
      .eq("id", r1.id);
    await ctx.sb
      .from("siso_pedidos")
      .update({ criado_em: "2026-01-02T00:00:00.000Z" })
      .eq("id", r2.id);

    // ── 3. Aprovar ambos como OC (sem estoque no momento da aprovação) ──
    await ctx.aprovar(r1.id, "oc");
    await ctx.aprovar(r2.id, "oc");

    await ctx.aguardarStatusSeparacao(r1.id, "validacao_oc");
    await ctx.aguardarStatusSeparacao(r2.id, "validacao_oc");

    // ── 4. Semear saldo de 15 unidades → dispara reconciliador (mov E) ──
    // 15 ≥ 13 (p1) mas 15 - 13 = 2 < 10 (p2): FIFO libera só p1.
    await ctx.semearSaldo({
      produto: sku,
      galpao: "CWB",
      loc: "A-01-03",
      qty: 15,
    });

    // ── 5. Aguardar o reconciliador fire-and-forget ──
    await ctx.aguardar(2000);
  },

  assertEsperado: async (ctx: Ctx, setup: Setup): Promise<void> => {
    const { sku, p1Id, p2Id } = setup;

    // ── p1: deve ter sido devolvido ao fluxo próprio ──
    const { data: pedido1 } = await ctx.sb
      .from("siso_pedidos")
      .select("decisao_final, status_separacao")
      .eq("id", p1Id)
      .single();

    if (!pedido1) {
      throw new Error(`pedido p1 (${p1Id}) não encontrado`);
    }
    if (pedido1.decisao_final !== "propria") {
      throw new Error(
        `p1.decisao_final: esperado 'propria'; real='${pedido1.decisao_final}'`,
      );
    }
    if (pedido1.status_separacao !== "aguardando_nf") {
      throw new Error(
        `p1.status_separacao: esperado 'aguardando_nf'; real='${pedido1.status_separacao}'`,
      );
    }

    // item de p1: compra_status deve ser null (reconciliador limpou)
    const { data: item1Rows } = await ctx.sb
      .from("siso_pedido_itens")
      .select("compra_status")
      .eq("pedido_id", p1Id)
      .eq("sku", sku);
    const item1 = (item1Rows ?? [])[0] as { compra_status: string | null } | undefined;
    if (!item1) {
      throw new Error(`item de p1 (sku=${sku}) não encontrado`);
    }
    if (item1.compra_status !== null) {
      throw new Error(
        `p1 item.compra_status: esperado null; real='${item1.compra_status}'`,
      );
    }

    // ── p2: deve PERMANECER em compra (saldo residual 2 < qty 10) ──
    const { data: item2Rows } = await ctx.sb
      .from("siso_pedido_itens")
      .select("compra_status")
      .eq("pedido_id", p2Id)
      .eq("sku", sku);
    const item2 = (item2Rows ?? [])[0] as { compra_status: string | null } | undefined;
    if (!item2) {
      throw new Error(`item de p2 (sku=${sku}) não encontrado`);
    }
    if (item2.compra_status === null) {
      throw new Error(
        `p2 item.compra_status: esperado != null (ainda em compra); real=null — FIFO não deveria ter liberado p2 (só 2 unidades sobrantes para qty=10)`,
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
