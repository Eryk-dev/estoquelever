import type { Cenario, Ctx } from "../_harness/types";

/**
 * Troca REMOTA (nível 4 do roteamento). NetAir (casa = CWB) vende SKU-A, que não
 * tem saldo em galpão nenhum. Existe um equivalente verificado (mesmo tier) SKU-B
 * com saldo SÓ em SP. Antes: caía em OC (equivalente remoto invisível). Agora:
 * pedido pendente 'troca_equivalente' separando em SP, com R reserva_troca em SP.
 * Remoto SEMPRE exige aprovação (mesmo par 'livre') — testa forcarPendente.
 */
export default {
  nome: "60 — Troca remota inter-galpão (equivalente só em SP)",
  descricao:
    "SKU-A sem saldo; equivalente verificado SKU-B só em SP → troca remota " +
    "(pendente, separa em SP, R reserva_troca em SP), em vez de OC.",
  tags: ["trocas", "troca_remota", "roteamento", "inter_galpao"],

  setup: async (ctx: Ctx) => {
    const skuA = ctx.skuUnico("60A");
    const skuB = ctx.skuUnico("60B");
    await ctx.criarProduto({ sku: skuA, descricao: "Original 60 (sem saldo)" });
    await ctx.criarProduto({ sku: skuB, descricao: "Equivalente 60 (SP)" });

    // Mesmo tier nos dois → par 'livre' localmente (remoto força pendente).
    await ctx.sb
      .from("siso_produtos")
      .update({ tier_qualidade: "primeira_linha" })
      .in("sku", [skuA, skuB]);

    // Saldo do equivalente SÓ em SP. SKU-A fica sem saldo em lugar nenhum.
    await ctx.semearSaldo({ produto: skuB, galpao: "SP", loc: "C-01-01", qty: 10 });

    // Cluster cross: catálogo OEM + link manual A↔B (siso_cross_cluster_skus
    // segue siso_produto_links). FK de links/verificadas → siso_produtos_catalogo.
    await ctx.sb.from("siso_produtos_catalogo").upsert(
      [
        { sku: skuA, nome: "Original 60" },
        { sku: skuB, nome: "Equivalente 60" },
      ],
      { onConflict: "sku" },
    );
    await ctx.sb.from("siso_produto_links").insert({ sku_a: skuA, sku_b: skuB });

    // Curadoria: par verificado (sku_a < sku_b normalizado).
    const [a, b] = [skuA, skuB].sort();
    await ctx.sb
      .from("siso_equivalencias_verificadas")
      .upsert({ sku_a: a, sku_b: b, status: "verificado" }, { onConflict: "sku_a,sku_b" });

    return { skuA, skuB };
  },

  run: async (ctx, { skuA }) => {
    const pedido = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj, // casa = CWB
      items: [{ sku: skuA, qty: 2 }],
    });
    await ctx.aguardarStatus(pedido.id, "pendente");
  },

  assertEsperado: async (ctx, { skuA, skuB }) => {
    // Pedido pendente de troca, separando no galpão REMOTO (SP).
    const { data: ped } = await ctx.sb
      .from("siso_pedidos")
      .select("id, sugestao, separacao_galpao_id")
      .eq("sugestao", "troca_equivalente")
      .order("data", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!ped) throw new Error("nenhum pedido com sugestao 'troca_equivalente'");
    if (ped.separacao_galpao_id !== ctx.staging.galpoes.sp.id) {
      throw new Error(
        `esperava separacao_galpao_id = SP (${ctx.staging.galpoes.sp.id}), recebido ${ped.separacao_galpao_id}`,
      );
    }

    // Troca pendente: vendido SKU-A → substituto SKU-B, no galpão SP.
    const { data: troca } = await ctx.sb
      .from("siso_trocas_equivalencia")
      .select("status, sku_vendido, sku_substituto, galpao_id")
      .eq("pedido_id", ped.id)
      .eq("status", "pendente")
      .maybeSingle();
    if (!troca) throw new Error("troca pendente não criada");
    if (troca.sku_vendido !== skuA || troca.sku_substituto !== skuB) {
      throw new Error(
        `par errado: ${troca.sku_vendido} → ${troca.sku_substituto} (esperado ${skuA} → ${skuB})`,
      );
    }
    if (troca.galpao_id !== ctx.staging.galpoes.sp.id) {
      throw new Error(`troca.galpao_id deveria ser SP, recebido ${troca.galpao_id}`);
    }

    // R reserva_troca segura o equivalente em SP (não em CWB).
    await ctx.assertReservado(skuB, "SP", "C-01-01", 2);
  },
} satisfies Cenario<{ skuA: string; skuB: string }>;

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
