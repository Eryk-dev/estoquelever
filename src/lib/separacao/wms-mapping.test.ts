import { describe, it, expect, vi } from "vitest";
import {
  resolverProdutoWms,
  resolverLocalizacaoWms,
  resolveSeparacaoGalpao,
  type MappingDeps,
} from "./wms-mapping";

function makeDeps(overrides: Partial<MappingDeps> = {}): MappingDeps {
  return {
    buscarProdutoId: vi.fn(async () => "uuid-prod-1"),
    buscarLocalizacaoId: vi.fn(async () => "uuid-loc-1"),
    criarLocalizacao: vi.fn(async () => "uuid-loc-novo"),
    ...overrides,
  };
}

describe("resolverProdutoWms", () => {
  it("retorna uuid quando produto existe em siso_produto_empresas", async () => {
    const deps = makeDeps();
    const r = await resolverProdutoWms("emp-1", "12345", deps);
    expect(r).toBe("uuid-prod-1");
    expect(deps.buscarProdutoId).toHaveBeenCalledWith("emp-1", "12345");
  });

  it("lança erro quando produto não está mapeado", async () => {
    const deps = makeDeps({ buscarProdutoId: vi.fn(async () => null) });
    await expect(resolverProdutoWms("emp-1", "99999", deps)).rejects.toThrow(
      /produto.*99999.*não mapeado/i,
    );
  });
});

describe("resolverLocalizacaoWms", () => {
  it("retorna uuid quando loc existe", async () => {
    const deps = makeDeps();
    const r = await resolverLocalizacaoWms("galp-1", "B-02-01", deps);
    expect(r).toBe("uuid-loc-1");
  });

  it("usa DEFAULT-PICKING quando codigo é null ou vazio", async () => {
    const deps = makeDeps();
    const r = await resolverLocalizacaoWms("galp-1", null, deps);
    expect(deps.buscarLocalizacaoId).toHaveBeenCalledWith("galp-1", "DEFAULT-PICKING");
    expect(r).toBe("uuid-loc-1");
  });

  it("cria nova loc (tipo picking) se não existe", async () => {
    const deps = makeDeps({ buscarLocalizacaoId: vi.fn(async () => null) });
    const r = await resolverLocalizacaoWms("galp-1", "C-99-99", deps);
    expect(deps.criarLocalizacao).toHaveBeenCalledWith("galp-1", "C-99-99");
    expect(r).toBe("uuid-loc-novo");
  });

  it("fallback final pra DEFAULT-PICKING se criação falhar", async () => {
    const deps = makeDeps({
      buscarLocalizacaoId: vi.fn(async (galp, cod) =>
        cod === "DEFAULT-PICKING" ? "uuid-default" : null,
      ),
      criarLocalizacao: vi.fn(async () => null),
    });
    const r = await resolverLocalizacaoWms("galp-1", "C-99-99", deps);
    expect(r).toBe("uuid-default");
  });
});

describe("resolveSeparacaoGalpao", () => {
  it("retorna separacao_galpao_id quando presente (fluxo transferência)", () => {
    const pedido = {
      empresa_origem_id: "emp-cwb-uuid",
      separacao_galpao_id: "gal-sp-uuid",
      sugestao: "transferencia",
    };
    expect(resolveSeparacaoGalpao(pedido as any)).toBe("gal-sp-uuid");
  });

  it("fallback pro galpão da empresa_origem quando separacao_galpao_id é NULL (própria)", () => {
    const pedido = {
      empresa_origem_id: "emp-cwb-uuid",
      separacao_galpao_id: null,
      sugestao: "propria",
      empresa_origem_galpao_id: "gal-cwb-uuid",
    };
    expect(resolveSeparacaoGalpao(pedido as any)).toBe("gal-cwb-uuid");
  });

  it("lança erro quando ambos NULL", () => {
    const pedido = { empresa_origem_id: null, separacao_galpao_id: null };
    expect(() => resolveSeparacaoGalpao(pedido as any)).toThrow(/sem galpão resolvível/i);
  });
});
