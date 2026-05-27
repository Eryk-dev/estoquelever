import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 28 — vendas/criar com galpão arbitrário popula cwb_atende/sp_atende
 * corretamente.
 *
 * Cria um galpão novo (não-CWB/SP), vincula empresa NetAir como preferencial,
 * cria 1 loc picking + saldo, e chama /api/wms/vendas/criar em baixa_direta.
 * Esperado: `cwb_atende=false, sp_atende=false` na linha de siso_pedido_itens
 * (galpão não bate com /^cwb\b/i nem /^sp\b/i).
 */
export default {
  nome: "28 — vendas/criar com galpão arbitrário popula cwb_atende/sp_atende corretamente",
  descricao:
    "Galpão novo (fora de CWB/SP) → cwb_atende/sp_atende ambos false na linha de siso_pedido_itens.",
  tags: ["vendas", "criar", "galpao-arbitrario", "p6"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("28");
    const galpaoNome = `PR-TEST-28-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const locCodigo = `PR-A-01-01-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // Cria produto
    await ctx.criarProduto({ sku, descricao: "Galpao arbitrario 28" });
    const { data: produto } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const produtoId = (produto as { id: string }).id;

    // Cria galpão novo (não-CWB/SP)
    const { data: galPR, error: galErr } = await ctx.sb
      .from("siso_galpoes")
      .insert({ nome: galpaoNome, descricao: "teste cenário 28", ativo: true })
      .select("id, nome")
      .single();
    if (galErr) throw new Error(`criar galpão: ${galErr.message}`);
    const galpaoPRId = (galPR as { id: string }).id;

    // Vincula empresa NetAir como preferencial nesse galpão
    await ctx.sb.from("siso_empresa_galpoes_preferenciais").upsert(
      {
        empresa_id: ctx.staging.empresas.netair.id,
        galpao_id: galpaoPRId,
        geo_priority: 0,
      },
      { onConflict: "empresa_id,galpao_id" },
    );

    // Cria loc picking no galpão novo
    const { data: locPR, error: locErr } = await ctx.sb
      .from("siso_localizacoes")
      .insert({
        galpao_id: galpaoPRId,
        codigo: locCodigo,
        tipo: "picking",
        ativo: true,
      })
      .select("id")
      .single();
    if (locErr) throw new Error(`criar loc: ${locErr.message}`);
    const locPRId = (locPR as { id: string }).id;

    // Semeia saldo na loc picking via ajuste direto (não usa ctx.ajusteManual
    // porque o helper só conhece CWB|SP).
    await ctx.http.post("/api/wms/ajuste", {
      tripla: {
        produto_id: produtoId,
        galpao_id: galpaoPRId,
        localizacao_id: locPRId,
      },
      qty: 5,
      direcao: "entrada",
      motivo: "seed cenário 28",
    });

    return { sku, produtoId, galpaoPRId, galpaoNome, locPRId, locCodigo };
  },

  run: async (ctx, { produtoId, galpaoPRId }) => {
    const resp = await ctx.http.post<{
      pedido_id: string;
      degradado: boolean;
      motivo_degradacao?: string;
      skus_sem_saldo?: string[];
    }>("/api/wms/vendas/criar", {
      cliente_nome: "Cliente Teste 28",
      cliente_cpf_cnpj: null,
      canal_venda: "balcao",
      empresa_origem_id: ctx.staging.empresas.netair.id,
      galpao_id: galpaoPRId,
      modo: "baixa_direta",
      items: [{ produto_id: produtoId, quantidade: 1 }],
    });
    if (!resp?.pedido_id) {
      throw new Error(`vendas/criar não retornou pedido_id: ${JSON.stringify(resp)}`);
    }

    // Carrega item recém-criado pra inspecionar cwb_atende/sp_atende.
    const { data: item, error } = await ctx.sb
      .from("siso_pedido_itens")
      .select("cwb_atende, sp_atende")
      .eq("pedido_id", resp.pedido_id)
      .maybeSingle();
    if (error) throw new Error(`select pedido_itens: ${error.message}`);
    const row = item as { cwb_atende?: boolean; sp_atende?: boolean } | null;
    if (row?.cwb_atende !== false) {
      throw new Error(
        `cwb_atende deve ser false em galpão arbitrário; real=${row?.cwb_atende}`,
      );
    }
    if (row?.sp_atende !== false) {
      throw new Error(
        `sp_atende deve ser false em galpão arbitrário; real=${row?.sp_atende}`,
      );
    }
  },

  assertEsperado: async () => {
    // Asserts já no run().
  },
} satisfies Cenario<{
  sku: string;
  produtoId: string;
  galpaoPRId: string;
  galpaoNome: string;
  locPRId: string;
  locCodigo: string;
}>;

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
