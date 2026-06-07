import { describe, it, expect } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

describe("siso_fila_execucao aceita jobs de manutenção", () => {
  it("insere varredura_pos_entrada sem pedido/filial/decisao reais", async () => {
    const { data, error } = await sb.from("siso_fila_execucao").insert({
      pedido_id: "MAINT", tipo: "varredura_pos_entrada", filial_execucao: "MAINT",
      decisao: "manutencao", status: "pendente",
      payload: { produto_id: "00000000-0000-4000-8000-000000000001", galpao_id: "00000000-0000-4000-8000-000000000002", localizacao_id: "00000000-0000-4000-8000-000000000003" },
    }).select("id").single();
    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
    await sb.from("siso_fila_execucao").delete().eq("id", data!.id);
  });

  it("insere reconciliar_oc_retry", async () => {
    const { data, error } = await sb.from("siso_fila_execucao").insert({
      pedido_id: "999111000", tipo: "reconciliar_oc_retry", filial_execucao: "MAINT",
      decisao: "manutencao", status: "pendente",
      payload: { produto_id: "00000000-0000-4000-8000-000000000001", galpao_id: "00000000-0000-4000-8000-000000000002" },
    }).select("id").single();
    expect(error).toBeNull();
    if (data?.id) await sb.from("siso_fila_execucao").delete().eq("id", data.id);
  });
});
