import { describe, it, expect, vi } from "vitest";
import { pickMovPicking, type PickMovDeps } from "./pick-mov";

function fakeDeps(overrides: Partial<PickMovDeps> = {}): PickMovDeps {
  return {
    resolverProdutoWms: vi.fn().mockResolvedValue("prod-uuid"),
    resolverLocalizacaoWms: vi.fn().mockResolvedValue("default-loc-uuid"),
    buscarLocComMaiorSaldoNoGalpao: vi.fn().mockResolvedValue("live-loc-uuid"),
    buscarReservaPorProduto: vi.fn().mockResolvedValue(null),
    // Espelha wms_pick_item_atomico: com reserva emite L+S (mov_l_id), sem
    // reserva emite S-only (mov_l_id=null). Ecoa a tripla recebida.
    pickItemAtomico: vi.fn(async (a) => ({
      mov_l_id: a.reserva_id ? "L-mov-id" : null,
      mov_s_id: "S-mov-id",
      produto_id: a.produto_id,
      galpao_id: a.galpao_id,
      localizacao_id: a.localizacao_id,
    })),
    registrarLinks: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("pickMovPicking", () => {
  it("returns null when empresa or galpão missing", async () => {
    const deps = fakeDeps();
    const result = await pickMovPicking(
      { empresa_origem_id: null, galpao_id: "g", pedido_id: "p", pedido_numero: "n", item_id: 1, produto_id_tiny: "t", sku: "s", qty: 1, usuario_id: "u" },
      deps,
    );
    expect(result).toBeNull();
    expect(deps.pickItemAtomico).not.toHaveBeenCalled();
  });

  it("uses the live reservation's loc when an R exists", async () => {
    const deps = fakeDeps({
      buscarReservaPorProduto: vi
        .fn()
        .mockResolvedValue({ id: "R-mov-id", quantidade: 5, localizacao_id: "R-loc-uuid" }),
    });
    const result = await pickMovPicking(
      { empresa_origem_id: "e", galpao_id: "g", pedido_id: "p", pedido_numero: "n", item_id: 1, produto_id_tiny: "t", sku: "s", qty: 3, usuario_id: "u" },
      deps,
    );
    expect(result?.movSaidaId).toBe("S-mov-id");
    expect(result?.tripla.localizacao_id).toBe("R-loc-uuid");
    // loc veio da R — não usou a heurística de maior saldo
    expect(deps.buscarLocComMaiorSaldoNoGalpao).not.toHaveBeenCalled();
  });

  it("falls back to live loc when no R found", async () => {
    const deps = fakeDeps();
    const result = await pickMovPicking(
      { empresa_origem_id: "e", galpao_id: "g", pedido_id: "p", pedido_numero: "n", item_id: 1, produto_id_tiny: "t", sku: "s", qty: 3, usuario_id: "u" },
      deps,
    );
    expect(deps.buscarLocComMaiorSaldoNoGalpao).toHaveBeenCalled();
    expect(result?.tripla.localizacao_id).toBe("live-loc-uuid");
    expect(result?.movSaidaId).toBe("S-mov-id");
  });

  it("liberates R reservation when present (par L+S via RPC atômica)", async () => {
    const deps = fakeDeps({
      buscarReservaPorProduto: vi
        .fn()
        .mockResolvedValue({ id: "R-mov-id", quantidade: 5, localizacao_id: "R-loc-uuid" }),
    });
    const result = await pickMovPicking(
      { empresa_origem_id: "e", galpao_id: "g", pedido_id: "p", pedido_numero: "n", item_id: 1, produto_id_tiny: "t", sku: "s", qty: 3, usuario_id: "u" },
      deps,
    );
    // O par L+S sai pela RPC atômica com a reserva_id da R viva
    expect(deps.pickItemAtomico).toHaveBeenCalledWith(
      expect.objectContaining({ reserva_id: "R-mov-id", localizacao_id: "R-loc-uuid" }),
    );
    expect(result?.movLiberacaoId).toBe("L-mov-id");
    expect(result?.movSaidaId).toBe("S-mov-id");
  });

  it("registers links for both L and S when both created", async () => {
    const deps = fakeDeps({
      buscarReservaPorProduto: vi
        .fn()
        .mockResolvedValue({ id: "R-mov-id", quantidade: 5, localizacao_id: "R-loc-uuid" }),
    });
    await pickMovPicking(
      { empresa_origem_id: "e", galpao_id: "g", pedido_id: "p", pedido_numero: "n", item_id: 1, produto_id_tiny: "t", sku: "s", qty: 3, usuario_id: "u" },
      deps,
    );
    expect(deps.registrarLinks).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ tipo_link: "liberacao_reserva" }),
        expect.objectContaining({ tipo_link: "saida" }),
      ]),
    );
  });

  it("returns null when qty<=0 (no-op)", async () => {
    const deps = fakeDeps();
    const result = await pickMovPicking(
      { empresa_origem_id: "e", galpao_id: "g", pedido_id: "p", pedido_numero: "n", item_id: 1, produto_id_tiny: "t", sku: "s", qty: 0, usuario_id: "u" },
      deps,
    );
    expect(result).toBeNull();
    expect(deps.pickItemAtomico).not.toHaveBeenCalled();
    expect(deps.resolverProdutoWms).not.toHaveBeenCalled();
  });

  it("falls back to DEFAULT-PICKING when no R and no live loc", async () => {
    const deps = fakeDeps({
      buscarReservaPorProduto: vi.fn().mockResolvedValue(null),
      buscarLocComMaiorSaldoNoGalpao: vi.fn().mockResolvedValue(null),
      resolverLocalizacaoWms: vi.fn().mockResolvedValue("default-loc-uuid"),
    });
    const result = await pickMovPicking(
      { empresa_origem_id: "e", galpao_id: "g", pedido_id: "p", pedido_numero: "n", item_id: 1, produto_id_tiny: "t", sku: "s", qty: 2, usuario_id: "u" },
      deps,
    );
    expect(result?.tripla.localizacao_id).toBe("default-loc-uuid");
    expect(deps.resolverLocalizacaoWms).toHaveBeenCalledWith("g", null);
  });

  it("registers ONLY 'saida' link when no R found (S-only path)", async () => {
    const deps = fakeDeps({
      buscarReservaPorProduto: vi.fn().mockResolvedValue(null),
    });
    await pickMovPicking(
      { empresa_origem_id: "e", galpao_id: "g", pedido_id: "p", pedido_numero: "n", item_id: 1, produto_id_tiny: "t", sku: "s", qty: 4, usuario_id: "u" },
      deps,
    );
    const registrarLinks = deps.registrarLinks as ReturnType<typeof vi.fn>;
    expect(registrarLinks).toHaveBeenCalledTimes(1);
    const linksArg = registrarLinks.mock.calls[0][0];
    expect(linksArg).toHaveLength(1);
    expect(linksArg[0]).toMatchObject({ tipo_link: "saida", qty: 4 });
    expect(linksArg.find((l: { tipo_link: string }) => l.tipo_link === "liberacao_reserva")).toBeUndefined();
    // S-only: a RPC é chamada com reserva_id=null
    expect(deps.pickItemAtomico).toHaveBeenCalledWith(
      expect.objectContaining({ reserva_id: null }),
    );
  });
});
