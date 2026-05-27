import type { Cenario, Ctx } from "../_harness/types";

/**
 * P3 #8.8: replenishment intra-galpão deve ser atômico.
 *
 * Pré-RPC (cenário falharia): leg 1 (S) commitava primeiro, leg 2 (E) lançava
 * erro depois (FK violation na loc destino inexistente) — mas a mov S já
 * tinha sido persistida. Saldo "evaporava".
 *
 * Pós-RPC: `wms_replenishment_intra_galpao` envolve par S+E na mesma transação
 * plpgsql; RAISE EXCEPTION na leg 2 dispara rollback automático. Zero movs no
 * ledger, saldo intacto na origem.
 *
 * Estratégia: passar `localizacao_destino_id` = UUID que NÃO existe em
 * `siso_localizacoes`. O FK `siso_estoque_localizacao_id_fkey` faz a leg 2
 * (INSERT na siso_estoque com loc inexistente) explodir. Como leg 1 e leg 2
 * estão na mesma transação da RPC, leg 1 é desfeita.
 */
export default {
  nome: "44 — Replenishment atômico (rollback quando leg E falha)",
  descricao:
    "Quando a 2ª perna (E destino) falha, a 1ª (S origem) também rola back. Zero movs criadas, saldo origem intacto.",
  tags: ["p3", "replenishment", "atomico", "rollback"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("44");
    await ctx.criarProduto({ sku, descricao: "P3-44 Replenishment rollback" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 10, custo: 10 });

    // Resolve IDs pra usar via HTTP cru — não usamos ctx.replenishment porque
    // queremos passar um destino_id forjado.
    const { data: prod } = await ctx.sb.from("siso_produtos").select("id").eq("sku", sku).single();
    const { data: orig } = await ctx.sb
      .from("siso_localizacoes")
      .select("id")
      .eq("galpao_id", ctx.staging.galpoes.cwb.id)
      .eq("codigo", "A-01-01")
      .single();

    // UUID v4 sintaticamente válido mas que NÃO existe em siso_localizacoes →
    // FK siso_estoque_localizacao_id_fkey explode na 2ª perna.
    const destinoForjado = "00000000-0000-4000-a000-000000000044";

    // Snapshot pré-tentativa: quantas movs existem pro produto?
    const { count: movsPre } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id", { count: "exact", head: true })
      .eq("produto_id", prod!.id);

    return {
      sku,
      produtoId: prod!.id,
      galpaoCwbId: ctx.staging.galpoes.cwb.id,
      locOrigemId: orig!.id,
      locDestinoForjado: destinoForjado,
      movsPre: movsPre ?? 0,
    };
  },

  run: async (ctx, { produtoId, galpaoCwbId, locOrigemId, locDestinoForjado }) => {
    let erro: Error | null = null;
    try {
      await ctx.http.post("/api/wms/replenishment", {
        galpao_id: galpaoCwbId,
        localizacao_origem_id: locOrigemId,
        localizacao_destino_id: locDestinoForjado,
        itens: [{ produto_id: produtoId, qty: 5 }],
      });
    } catch (e) {
      erro = e as Error;
    }
    if (!erro) {
      throw new Error(
        "POST replenishment com destino inexistente deveria ter falhado (FK violation), mas passou",
      );
    }
    // Esperamos 400 (route wrap em wmsErrorResponse). Mensagem do PG menciona
    // foreign key / fkey.
    if (!/400/.test(erro.message)) {
      throw new Error(`esperava HTTP 400, achou: ${erro.message}`);
    }
  },

  assertEsperado: async (ctx, { sku, produtoId, movsPre }) => {
    // Saldo origem precisa estar EXATAMENTE em 10 (seed). Se a leg S tivesse
    // sido persistida sem rollback, saldo cairia pra 5.
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 10);

    // Contagem total de movs do produto não pode ter crescido. Seed gera 1 mov
    // E inicial; a tentativa de replenishment não pode somar nada.
    const { count: movsPos } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id", { count: "exact", head: true })
      .eq("produto_id", produtoId);
    if ((movsPos ?? 0) !== movsPre) {
      throw new Error(
        `esperava count(movs) inalterado (${movsPre}), achou ${movsPos ?? 0} — rollback falhou`,
      );
    }

    // Zero movs com origem_tipo='transferencia_localizacao' pro produto.
    const { count: transfMovs } = await ctx.sb
      .from("siso_movimentacoes")
      .select("id", { count: "exact", head: true })
      .eq("produto_id", produtoId)
      .eq("origem_tipo", "transferencia_localizacao");
    if ((transfMovs ?? 0) !== 0) {
      throw new Error(
        `esperava 0 movs origem_tipo=transferencia_localizacao, achou ${transfMovs ?? 0}`,
      );
    }
  },
} satisfies Cenario<{
  sku: string;
  produtoId: string;
  galpaoCwbId: string;
  locOrigemId: string;
  locDestinoForjado: string;
  movsPre: number;
}>;

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
