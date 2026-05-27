import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "51 — Desfazer guarda parcial com qty configurável",
  descricao:
    "Recebe 50 unidades em CWB → confirma guarda de 30 em A-01-01 → desfaz apenas 10 (qty parcial). " +
    "Verifica: par S+E emitido com qty=10, pendência qty_guardada=20, saldos coerentes. I1-I7 verde.",
  tags: ["p3", "guarda", "reverse", "parcial", "b10"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("51");
    await ctx.criarProduto({ sku, descricao: "B10-51 desfazer guarda parcial" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1. Receber 50 unidades no dock RECEBIMENTO de CWB
    const { pendencias } = await ctx.receber({
      items: [{ sku, qty: 50 }],
      galpao: "CWB",
    });
    const pid = pendencias[0];

    // 2. Confirmar guarda de 30 em A-01-01
    //    Pendência resultante: qty_guardada=30, qty_pendente=20, status='pendente'
    await ctx.guardar({ pendencia_id: pid, loc_destino: "A-01-01", qty: 30 });

    // Garante que a pendência voltou pra 'pendente' (ainda tem 20 pendentes)
    await ctx.aguardarPendenciaGuarda(pid, "pendente");
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 30);
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 20);

    // 3. Desfaz apenas 10 unidades (qty parcial)
    const r = await ctx.desfazerGuarda({
      pendencia_id: pid,
      motivo: "cenário 51 desfazer parcial",
      qty: 10,
    });
    ctx.log("desfazer-guarda-parcial", { ...r });

    // Deve ter criado exatamente 2 movs forward-direction (1 par S+E)
    if (r.movsEstornadas !== 2) {
      throw new Error(
        `esperava 2 movs criadas (par S+E forward), achou ${r.movsEstornadas}`,
      );
    }
  },

  assertEsperado: async (ctx, { sku }) => {
    // Saldos após desfazer 10: A-01-01 = 30-10 = 20, RECEBIMENTO = 20+10 = 30
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 20);
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 30);

    // Pendência: qty_guardada=20, status='em_guarda' (ainda tem guardada)
    const { data: produto } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const { data: pend } = await ctx.sb
      .from("siso_wms_pendencias_guarda")
      .select("status, qty_guardada, qty_pendente")
      .eq("produto_id", (produto as { id: string }).id)
      .single();
    const pendRow = pend as {
      status: string;
      qty_guardada: number;
      qty_pendente: number;
    } | null;

    if (pendRow?.status !== "em_guarda") {
      throw new Error(
        `esperava status='em_guarda' (ainda tem qty_guardada > 0), achou ${pendRow?.status}`,
      );
    }
    if (Number(pendRow?.qty_guardada) !== 20) {
      throw new Error(
        `esperava qty_guardada=20 (30-10), achou ${pendRow?.qty_guardada}`,
      );
    }
    if (Number(pendRow?.qty_pendente) !== 30) {
      throw new Error(
        `esperava qty_pendente=30 (20 original + 10 devolvidos), achou ${pendRow?.qty_pendente}`,
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
