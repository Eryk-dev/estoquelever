import { describe, it, expect, vi } from "vitest";
import {
  resolverProdutoWms,
  resolverProdutoWmsFlex,
  resolverProdutoWmsPorSku,
  resolverProdutoEfetivoDoItem,
  resolverLocalizacaoWms,
  resolveSeparacaoGalpao,
  type MappingDeps,
} from "./wms-mapping";

function makeDeps(overrides: Partial<MappingDeps> = {}): MappingDeps {
  return {
    buscarProdutoId: vi.fn(async () => "uuid-prod-1"),
    buscarProdutoIdPorSku: vi.fn(async () => "uuid-por-sku"),
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

describe("resolverProdutoWmsFlex (SKU-first fallback)", () => {
  it("prioriza substituto (troca) sobre tiny e SKU", async () => {
    const deps = makeDeps();
    const r = await resolverProdutoWmsFlex(
      "emp-1",
      { tinyProdutoId: "123", sku: "MK0244", substitutoId: "uuid-substituto" },
      deps,
    );
    expect(r).toBe("uuid-substituto");
    expect(deps.buscarProdutoId).not.toHaveBeenCalled();
    expect(deps.buscarProdutoIdPorSku).not.toHaveBeenCalled();
  });

  it("usa tiny bridge quando id>0 resolve (não cai pro SKU)", async () => {
    const deps = makeDeps();
    const r = await resolverProdutoWmsFlex(
      "emp-1",
      { tinyProdutoId: "123", sku: "MK0244" },
      deps,
    );
    expect(r).toBe("uuid-prod-1");
    expect(deps.buscarProdutoIdPorSku).not.toHaveBeenCalled();
  });

  it("cai pro SKU quando tiny=0 (item sem vínculo Tiny)", async () => {
    const deps = makeDeps();
    const r = await resolverProdutoWmsFlex(
      "emp-1",
      { tinyProdutoId: 0, sku: "MK0244" },
      deps,
    );
    expect(r).toBe("uuid-por-sku");
    expect(deps.buscarProdutoId).not.toHaveBeenCalled();
    expect(deps.buscarProdutoIdPorSku).toHaveBeenCalledWith("MK0244");
  });

  it("cai pro SKU quando tiny>0 não tem bridge (venda cross-catálogo)", async () => {
    const deps = makeDeps({ buscarProdutoId: vi.fn(async () => null) });
    const r = await resolverProdutoWmsFlex(
      "emp-1",
      { tinyProdutoId: "123", sku: "MK0244" },
      deps,
    );
    expect(r).toBe("uuid-por-sku");
  });

  it("lança quando nem tiny nem SKU resolvem", async () => {
    const deps = makeDeps({
      buscarProdutoId: vi.fn(async () => null),
      buscarProdutoIdPorSku: vi.fn(async () => null),
    });
    await expect(
      resolverProdutoWmsFlex("emp-1", { tinyProdutoId: 0, sku: "X" }, deps),
    ).rejects.toThrow(/não mapeado em siso_produto_empresas/i);
  });

  it("resolverProdutoWmsPorSku retorna null pra sku vazio sem consultar", async () => {
    const deps = makeDeps();
    expect(await resolverProdutoWmsPorSku("", deps)).toBeNull();
    expect(await resolverProdutoWmsPorSku(null, deps)).toBeNull();
    expect(deps.buscarProdutoIdPorSku).not.toHaveBeenCalled();
  });

  it("resolverProdutoEfetivoDoItem resolve item id=0 pelo SKU", async () => {
    const deps = makeDeps();
    const r = await resolverProdutoEfetivoDoItem(
      "emp-1",
      { produto_id: 0, sku: "MK0244" },
      deps,
    );
    expect(r).toBe("uuid-por-sku");
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
