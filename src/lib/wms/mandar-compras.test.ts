import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/historico-service", () => ({
  registrarEvento: vi.fn(async () => undefined),
}));
vi.mock("@/lib/sku-fornecedor", () => ({
  getFornecedorBySku: () => ({ fornecedor: "Diversos" }),
}));

import { mandarItensParaValidacaoOC } from "./mandar-compras";

const updates: Array<{
  table: string;
  payload: Record<string, unknown>;
}> = [];

function fakeSupabase() {
  return {
    from(table: string) {
      let operation: "select" | "update" = "select";
      let payload: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.in = () => chain;
      chain.eq = () => chain;
      chain.update = (next: Record<string, unknown>) => {
        operation = "update";
        payload = next;
        return chain;
      };
      chain.then = (resolve: (value: unknown) => unknown) => {
        if (operation === "select" && table === "siso_pedido_itens") {
          return Promise.resolve({
            data: [
              {
                id: 13202,
                pedido_id: "FULL-1",
                sku: "TEC001",
                quantidade_pedida: 6,
                quantidade_pega: 5,
                fornecedor_oc: null,
              },
            ],
            error: null,
          }).then(resolve);
        }
        updates.push({ table, payload });
        return Promise.resolve({ data: null, error: null }).then(resolve);
      };
      return chain;
    },
  };
}

beforeEach(() => {
  updates.length = 0;
});

describe("mandarItensParaValidacaoOC", () => {
  it("reabre a decisão OC sem apagar o parcial já pego", async () => {
    const result = await mandarItensParaValidacaoOC({
      supabase: fakeSupabase() as never,
      pedido_ids: ["FULL-1"],
      item_ids: ["13202"],
      usuario_id: "u1",
      usuario_nome: "Operador",
    });

    expect(result).toEqual({ itens_atualizados: 1, pedidos_atualizados: 1 });
    const itemUpdate = updates.find((update) => update.table === "siso_pedido_itens");
    expect(itemUpdate?.payload).toMatchObject({
      compra_status: "oc_pendente",
      compra_quantidade_solicitada: 1,
      separacao_marcado: false,
      separacao_marcado_em: null,
    });
    expect(itemUpdate?.payload).not.toHaveProperty("quantidade_pega");
  });
});
