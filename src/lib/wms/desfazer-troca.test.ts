import { describe, it, expect, vi, beforeEach } from "vitest";

// BUG-A (2026-06-23): desfazer troca aplicada (beco-sem-saída). A RPC atômica é
// validada ao vivo (happy + guards ITEM_JA_PICADO/PEDIDO_ESTADO_INVALIDO/
// TROCA_NAO_APLICADA). Este teste cobre a CAMADA TS: guard de status (só desfaz
// 'aprovada') + tradução de erro da RPC → TrocaError + evento de histórico.

const eventoSpy = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/historico-service", () => ({
  registrarEvento: (...a: unknown[]) => eventoSpy(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), logError: vi.fn() },
}));

let trocaRow: Record<string, unknown> | null;
let rpcResult: { data: unknown; error: { message: string } | null };
const rpcSpy = vi.fn(async () => rpcResult);

vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => ({
    from() {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: trocaRow, error: null });
      return chain;
    },
    rpc: rpcSpy,
  }),
}));

import { desfazerTrocaAplicada, TrocaError } from "./trocas-equivalencia";

beforeEach(() => {
  trocaRow = {
    id: "t1",
    pedido_id: "PED-1",
    pedido_item_id: 10,
    status: "aprovada",
    sku_vendido: "ORIG",
    sku_substituto: "SUB",
  };
  rpcResult = { data: { ok: true, reservas_liberadas: 1 }, error: null };
  rpcSpy.mockClear();
  eventoSpy.mockClear();
});

describe("BUG-A — desfazerTrocaAplicada", () => {
  it("troca não-aprovada → TROCA_NAO_APLICADA sem chamar a RPC", async () => {
    trocaRow = { ...(trocaRow as object), status: "pendente" };
    await expect(
      desfazerTrocaAplicada({ trocaId: "t1", usuarioId: "u1" }),
    ).rejects.toMatchObject({ code: "TROCA_NAO_APLICADA" });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("troca inexistente → TROCA_NAO_ENCONTRADA", async () => {
    trocaRow = null;
    await expect(
      desfazerTrocaAplicada({ trocaId: "t1", usuarioId: "u1" }),
    ).rejects.toMatchObject({ code: "TROCA_NAO_ENCONTRADA" });
  });

  it("RPC ITEM_JA_PICADO → TrocaError ITEM_JA_PICADO", async () => {
    rpcResult = { data: null, error: { message: "ITEM_JA_PICADO" } };
    await expect(
      desfazerTrocaAplicada({ trocaId: "t1", usuarioId: "u1" }),
    ).rejects.toMatchObject({ code: "ITEM_JA_PICADO" });
  });

  it("RPC PEDIDO_ESTADO_INVALIDO → TrocaError PEDIDO_ESTADO_INVALIDO", async () => {
    rpcResult = { data: null, error: { message: "PEDIDO_ESTADO_INVALIDO:separado" } };
    await expect(
      desfazerTrocaAplicada({ trocaId: "t1", usuarioId: "u1" }),
    ).rejects.toMatchObject({ code: "PEDIDO_ESTADO_INVALIDO" });
  });

  it("happy path → libera, registra evento e retorna reservasLiberadas", async () => {
    const r = await desfazerTrocaAplicada({
      trocaId: "t1",
      usuarioId: "u1",
      usuarioNome: "Op",
    });
    expect(r).toMatchObject({
      ok: true,
      reservasLiberadas: 1,
      pedidoId: "PED-1",
      pedidoItemId: 10,
    });
    expect(rpcSpy).toHaveBeenCalledWith("wms_desfazer_troca_aplicada_atomico", {
      p_pedido_item_id: 10,
      p_usuario_id: "u1",
    });
    expect(eventoSpy).toHaveBeenCalledTimes(1);
  });

  it("erro inesperado da RPC → Error genérico (não TrocaError)", async () => {
    rpcResult = { data: null, error: { message: "deadlock detected" } };
    await expect(
      desfazerTrocaAplicada({ trocaId: "t1", usuarioId: "u1" }),
    ).rejects.toThrow(/wms_desfazer_troca_aplicada_atomico falhou/);
  });

  it("TrocaError tem code estável (não vaza message crua)", async () => {
    rpcResult = { data: null, error: { message: "TROCA_NAO_APLICADA" } };
    try {
      await desfazerTrocaAplicada({ trocaId: "t1", usuarioId: "u1" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TrocaError);
    }
  });
});
