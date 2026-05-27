import { randomUUID } from "crypto";
import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "40d — iniciarGuarda anti-race (conditional UPDATE)",
  descricao:
    "POST /api/wms/guarda/[id]/iniciar quando a pendência já foi reivindicada por outro operador retorna 409 + code='PENDENCIA_OUTRA_GUARDA' + iniciada_por. Sem o UPDATE condicional, o 2º operador sobrescreveria silenciosamente iniciada_por.",
  tags: ["p3", "guarda", "race", "guard"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("40d");
    await ctx.criarProduto({ sku, descricao: "P3-40d iniciarGuarda race" });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // 1) Recebimento cria 1 pendência em status='pendente'.
    const res = await ctx.receber({ galpao: "CWB", items: [{ sku, qty: 5 }] });
    const pendencia_id = res.pendencias[0];
    if (!pendencia_id) throw new Error("setup: pendência não criada");

    // 2) Cria um 2º usuário sintético "outro-op" (PIN único) só pra ter
    //    um UUID válido pra simular o race. Não precisa fazer login —
    //    usamos só o id pra patch no banco.
    const outroOpNome = `outro-op-${randomUUID().slice(0, 8)}`;
    const { data: u, error: uErr } = await ctx.sb
      .from("siso_usuarios")
      .insert({
        nome: outroOpNome,
        pin: "0000",
        cargo: "operador",
        ativo: true,
      })
      .select("id")
      .single();
    if (uErr || !u) throw new Error(`setup: criar outro-op: ${uErr?.message}`);
    const outroOpId = (u as { id: string }).id;

    // 3) Simula o race: PATCH direto na pendência marcando que outro
    //    operador já reivindicou (status='em_guarda', iniciada_por=outroOpId).
    //    Em prod isso aconteceria entre o SELECT e o UPDATE de uma chamada
    //    concorrente. O test-runner agora bate na rota e DEVE levar 409.
    const { error: patchErr } = await ctx.sb
      .from("siso_wms_pendencias_guarda")
      .update({
        status: "em_guarda",
        iniciada_em: new Date().toISOString(),
        iniciada_por: outroOpId,
      })
      .eq("id", pendencia_id);
    if (patchErr) throw new Error(`setup: patch race: ${patchErr.message}`);

    // 4) test-runner tenta /iniciar — deve falhar com 409 + code +
    //    iniciada_por apontando pro outroOpId.
    let erro: Error | null = null;
    try {
      await ctx.http.post(`/api/wms/guarda/${pendencia_id}/iniciar`);
    } catch (e) {
      erro = e as Error;
    }
    if (!erro) {
      throw new Error("/iniciar deveria ter falhado com 409 mas não falhou");
    }
    if (!/409/.test(erro.message)) {
      throw new Error(`/iniciar falhou mas não com 409: ${erro.message}`);
    }
    if (!/PENDENCIA_OUTRA_GUARDA/.test(erro.message)) {
      throw new Error(
        `/iniciar falhou com 409 mas sem code=PENDENCIA_OUTRA_GUARDA: ${erro.message}`,
      );
    }
    if (!erro.message.includes(outroOpId)) {
      throw new Error(
        `/iniciar 409 mas sem iniciada_por=${outroOpId} no body: ${erro.message}`,
      );
    }

    // 5) Idempotência: outro-op chamando /iniciar de novo (simulado via
    //    patch + re-call) NÃO deve sobrescrever — mas como o test-runner
    //    sempre é quem bate na rota, isso vira: forçamos iniciada_por
    //    pro test-runner e chamamos /iniciar; deve passar (idempotente).
    const testRunnerId = await (async () => {
      const { data } = await ctx.sb
        .from("siso_usuarios")
        .select("id")
        .eq("nome", process.env.TEST_RUNNER_NOME ?? "test-runner")
        .single();
      return (data as { id: string }).id;
    })();
    await ctx.sb
      .from("siso_wms_pendencias_guarda")
      .update({ iniciada_por: testRunnerId })
      .eq("id", pendencia_id);

    // Re-chamada do MESMO operador deve ser idempotente (200, sem erro).
    await ctx.http.post(`/api/wms/guarda/${pendencia_id}/iniciar`);

    return { pendencia_id, outroOpId, testRunnerId };
  },

  assertEsperado: async (ctx, { sku }) => {
    // Pega a pendência criada.
    const { data: prod } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const produtoId = (prod as { id: string }).id;
    const { data: pendRow } = await ctx.sb
      .from("siso_wms_pendencias_guarda")
      .select("id, status, iniciada_por")
      .eq("produto_id", produtoId)
      .order("criada_em", { ascending: false })
      .limit(1)
      .single();
    const row = pendRow as { id: string; status: string; iniciada_por: string | null };

    // Status precisa ser 'em_guarda' (a re-chamada idempotente do test-runner
    // manteve em_guarda).
    if (row.status !== "em_guarda") {
      throw new Error(
        `esperava status='em_guarda' depois da idempotência, achou '${row.status}'`,
      );
    }
    // iniciada_por precisa ser EXATAMENTE um UUID — não há sobrescrita
    // silenciosa. O valor final é o test-runner (último patch + idempotente).
    if (!row.iniciada_por) {
      throw new Error("esperava iniciada_por preenchido, achou NULL");
    }
    const { data: tr } = await ctx.sb
      .from("siso_usuarios")
      .select("id")
      .eq("nome", process.env.TEST_RUNNER_NOME ?? "test-runner")
      .single();
    const testRunnerId = (tr as { id: string }).id;
    if (row.iniciada_por !== testRunnerId) {
      throw new Error(
        `esperava iniciada_por=test-runner (${testRunnerId}), achou '${row.iniciada_por}' — UPDATE condicional não funcionou`,
      );
    }

    // Saldo continua intocado (nenhuma mov de guarda foi confirmada).
    await ctx.assertSaldo(sku, "CWB", "RECEBIMENTO", 5);
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
