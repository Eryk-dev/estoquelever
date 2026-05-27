import type { Cenario, Ctx } from "../_harness/types";

export default {
  nome: "40c — bipar contagem sem lock da loc retorna 409",
  descricao:
    "POST /api/wms/inventario/[id]/contagens sem prévio proximaLoc (loc não está bloqueada por este operador) deve retornar 409. Sem o guard, um usuário com sessão válida injetaria contagens em sessões que nunca entrou.",
  tags: ["p3", "inventario", "contagens", "guard", "lock"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("40c");
    await ctx.criarProduto({ sku, descricao: "P3-40c contagens sem lock" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-01", qty: 5 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // Cria sessão mas NÃO chama entrarParty/proximaLoc — loc fica
    // status='pendente' e bloqueada_por=NULL.
    const sess = await ctx.criarSessaoInventario({
      galpao: "CWB",
      locs: ["A-01-01"],
      modo: "blind",
      tipo: "cycle_count",
    });

    // Resolve loc e produto pra montar o body manualmente.
    const { data: locRow } = await ctx.sb
      .from("siso_inventario_localizacoes")
      .select("localizacao_id, bloqueada_por, status")
      .eq("sessao_id", sess.id)
      .maybeSingle();
    const localizacao_id = (locRow as { localizacao_id?: string } | null)
      ?.localizacao_id;
    if (!localizacao_id) throw new Error("setup: loc da sessão não encontrada");

    // Sanity: confirma que loc realmente não tem lock antes do bipe.
    const pre = locRow as { bloqueada_por: string | null; status: string };
    if (pre.bloqueada_por !== null) {
      throw new Error(`setup: esperava bloqueada_por=NULL, achou ${pre.bloqueada_por}`);
    }
    if (pre.status !== "pendente") {
      throw new Error(`setup: esperava status=pendente, achou ${pre.status}`);
    }

    const { data: prod } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const produto_id = (prod as { id: string }).id;

    // Tenta registrar contagem — DEVE falhar com 409.
    let erro: Error | null = null;
    try {
      await ctx.http.post(`/api/wms/inventario/${sess.id}/contagens`, {
        produto_id,
        localizacao_id,
        qty_contada: 5,
      });
    } catch (e) {
      erro = e as Error;
    }
    if (!erro) {
      throw new Error("POST /contagens deveria ter falhado com 409 mas não falhou");
    }
    if (!/409/.test(erro.message)) {
      throw new Error(`POST /contagens falhou mas não com 409: ${erro.message}`);
    }
    // Mensagem deve mencionar reivindicação/lock.
    if (
      !/reivindicada|não está|nao esta|lock/i.test(erro.message)
    ) {
      throw new Error(
        `POST /contagens falhou com 409 mas sem mensagem de lock: ${erro.message}`,
      );
    }

    return { sessao_id: sess.id, produto_id, localizacao_id };
  },

  assertEsperado: async (ctx, { sku }) => {
    // Zero rows em siso_inventario_contagens pra esse produto.
    const { data: prod } = await ctx.sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .single();
    const produto_id = (prod as { id: string }).id;

    const { data: rows, count } = await ctx.sb
      .from("siso_inventario_contagens")
      .select("id", { count: "exact" })
      .eq("produto_id", produto_id);
    if ((count ?? rows?.length ?? 0) > 0) {
      throw new Error(
        `esperava 0 contagens registradas (lock bloqueou), achou ${count ?? rows?.length}`,
      );
    }

    // Sanity: saldo permanece intocado.
    await ctx.assertSaldo(sku, "CWB", "A-01-01", 5);
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
