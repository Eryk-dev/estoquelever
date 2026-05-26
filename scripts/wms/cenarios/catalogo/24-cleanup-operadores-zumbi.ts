import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 24 — cleanup libera operador zumbi e lock órfão
 *
 * Cria uma sessão de inventário, entra na party, reivindica uma loc
 * (que vira `em_contagem` com `bloqueada_por`), força `ultima_acao_em`
 * 45 minutos no passado e dispara o cron de cleanup. Deve:
 *  - finalizar o operador (`finalizado_em` setado)
 *  - liberar a loc (status volta a `pendente`, `bloqueada_por` = null)
 */
export default {
  nome: "24 — cleanup libera operador zumbi e lock órfão",
  descricao:
    "Operador ativo sem ação > 30min → cleanup força finalizado_em e libera as locs em_contagem dele.",
  tags: ["inventario", "cleanup", "operador-zumbi", "p6"],

  setup: async (ctx: Ctx) => {
    const galpaoCwbId = ctx.staging.galpoes.cwb.id;

    // Cria uma loc picking + saldo pra ter algo no pool da sessão
    const sku = ctx.skuUnico("24");
    const locCodigo = `INV24-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    await ctx.criarProduto({ sku, descricao: "Cleanup zumbi 24" });
    await ctx.criarLocalizacao({ galpao: "CWB", codigo: locCodigo, tipo: "picking" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: locCodigo, qty: 5 });

    // Cria sessão de inventário (modo blind) com essa loc
    const sessao = await ctx.criarSessaoInventario({
      galpao: "CWB",
      locs: [locCodigo],
      modo: "blind",
      tipo: "cycle_count",
    });
    const sessao_id = sessao.id;

    // Entra na party
    await ctx.entrarParty(sessao_id);

    // Reivindica próxima loc → cria status='em_contagem' + bloqueada_por
    const prox = await ctx.proximaLoc(sessao_id);
    if (!prox.localizacao_id) {
      throw new Error("setup: proxima-loc não retornou localizacao_id");
    }

    // Resolve inv_loc_id pra conferência no assert
    const { data: invLoc, error: invErr } = await ctx.sb
      .from("siso_inventario_localizacoes")
      .select("id, status, bloqueada_por")
      .eq("sessao_id", sessao_id)
      .eq("localizacao_id", prox.localizacao_id)
      .single();
    if (invErr || !invLoc) {
      throw new Error(`setup: inv_loc não encontrado: ${invErr?.message}`);
    }
    if (invLoc.status !== "em_contagem" || !invLoc.bloqueada_por) {
      throw new Error(
        `setup: esperava loc em_contagem com bloqueada_por, recebi status=${invLoc.status} bloqueada_por=${invLoc.bloqueada_por}`,
      );
    }

    // Força ultima_acao_em pro passado (45 min)
    const cutoffPassado = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const { error: opErr } = await ctx.sb
      .from("siso_inventario_operadores")
      .update({ ultima_acao_em: cutoffPassado })
      .eq("sessao_id", sessao_id)
      .is("finalizado_em", null);
    if (opErr) throw new Error(`setup: update operador zumbi: ${opErr.message}`);

    return { sessao_id, inv_loc_id: invLoc.id, galpaoCwbId };
  },

  run: async (ctx, { sessao_id }) => {
    void sessao_id;
    const workerSecret = process.env.WORKER_SECRET;
    if (!workerSecret) {
      throw new Error("WORKER_SECRET não definido no ambiente de teste");
    }

    type CleanupBody = {
      sessoesAlerta: string[];
      locksLiberados: number;
      operadoresFinalizados: number;
      locksLiberadosPorFinalizado: number;
    };
    const body = await ctx.http.get<CleanupBody>(
      "/api/wms/inventario/cleanup",
      { "x-worker-secret": workerSecret },
    );

    if (typeof body.operadoresFinalizados !== "number") {
      throw new Error(
        `resposta sem operadoresFinalizados: ${JSON.stringify(body)}`,
      );
    }
    if (body.operadoresFinalizados < 1) {
      throw new Error(
        `esperava ≥1 operador zumbi finalizado, recebi ${body.operadoresFinalizados}`,
      );
    }
  },

  assertEsperado: async (ctx, { sessao_id, inv_loc_id }) => {
    const { data: op, error: opErr } = await ctx.sb
      .from("siso_inventario_operadores")
      .select("finalizado_em")
      .eq("sessao_id", sessao_id)
      .maybeSingle();
    if (opErr) throw new Error(`assert: select operador: ${opErr.message}`);
    if (!op?.finalizado_em) {
      throw new Error("operador deveria estar finalizado");
    }

    const { data: loc, error: locErr } = await ctx.sb
      .from("siso_inventario_localizacoes")
      .select("status, bloqueada_por")
      .eq("id", inv_loc_id)
      .single();
    if (locErr) throw new Error(`assert: select loc: ${locErr.message}`);
    if (loc.status !== "pendente") {
      throw new Error(`loc.status=${loc.status}, esperado pendente`);
    }
    if (loc.bloqueada_por !== null) {
      throw new Error(
        `loc.bloqueada_por=${loc.bloqueada_por}, esperado null`,
      );
    }
  },
} satisfies Cenario<{ sessao_id: string; inv_loc_id: string; galpaoCwbId: string }>;

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
