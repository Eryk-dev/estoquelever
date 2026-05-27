import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "42 — Desfazer guarda confirmada reverte par S+E",
  descricao:
    "Recebe 10 unidades em CWB, confirma guarda total em A-01-01. Chama /desfazer → saldo em A-01-01 volta pra 0, saldo em RECEBIMENTO volta pra 10, pendência status='pendente'. 2ª chamada de /desfazer falha com 400 (idempotência).",
  tags: ["p3", "guarda", "reverse"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("42");
    await ctx.criarProduto({ sku, descricao: "P3-42 desfazer guarda" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    const { pendencias } = await ctx.receber({
      items: [{ sku, qty: 10 }],
      galpao: "CWB",
    });
    const pid = pendencias[0];
    // Confirma guarda total em A-01-01
    await ctx.guardar({ pendencia_id: pid, loc_destino: "A-01-01", qty: 10 });
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 10);

    // Desfaz
    const r = await ctx.desfazerGuarda({ pendencia_id: pid, motivo: "cenário 42" });
    ctx.log("desfazer-guarda", { ...r });
    if (r.movsEstornadas !== 2) {
      throw new Error(
        `esperava 2 movs estornadas (par S+E), achou ${r.movsEstornadas}`,
      );
    }

    // Idempotência: 2ª chamada de /desfazer falha com 400 (qty_guardada=0).
    let erro2: Error | null = null;
    try {
      await ctx.desfazerGuarda({ pendencia_id: pid, motivo: "cenário 42 - 2x" });
    } catch (e) {
      erro2 = e as Error;
    }
    if (!erro2) {
      throw new Error("2ª chamada de /desfazer deveria ter falhado mas não falhou");
    }
    if (!/400/.test(erro2.message)) {
      throw new Error(`2ª /desfazer falhou mas não com 400: ${erro2.message}`);
    }
    if (!/sem guardas/.test(erro2.message)) {
      throw new Error(
        `2ª /desfazer falhou com 400 mas sem mensagem esperada: ${erro2.message}`,
      );
    }
  },

  assertEsperado: async (ctx, { sku }) => {
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 0);
    // Saldo de volta na RECEBIMENTO
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 10);
    // Pendência deve estar status='pendente'
    const { data: produto } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: pend } = await ctx.sb
      .from("siso_wms_pendencias_guarda")
      .select("status, qty_guardada")
      .eq("produto_id", (produto as { id: string }).id)
      .single();
    const pendRow = pend as { status: string; qty_guardada: number } | null;
    if (pendRow?.status !== "pendente") {
      throw new Error(`esperava status='pendente', achou ${pendRow?.status}`);
    }
    if (Number(pendRow?.qty_guardada) !== 0) {
      throw new Error(`esperava qty_guardada=0, achou ${pendRow?.qty_guardada}`);
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
