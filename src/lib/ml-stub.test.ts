import { describe, it, expect } from "vitest";
import {
  getMlUserMeStub,
  isMlDisabled,
  searchAndMatchItemsBySkuStub,
  searchSellerItemsBySkuStub,
  testarMlConnectionStub,
} from "./ml-stub";

describe("ml-stub", () => {
  it("isMlDisabled lê env", () => {
    const old = process.env.ML_DISABLED;
    process.env.ML_DISABLED = "true";
    expect(isMlDisabled()).toBe(true);
    process.env.ML_DISABLED = old;
  });

  it("getMlUserMe retorna user fake estável", async () => {
    const r = await getMlUserMeStub("abc123");
    expect(r.id).toBe(999_999);
    expect(r.nickname).toContain("stub-user");
  });

  it("searchSellerItemsBySku retorna vazio", async () => {
    const r = await searchSellerItemsBySkuStub("ANY");
    expect(r.total).toBe(0);
    expect(r.results).toEqual([]);
  });

  it("searchAndMatchItemsBySku retorna []", async () => {
    expect(await searchAndMatchItemsBySkuStub("ANY")).toEqual([]);
  });

  it("testarMlConnection retorna ok", async () => {
    const r = await testarMlConnectionStub();
    expect(r.ok).toBe(true);
  });
});
