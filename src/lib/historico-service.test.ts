import { describe, it, expect } from "vitest";
import { truncateDetalhes } from "./historico-service";

describe("truncateDetalhes", () => {
  it("retorna o objeto original quando JSON serializado <= 64KB", () => {
    const detalhes = {
      sku: "ABC-123",
      qty: 10,
      observacoes: "x".repeat(1000),
    };
    const out = truncateDetalhes(detalhes, {
      pedidoId: "p1",
      evento: "auto_aprovado",
    });
    // Mesma referência: nenhuma cópia foi feita.
    expect(out).toBe(detalhes);
    expect(out._truncated).toBeUndefined();
  });

  it("retorna marker truncado quando JSON > 64KB", () => {
    // 70KB de payload — bem acima do limite de 64KB.
    const payloadGordo = "x".repeat(70 * 1024);
    const detalhes = {
      sku: "ABC-123",
      payload_pesado: payloadGordo,
    };
    const out = truncateDetalhes(detalhes, {
      pedidoId: "p2",
      evento: "erro",
    });
    expect(out._truncated).toBe(true);
    expect(typeof out._original_size_bytes).toBe("number");
    expect(out._original_size_bytes).toBeGreaterThan(64 * 1024);
    expect(out._max_size_bytes).toBe(64 * 1024);
    expect(typeof out._note).toBe("string");
    // Payload pesado foi descartado — não viaja pro DB.
    expect(out.payload_pesado).toBeUndefined();
  });

  it("aceita objeto vazio sem reclamar", () => {
    const out = truncateDetalhes(
      {},
      { pedidoId: "p3", evento: "recebido" },
    );
    expect(out).toEqual({});
  });
});
