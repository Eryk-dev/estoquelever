import { describe, it, expect } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

describe("wms_detectar_divergencias_estoque", () => {
  it("retorna vazio em estado limpo", async () => {
    const { data, error } = await sb.rpc("wms_detectar_divergencias_estoque");
    expect(error).toBeNull();
    expect((data ?? []).length).toBe(0);
  });

  it("detecta divergência após edit manual em siso_estoque", async () => {
    const SKU = `TEST-INT-REC-${Math.random().toString(36).slice(2, 8)}`;
    const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const { data: l } = await sb
      .from("siso_localizacoes")
      .select("id")
      .eq("galpao_id", g!.id)
      .eq("codigo", "A-01-03")
      .single();
    const { data: p } = await sb
      .from("siso_produtos")
      .insert({ sku: SKU, descricao: "Reconcil test", ativo: true })
      .select("id")
      .single();

    // Semeia 10 via RPC (consistente)
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: p!.id,
      p_galpao_id: g!.id,
      p_localizacao_id: l!.id,
      p_tipo: "E",
      p_quantidade: 10,
      p_origem_tipo: "inventario_inicial",
      p_origem_id: null,
      p_custo_unitario: null,
      p_motivo: "seed",
    });

    // Sabota o cache manualmente — saldo fica 999, ledger ainda diz 10
    await sb
      .from("siso_estoque")
      .update({ saldo: 999 })
      .eq("produto_id", p!.id)
      .eq("galpao_id", g!.id)
      .eq("localizacao_id", l!.id);

    const { data: divs } = await sb.rpc("wms_detectar_divergencias_estoque");
    type Divergencia = { estoque_id: string; produto_id: string };
    const meu = (divs as Divergencia[] | null)?.find((d) => d.produto_id === p!.id);
    expect(meu).toBeTruthy();

    // Rebuild restaura — RPC recebe o estoque_id (UUID da linha em siso_estoque)
    await sb.rpc("wms_rebuild_linha_estoque", { p_id: meu!.estoque_id });
    const { data: depois } = await sb
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", p!.id)
      .single();
    expect(Number(depois?.saldo)).toBe(10);
  });
});
