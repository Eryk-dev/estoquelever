import { describe, it, expect } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

describe("wms_inventario_sugerir", () => {
  it("retorna lista de localizações com motivo categorizado", async () => {
    const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const { data, error } = await sb.rpc("wms_inventario_sugerir", {
      p_galpao: g!.id,
      p_tamanho: 5,
    });
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    for (const row of (data as Array<{ motivo: string }>) ?? []) {
      expect(["curva_a", "divergente_recente", "sem_contagem_recente", "manual", "completo"]).toContain(row.motivo);
    }
  });
});

describe("wms_inventario_proxima_loc", () => {
  it("retorna pool_vazio quando não há loc na sessão", async () => {
    const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
    // P055: o harness trunca 1x por run, mas vários arquivos de teste criam sessão de
    // inventário no mesmo galpão+dia → colidem no uq_inv_sessao_galpao_dia. Limpa as
    // sessões não-contínuas do galpão usado pra este arquivo ser ordem-independente
    // (FK ON DELETE CASCADE cuida dos filhos).
    await sb.from("siso_inventario_sessoes")
      .delete()
      .eq("galpao_id", g!.id)
      .eq("continua", false);
    // cria sessão sem locs (caso degenerado pra forçar pool_vazio).
    // Schema real: campos são `modo_contagem` (não `modo`) e `criada_por` é NOT NULL.
    const { data: sess } = await sb
      .from("siso_inventario_sessoes")
      .insert({
        galpao_id: g!.id,
        tipo: "cycle_count",
        modo_contagem: "blind",
        status: "em_andamento",
        tamanho_pool: 0,
        criada_por: u!.id,
      })
      .select("id")
      .single();
    await sb
      .from("siso_inventario_operadores")
      .insert({ sessao_id: sess!.id, usuario_id: u!.id });

    const { data: prox } = await sb.rpc("wms_inventario_proxima_loc", {
      p_sessao: sess!.id,
      p_user: u!.id,
    });
    expect((prox as { pool_vazio?: boolean })?.pool_vazio).toBe(true);
  });
});
