import { describe, expect, it } from "vitest";
import {
  coberturaIndiceEstaCompleta,
  erroPermiteRetomarCheckpoint,
  extrairLinhasIndiceMl,
  paginaScanEhFinal,
} from "./ml-anuncios-index";
import type { MlItem } from "./ml-api";

function item(overrides: Partial<MlItem> = {}): MlItem {
  return {
    id: "MLB-1",
    title: "Produto",
    price: 10,
    currency_id: "BRL",
    status: "active",
    permalink: "https://example.test/MLB-1",
    available_quantity: 1,
    ...overrides,
  };
}

describe("índice completo de anúncios ML", () => {
  it("indexa SKU do item e das variações, normaliza e deduplica por anúncio", () => {
    const rows = extrairLinhasIndiceMl("conn-1", "gen-1", [
      item({
        seller_custom_field: " sku-top ",
        attributes: [{ id: "SELLER_SKU", value_name: "SKU-TOP" }],
        variations: [
          {
            id: 10,
            seller_custom_field: "sku-var",
            attributes: [{ id: "SELLER_SKU", value_name: " SKU-VAR " }],
          },
        ],
      }),
      item({
        id: "MLB-PAUSED",
        status: "paused",
        seller_custom_field: "NAO-INDEXAR",
      }),
    ]);

    expect(rows).toEqual([
      {
        conexao_id: "conn-1",
        scan_generation: "gen-1",
        sku_normalizado: "SKU-TOP",
        sku_original: "sku-top",
        mlb_id: "MLB-1",
      },
      {
        conexao_id: "conn-1",
        scan_generation: "gen-1",
        sku_normalizado: "SKU-VAR",
        sku_original: "sku-var",
        mlb_id: "MLB-1",
      },
    ]);
  });

  it("só declara cobertura quando todas as contas têm geração recente concluída", () => {
    const now = Date.parse("2026-07-29T02:00:00.000Z");
    const conexoes = [{ id: "a" }, { id: "b" }];
    const completa = [
      {
        conexao_id: "a",
        ultima_geracao_concluida: "gen-a",
        ultima_varredura_completa_em: "2026-07-29T01:00:00.000Z",
      },
      {
        conexao_id: "b",
        ultima_geracao_concluida: "gen-b",
        ultima_varredura_completa_em: "2026-07-29T01:30:00.000Z",
      },
    ];

    expect(
      coberturaIndiceEstaCompleta(conexoes, completa, now, 2 * 60 * 60_000),
    ).toBe(true);
    expect(
      coberturaIndiceEstaCompleta(
        conexoes,
        completa.slice(0, 1),
        now,
        2 * 60 * 60_000,
      ),
    ).toBe(false);
    expect(
      coberturaIndiceEstaCompleta(conexoes, completa, now, 30 * 60_000),
    ).toBe(false);
  });

  it("encerra o scan somente depois da página vazia, sem confiar no total mutável", () => {
    expect(
      paginaScanEhFinal({
        results: ["MLB1"],
        scroll_id: "scroll-1",
      }),
    ).toBe(false);
    expect(
      paginaScanEhFinal({
        results: [],
        scroll_id: null,
      }),
    ).toBe(true);
    expect(() =>
      paginaScanEhFinal({
        results: ["MLB1"],
        scroll_id: null,
      }),
    ).toThrow(/sem scroll_id/i);
  });

  it("preserva checkpoint idempotente e 429 do scroll, mas reinicia erros incertos", () => {
    expect(
      erroPermiteRetomarCheckpoint(
        { pagina_pendente_ids: ["MLB1"], busca_em_andamento: false },
        "falha no upsert",
      ),
    ).toBe(true);
    expect(
      erroPermiteRetomarCheckpoint(
        { pagina_pendente_ids: null, busca_em_andamento: true },
        "ML API 429 /users/123/items/search",
      ),
    ).toBe(true);
    expect(
      erroPermiteRetomarCheckpoint(
        { pagina_pendente_ids: null, busca_em_andamento: true },
        "fetch failed",
      ),
    ).toBe(false);
  });
});
