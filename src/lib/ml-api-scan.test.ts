import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ml-oauth", () => ({
  ML_API_BASE: "https://api.mercadolibre.com",
  getValidMlToken: vi.fn(async () => "fake-token"),
}));
vi.mock("./ml-stub", () => ({
  isMlDisabled: () => false,
  getMlUserMeStub: vi.fn(),
  searchSellerItemsBySkuStub: vi.fn(),
  searchAndMatchItemsBySkuStub: vi.fn(),
  getMlItemsDetailsStub: vi.fn(),
  testarMlConnectionStub: vi.fn(),
}));
vi.mock("./supabase-server", () => ({ createServiceClient: vi.fn() }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  collectAllSkusFromItem,
  getMlActiveItemsDetailsForScan,
  getMlItemsDetails,
  scanSellerActiveItemsPage,
  type MlItem,
} from "./ml-api";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function item(id: string, overrides: Partial<MlItem> = {}): MlItem {
  return {
    id,
    title: id,
    price: 10,
    currency_id: "BRL",
    status: "active",
    permalink: `https://produto.mercadolivre.com.br/${id}`,
    available_quantity: 1,
    ...overrides,
  };
}

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
});

describe("scanSellerActiveItemsPage", () => {
  it("abre o scan exaustivo de anúncios ativos sem offset", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        scroll_id: "scroll-1",
        paging: { limit: 100, total: 240 },
        results: ["MLB1", "MLB2"],
      }),
    );

    const page = await scanSellerActiveItemsPage("conn-1", 123);

    expect(page).toEqual({
      scroll_id: "scroll-1",
      paging: { limit: 100, total: 240 },
      results: ["MLB1", "MLB2"],
    });
    const [rawUrl, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe("/users/123/items/search");
    expect(url.searchParams.get("search_type")).toBe("scan");
    expect(url.searchParams.get("status")).toBe("active");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.has("offset")).toBe(false);
    expect((init.headers as Headers).get("Authorization")).toBe(
      "Bearer fake-token",
    );
  });

  it("continua exatamente pelo scroll_id recebido", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ scroll_id: null, results: [] }),
    );
    const checkpoint = "scroll:/+= com espaço";

    const page = await scanSellerActiveItemsPage(
      "conn-1",
      123,
      checkpoint,
    );

    expect(page).toEqual({
      scroll_id: null,
      paging: undefined,
      results: [],
    });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("search_type")).toBe("scan");
    expect(url.searchParams.get("scroll_id")).toBe(checkpoint);
    expect(url.searchParams.has("status")).toBe(false);
    expect(url.searchParams.has("offset")).toBe(false);
  });

  it("aceita results null como fim, mas rejeita resposta 200 malformada", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ scroll_id: null, results: null }),
    );
    await expect(
      scanSellerActiveItemsPage("conn-1", 123, "scroll-1"),
    ).resolves.toEqual({
      scroll_id: null,
      paging: undefined,
      results: [],
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ scroll_id: null }));
    await expect(
      scanSellerActiveItemsPage("conn-1", 123, "scroll-1"),
    ).rejects.toThrow(/results ausente ou inválido/i);

    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));
    await expect(
      scanSellerActiveItemsPage("conn-1", 123, "scroll-1"),
    ).rejects.toThrow(/scroll_id ausente ou inválido/i);
  });
});

describe("getMlItemsDetails para o índice", () => {
  it("divide o multiget em lotes de 20 e exige todos os MLBs", async () => {
    fetchMock.mockImplementation(async (rawUrl: string) => {
      const url = new URL(rawUrl);
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      return jsonResponse(
        ids.map((id) => ({ code: 200, body: item(id) })),
      );
    });
    const ids = Array.from({ length: 21 }, (_, index) => `MLB${index + 1}`);

    const result = await getMlItemsDetails("conn-1", ids, {
      requireAll: true,
    });

    expect(result).toHaveLength(21);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [rawUrl] of fetchMock.mock.calls) {
      const url = new URL(rawUrl as string);
      expect(url.pathname).toBe("/items");
      expect(url.searchParams.get("attributes")).toContain("variations");
      expect(url.searchParams.get("include_attributes")).toBe("all");
    }
  });

  it("falha fechado quando qualquer MLB da página não tem detalhe", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { code: 200, body: item("MLB1") },
        { code: 404, body: { id: "MLB2" } },
      ]),
    );

    await expect(
      getMlItemsDetails("conn-1", ["MLB1", "MLB2"], {
        requireAll: true,
      }),
    ).rejects.toThrow(/multiget incompleto/i);
  });
});

describe("getMlActiveItemsDetailsForScan", () => {
  it("retorna ativos e descarta com segurança 404 ou anúncio não ativo", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { code: 200, body: item("MLB1") },
        {
          code: 200,
          body: item("MLB2", { status: "closed" }),
        },
        { code: 404, body: { error: "not_found" } },
        {
          code: 200,
          body: item("MLB4", { status: "paused" }),
        },
      ]),
    );

    const result = await getMlActiveItemsDetailsForScan("conn-1", [
      "MLB1",
      "MLB2",
      "MLB3",
      "MLB4",
    ]);

    expect(result.items.map((entry) => entry.id)).toEqual(["MLB1"]);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("attributes")).toContain("variations");
    expect(url.searchParams.get("include_attributes")).toBe("all");
    expect(result.skipped).toEqual([
      {
        id: "MLB2",
        motivo: "not_active",
        code: 200,
        status: "closed",
      },
      {
        id: "MLB3",
        motivo: "not_found",
        code: 404,
        status: null,
      },
      {
        id: "MLB4",
        motivo: "not_active",
        code: 200,
        status: "paused",
      },
    ]);
  });

  it.each([429, 500, 503])(
    "falha a página em resposta transitória %s",
    async (code) => {
      fetchMock.mockResolvedValue(
        jsonResponse([{ code, body: { message: "retry" } }]),
      );

      await expect(
        getMlActiveItemsDetailsForScan("conn-1", ["MLB1"]),
      ).rejects.toThrow(/transitório/i);
    },
  );

  it("falha em código desconhecido ou entrada ausente", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ code: 400, body: { message: "bad request" } }]),
    );
    await expect(
      getMlActiveItemsDetailsForScan("conn-1", ["MLB1"]),
    ).rejects.toThrow(/inesperado/i);

    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await expect(
      getMlActiveItemsDetailsForScan("conn-1", ["MLB1"]),
    ).rejects.toThrow(/sem resposta/i);
  });
});

describe("collectAllSkusFromItem", () => {
  it("extrai e deduplica SKU do item e de variations[]", () => {
    const skus = collectAllSkusFromItem(
      item("MLB1", {
        seller_custom_field: " TOP-1 ",
        attributes: [
          { id: "SELLER_SKU", value_name: "ATTR-TOP" },
          { id: "BRAND", value_name: "Marca" },
        ],
        variations: [
          {
            id: 10,
            seller_custom_field: "VAR-1",
            attributes: [
              {
                id: "SELLER_SKU",
                values: [{ name: "VAR-ATTR" }],
              },
            ],
          },
          {
            id: 11,
            seller_custom_field: "TOP-1",
          },
        ],
      }),
    );

    expect(new Set(skus)).toEqual(
      new Set(["TOP-1", "ATTR-TOP", "VAR-1", "VAR-ATTR"]),
    );
  });
});
