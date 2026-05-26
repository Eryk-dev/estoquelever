import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "43 — Vendas baixa_direta split em múltiplas locs",
  descricao:
    "2 locs picking com saldo 3 cada. Venda baixa_direta de 5 unidades → split em 2 movs (3+2). Sem degradação porque total cobre.",
  tags: ["vendas", "baixa_direta", "split", "multi-loc"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("43");
    await ctx.criarProduto({ sku, descricao: "Split multi-loc 43" });
    // Duas locs picking no mesmo galpão com saldo 3 cada → total 6, vende 5.
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 3 });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-02", qty: 3 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const r = await ctx.criarVendaDireta({
      galpao: "CWB",
      empresa: "netair",
      items: [{ sku, qty: 5 }],
      modo: "baixa_direta",
    });
    if (r.degradado) {
      throw new Error(
        `venda inesperadamente degradada: ${r.motivo_degradacao} (total disponivel = 6, pediu 5)`,
      );
    }
  },

  assertEsperado: async (ctx, { sku }) => {
    // Esperado: 1 loc esgotada (3 → 0), outra parcial (3 → 1).
    // A ordem do split segue ordem das sugestoes (picking > overstock > recebimento,
    // depois maior disponivel). Como ambas são picking com saldo 3, desempata por
    // ordem de retorno do Postgres — não é determinístico, então conferimos a soma.
    const { data: rows } = await ctx.sb
      .from("siso_estoque")
      .select("localizacao_id, saldo, localizacao:siso_localizacoes!inner(codigo)")
      .eq("produto_id", await produtoIdBySku(ctx, sku))
      .eq("galpao_id", ctx.staging.galpoes.cwb.id);

    const linhas = (rows ?? []) as Array<{
      saldo: number;
      localizacao: { codigo: string } | { codigo: string }[];
    }>;
    const saldoTotal = linhas.reduce((acc, r) => acc + Number(r.saldo ?? 0), 0);
    if (saldoTotal !== 1) {
      throw new Error(
        `saldo total esperado=1 (6 seed - 5 venda), got=${saldoTotal} (linhas=${JSON.stringify(linhas)})`,
      );
    }

    // 2 movs E (seeds) + 2 movs S (split) = 4
    await ctx.assertMovsCount(sku, 4);

    // Confirma que existem exatamente 2 movs S origem=venda_manual
    const { data: movsS } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id, tipo, origem_tipo, qty")
      .eq("produto_id", await produtoIdBySku(ctx, sku))
      .eq("tipo", "S")
      .eq("origem_tipo", "venda_manual");

    const movsSaida = (movsS ?? []) as Array<{ qty: number }>;
    if (movsSaida.length !== 2) {
      throw new Error(
        `esperava 2 movs S venda_manual, got ${movsSaida.length}: ${JSON.stringify(movsSaida)}`,
      );
    }
    const qtyTotal = movsSaida.reduce((acc, m) => acc + Number(m.qty ?? 0), 0);
    if (qtyTotal !== 5) {
      throw new Error(
        `qty total das movs S esperada=5, got=${qtyTotal} (${JSON.stringify(movsSaida)})`,
      );
    }
    // Cada mov deve ser <= 3 (saldo de cada loc) e >= 1
    for (const m of movsSaida) {
      if (Number(m.qty) <= 0 || Number(m.qty) > 3) {
        throw new Error(
          `mov S com qty fora do range [1..3]: ${Number(m.qty)} (${JSON.stringify(movsSaida)})`,
        );
      }
    }
  },
} satisfies Cenario<{ sku: string }>;

// Helper: resolve produto_id pelo SKU
async function produtoIdBySku(ctx: Ctx, sku: string): Promise<string> {
  const { data } = await ctx.sb
    .from("siso_produtos")
    .select("id")
    .eq("sku", sku)
    .single();
  if (!data) throw new Error(`produto não encontrado: ${sku}`);
  return data.id as string;
}

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
