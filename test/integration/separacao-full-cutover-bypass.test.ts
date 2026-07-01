import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { dispararCutoverSePronto } from "../../src/lib/wms/cutover";

/**
 * Separação Full — bypass de cutover (FULL-03 AC4).
 *
 * Um Full que atinge `separado` NÃO deve disparar `lancar_estoque_pos_nf`:
 * o envio ao CDF do ML dá baixa (S) no próprio pick, sem NF. `estoque_lancado`
 * permanece false e o editor de itens é o dono único da reconciliação.
 *
 * Isolado + auto-contido: cria pedido com id único, assere só nele, limpa tudo.
 * Pedido PURO (sem estoque) — o bypass retorna antes de qualquer lógica de S.
 */

const sb = createServiceClient();

let cwbId: string;
let empresaId: string;
const seededPedidoIds: string[] = [];
let seq = 0;

function pedidoId(): string {
  return `FULL-CUT-${Date.now()}-${++seq}`;
}

async function seedFull(status_separacao: string, extra?: Record<string, unknown>): Promise<string> {
  const id = pedidoId();
  const { error } = await sb.from("siso_pedidos").insert({
    id,
    numero: id,
    status: "executando",
    data: "2026-07-01",
    filial_origem: "CWB",
    cliente_nome: id,
    separacao_galpao_id: cwbId,
    empresa_origem_id: empresaId,
    separacao_full: true,
    decisao_final: "propria",
    estoque_lancado: false,
    status_separacao,
    marcadores: ["WMS", "FULL"],
    ...extra,
  });
  if (error) throw new Error(`seedFull falhou (${id}): ${error.message}`);
  seededPedidoIds.push(id);
  return id;
}

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  cwbId = g!.id;
  // Qualquer empresa serve — o bypass dispara independente de qual conta ML.
  const { data: e } = await sb.from("siso_empresas").select("id").eq("cnpj", "34857388000163").single();
  empresaId = e!.id;
});

afterAll(async () => {
  if (seededPedidoIds.length > 0) {
    await sb.from("siso_fila_execucao").delete().in("pedido_id", seededPedidoIds);
    await sb.from("siso_pedidos").delete().in("id", seededPedidoIds);
  }
});

describe("dispararCutoverSePronto — Full bypassa cutover", () => {
  it("Full em separado retorna full_bypass e NÃO enfileira lancar_estoque_pos_nf", async () => {
    const id = await seedFull("separado");

    const res = await dispararCutoverSePronto(id);
    expect(res.enqueued).toBe(false);
    expect(res.motivo).toBe("full_bypass");

    // Zero job de cutover enfileirado pro Full.
    const { data: jobs } = await sb
      .from("siso_fila_execucao")
      .select("id, tipo")
      .eq("pedido_id", id)
      .eq("tipo", "lancar_estoque_pos_nf");
    expect(jobs ?? []).toHaveLength(0);

    // estoque_lancado segue false (o pick é o dono da baixa, não o cutover).
    const { data: pedido } = await sb
      .from("siso_pedidos")
      .select("estoque_lancado")
      .eq("id", id)
      .single();
    expect(pedido?.estoque_lancado).toBe(false);
  });

  it("bypass tem precedência sobre estoque_lancado (Full nunca enfileira)", async () => {
    // Mesmo num estado que num pedido normal enfileiraria, o Full curto-circuita.
    const id = await seedFull("embalado");
    const res = await dispararCutoverSePronto(id);
    expect(res.motivo).toBe("full_bypass");
  });
});
