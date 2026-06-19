import type { Cenario, Ctx } from "../_harness/types";

interface FilaResp {
  itens: { id: number; sku_a: string; sku_b: string }[];
}
interface FichaResp {
  produto: { sku: string };
  nossoEstoquePorGalpao: Record<string, { disponivel: number }>;
  equivalentes: {
    sku: string;
    status: "sugestao" | "confirmado" | "bloqueado";
    estoquePorGalpao: Record<string, { saldo: number; reservado: number; disponivel: number }>;
  }[];
}

export default {
  nome: "70-cross-ligar-confirmar — Cross: ligar palpite → fila → confirmar → ficha (estoque do ledger)",
  descricao:
    "Operador liga duas peças (palpite=sugestao), o curador vê na fila, " +
    "confirma, e a ficha da peça passa a listar o equivalente confirmado " +
    "com o NOSSO estoque vindo do ledger (não do Tiny).",
  tags: ["cross", "equivalencia", "caderno"],

  setup: async (ctx: Ctx) => {
    const skuBase = ctx.skuUnico("70CRA");
    const skuEq = ctx.skuUnico("70CRB");
    await ctx.criarProduto({ sku: skuBase, descricao: "Cross base 70" });
    await ctx.criarProduto({ sku: skuEq, descricao: "Cross equivalente 70" });
    // Estoque do equivalente NO LEDGER (prova que a ficha lê o ledger).
    await ctx.semearSaldo({ produto: skuEq, galpao: "CWB", loc: "DEFAULT-PICKING", qty: 7 });
    return { skuBase, skuEq };
  },

  run: async (ctx, { skuBase, skuEq }) => {
    // 1. Ligar (cria palpite sugestao)
    const lig = await ctx.http.post<{ ok: boolean; id: number; criado: boolean }>(
      "/api/wms/cross/ligar",
      { sku_a: skuBase, sku_b: skuEq },
    );
    if (!lig.ok || !lig.criado) throw new Error(`ligar falhou: ${JSON.stringify(lig)}`);

    // 2. Aparece na fila de validação
    const fila = await ctx.http.get<FilaResp>("/api/wms/cross/fila");
    const naFila = fila.itens.find((i) => i.id === lig.id);
    if (!naFila) throw new Error("palpite não apareceu na fila");

    // 3. Curador confirma
    const dec = await ctx.http.post<{ ok: boolean; status: string }>(
      `/api/wms/cross/${lig.id}/decidir`,
      { acao: "confirmar" },
    );
    if (!dec.ok || dec.status !== "confirmado") throw new Error(`decidir falhou: ${JSON.stringify(dec)}`);
  },

  assertEsperado: async (ctx, { skuBase, skuEq }) => {
    const ficha = await ctx.http.get<FichaResp>(
      `/api/wms/cross/produtos/${encodeURIComponent(skuBase)}`,
    );
    const eq = ficha.equivalentes.find((e) => e.sku === skuEq);
    if (!eq) throw new Error("equivalente não aparece na ficha");
    if (eq.status !== "confirmado") throw new Error(`status esperado confirmado, veio ${eq.status}`);
    const dispCwb = eq.estoquePorGalpao?.CWB?.disponivel ?? 0;
    if (dispCwb !== 7) throw new Error(`estoque do ledger esperado 7 em CWB, veio ${dispCwb}`);

    // Saiu da fila (não é mais sugestao)
    const fila = await ctx.http.get<FilaResp>("/api/wms/cross/fila");
    if (fila.itens.some((i) => i.sku_a === [skuBase, skuEq].sort()[0] && i.sku_b === [skuBase, skuEq].sort()[1])) {
      throw new Error("par confirmado ainda aparece na fila");
    }
  },
} satisfies Cenario<{ skuBase: string; skuEq: string }>;

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
