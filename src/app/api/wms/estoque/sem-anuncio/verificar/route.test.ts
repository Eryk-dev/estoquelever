import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAnunciosPorSku: vi.fn(),
  isMlDisabled: vi.fn(() => false),
}));

vi.mock("@/lib/ml-anuncios", () => ({
  getAnunciosPorSku: mocks.getAnunciosPorSku,
  normalizarSkuAnuncio: (sku: string) => sku.trim().toLocaleUpperCase(),
}));
vi.mock("@/lib/ml-stub", () => ({
  isMlDisabled: mocks.isMlDisabled,
}));
vi.mock("@/lib/wms/auth", () => ({
  requireAuth: async () => ({ ok: true }),
}));
vi.mock("@/lib/wms/api-errors", () => ({
  wmsErrorResponse: ({ error }: { error: unknown }) =>
    Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    ),
}));

import { POST } from "./route";

function request(sku: unknown) {
  return new Request("http://localhost/api/wms/estoque/sem-anuncio/verificar", {
    method: "POST",
    body: JSON.stringify({ sku }),
  });
}

function resultado(
  anuncios: Array<{ status: string }>,
  overrides?: {
    contasConsultadas?: number;
    contasComErro?: Array<{
      conexao_id: string;
      nickname: string;
      erro: string;
    }>;
  },
) {
  return {
    anuncios,
    contas_consultadas: overrides?.contasConsultadas ?? 2,
    contas_com_erro: overrides?.contasComErro ?? [],
    contas: [],
  };
}

describe("POST /api/wms/estoque/sem-anuncio/verificar", () => {
  beforeEach(() => {
    mocks.getAnunciosPorSku.mockReset();
    mocks.isMlDisabled.mockReturnValue(false);
  });

  it("confirma somente o resultado positivo de anúncio ativo", async () => {
    mocks.getAnunciosPorSku.mockResolvedValue(
      resultado([{ status: "active" }]),
    );

    const response = await POST(request(" sku-var "));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      sku: "SKU-VAR",
      situacao: "com_anuncio",
      conclusivo: true,
      anuncios_ativos: 1,
      limitacao: null,
    });
  });

  it("não rotula ausência quando a busca direta retorna vazia", async () => {
    mocks.getAnunciosPorSku.mockResolvedValue(resultado([]));

    const response = await POST(request("SKU-SO-NA-VARIACAO"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      situacao: "inconclusivo_busca_direta",
      conclusivo: false,
      anuncios_ativos: 0,
    });
    expect(body.limitacao).toMatch(/variaç/i);
    expect(JSON.stringify(body)).not.toContain('"situacao":"sem_anuncio"');
  });

  it("também mantém inconclusivo quando a busca direta encontra só pausados", async () => {
    mocks.getAnunciosPorSku.mockResolvedValue(
      resultado([{ status: "paused" }, { status: "closed" }]),
    );

    const response = await POST(request("SKU-PAUSADO"));
    const body = await response.json();

    expect(body.situacao).toBe("inconclusivo_busca_direta");
    expect(body.conclusivo).toBe(false);
  });

  it("um ativo encontrado é conclusivo mesmo com erro em outra conta", async () => {
    mocks.getAnunciosPorSku.mockResolvedValue(
      resultado([{ status: "active" }], {
        contasComErro: [
          { conexao_id: "c2", nickname: "Conta 2", erro: "timeout" },
        ],
      }),
    );

    const response = await POST(request("SKU-ATIVO"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.situacao).toBe("com_anuncio");
    expect(body.conclusivo).toBe(true);
  });

  it("preserva erro quando alguma conta falha e nenhum ativo foi encontrado", async () => {
    mocks.getAnunciosPorSku.mockResolvedValue(
      resultado([], {
        contasComErro: [
          { conexao_id: "c2", nickname: "Conta 2", erro: "timeout" },
        ],
      }),
    );

    const response = await POST(request("SKU-INCOMPLETO"));

    expect(response.status).toBe(502);
  });
});
