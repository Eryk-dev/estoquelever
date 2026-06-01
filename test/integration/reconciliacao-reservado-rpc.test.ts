import { describe, it, expect } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

describe("wms_detectar_divergencias_reservado", () => {
  it("flagra cache.reservado divergente e ignora quando bate com o ledger", async () => {
    const sku = `TEST-RESV-${Date.now()}`;
    const { data: prod } = await sb.from("siso_produtos").insert({ sku, descricao: "test reservado", ativo: true }).select("id").single();
    const { data: galpao } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao!.id).eq("codigo", "A-01-01").single();

    try {
      // Cache divergente: saldo 10, reservado 5, SEM movs no ledger (ledger → 0).
      await sb.from("siso_estoque").insert({ produto_id: prod!.id, galpao_id: galpao!.id, localizacao_id: loc!.id, saldo: 10, reservado: 5 });

      const { data: divs, error } = await sb.rpc("wms_detectar_divergencias_reservado");
      expect(error).toBeNull();
      const minha = (divs as Array<{ produto_id: string; delta: number }>).find((d) => d.produto_id === prod!.id);
      expect(minha).toBeTruthy();
      expect(Number(minha!.delta)).toBe(5);

      // Corrige cache → reservado 0; não deve mais flagrar.
      await sb.from("siso_estoque").update({ reservado: 0 }).eq("produto_id", prod!.id);
      const { data: divs2 } = await sb.rpc("wms_detectar_divergencias_reservado");
      expect((divs2 as Array<{ produto_id: string }>).find((d) => d.produto_id === prod!.id)).toBeFalsy();
    } finally {
      await sb.from("siso_estoque").delete().eq("produto_id", prod!.id);
      await sb.from("siso_produtos").delete().eq("id", prod!.id);
    }
  });
});
