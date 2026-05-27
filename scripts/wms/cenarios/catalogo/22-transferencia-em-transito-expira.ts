import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "22 — Transferência em_transito expira + cleanup",
  descricao:
    "Cria transferência CWB→SP com header, força expira_em pro passado, cleanup cancela e estorna a saída → saldo volta pra loc origem.",
  tags: ["transferencia", "expira_em", "cleanup", "cron"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("22");
    await ctx.criarProduto({ sku, descricao: "Transf abandonada 22" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "B-02-04", qty: 25, custo: 7 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // Resolve produto + galpões + loc origem
    const { data: prod } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const galpao_origem_id = ctx.staging.galpoes.cwb.id;
    const galpao_destino_id = ctx.staging.galpoes.sp.id;
    const { data: locOrigem } = await ctx.sb
      .from("siso_localizacoes")
      .select("id")
      .eq("galpao_id", galpao_origem_id)
      .eq("codigo", "B-02-04")
      .single();

    // Cria header via /api/wms/transferencias (essa rota faz INSERT na
    // tabela siso_transferencias_galpao + gera mov de saída na origem).
    const criada = await ctx.http.post<{ id: string }>("/api/wms/transferencias", {
      galpao_origem_id,
      galpao_destino_id,
      itens: [
        {
          produto_id: prod!.id,
          localizacao_origem_id: locOrigem!.id,
          qty: 10,
        },
      ],
      observacoes: "harness cenário 22",
    });

    // Saldo origem deve ter caído pra 15 (25 - 10).
    await ctx.assertSaldo(sku, "CWB", "B-02-04", 15);

    // Força expira_em pro passado (simulando os 7 dias passados).
    const { error: errUpd } = await ctx.sb
      .from("siso_transferencias_galpao")
      .update({ expira_em: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", criada.id);
    if (errUpd) throw new Error(`forçar expira_em: ${errUpd.message}`);

    // Chama cleanup com worker-secret.
    const res = await ctx.http.get<{ canceladas: number; erros: unknown[] }>(
      "/api/wms/transferencias/cleanup",
      { "x-worker-secret": process.env.WORKER_SECRET ?? "test-worker-secret" },
    );
    if (!res || typeof res.canceladas !== "number") {
      throw new Error(`cleanup: resposta inesperada ${JSON.stringify(res)}`);
    }
    if (res.canceladas < 1) {
      throw new Error(`cleanup: esperava canceladas >= 1, recebido ${res.canceladas}`);
    }

    // Confirma status='cancelada' na transferência.
    const { data: header } = await ctx.sb
      .from("siso_transferencias_galpao")
      .select("status, cancelada_em")
      .eq("id", criada.id)
      .single();
    if (!header) throw new Error("transferência sumiu após cleanup");
    if (header.status !== "cancelada") {
      throw new Error(`status esperado 'cancelada', recebido '${header.status}'`);
    }
    if (!header.cancelada_em) {
      throw new Error("cancelada_em deveria estar preenchido");
    }
  },

  assertEsperado: async (ctx, { sku }) => {
    // Após estorno, saldo origem volta pra 25 (15 + 10).
    await ctx.assertSaldo(sku, "CWB", "B-02-04", 25);
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
