// @vitest-environment node

import { describe, expect, it } from "vitest";
import { getMarketplaceFilterOptions } from "./marketplace-filter";

describe("getMarketplaceFilterOptions", () => {
  it("preserva os filtros existentes e cobre todas as variações TikTok", () => {
    const options = getMarketplaceFilterOptions();

    expect(options).toEqual([
      { value: "", label: "Todos marketplaces" },
      { value: "Mercado Livre", label: "Mercado Livre" },
      { value: "Shopee", label: "Shopee" },
      { value: "TikTok", label: "TikTok Shop" },
    ]);
  });
});
