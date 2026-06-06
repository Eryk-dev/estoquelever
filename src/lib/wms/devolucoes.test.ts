import { describe, it, expect, vi } from "vitest";

// Spy no ledger pra provar ZERO movs no caminho bloqueado [P051].
const movSpy = vi.fn(async () => ({ id: "mov-fake" }));
vi.mock("./ledger", () => ({
  inserirMovimentacao: () => movSpy(),
  estornarMovimentacao: vi.fn(),
}));

// upsertNotaFiscal não deve ser chamado (devolução sem NF), mas mockamos
// pra isolar a unidade de qualquer I/O externo.
vi.mock("@/lib/nf-webhook-handler", () => ({
  upsertNotaFiscal: vi.fn(async () => "nf-fake"),
}));

// Builder de query encadeável: todo método intermediário retorna `this`;
// os terminais resolvem conforme a tabela. O fluxo de classificarDevolucao
// (avariado) faz: claim update→select("id"), load .select("*").single(),
// e o lookup de quarentena .select("id").match().order().limit().maybeSingle().
// Sem quarentena ⇒ maybeSingle resolve null.
let quarentenaData: { id: string } | null = null;

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  // intermediários — devolvem o próprio builder
  for (const m of [
    "select",
    "insert",
    "update",
    "eq",
    "is",
    "match",
    "order",
    "limit",
    "not",
  ]) {
    builder[m] = chain;
  }
  // terminais
  builder.single = async () => {
    if (table === "siso_devolucoes_pendentes") {
      return {
        data: {
          status: "aguardando_classificacao",
          pedido_origem_mov_id: null,
          nota_fiscal_id: null,
          chave_acesso_nf: null,
          empresa_id: null,
          payload_webhook: null,
        },
        error: null,
      };
    }
    return { data: null, error: null };
  };
  builder.maybeSingle = async () => {
    if (table === "siso_localizacoes") return { data: quarentenaData };
    return { data: null };
  };
  // `.update(...).eq().eq().is().select("id")` resolve como thenable (array com
  // 1 row) pro claim atômico passar.
  builder.then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: [{ id: "d1" }], error: null });
  return builder;
}

vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => ({
    from: (t: string) => makeBuilder(t),
  }),
}));

import { resolverEmpresaReferencia, classificarDevolucao } from "./devolucoes";

describe("resolverEmpresaReferencia", () => {
  it("venda própria: referência = empresa vendedora", () => {
    expect(
      resolverEmpresaReferencia({
        origem_tipo: "nf_venda",
        empresa_vendedora_id: "v1",
      }),
    ).toBe("v1");
  });

  it("venda manual: referência = empresa vendedora", () => {
    expect(
      resolverEmpresaReferencia({
        origem_tipo: "venda_manual",
        empresa_vendedora_id: "v2",
      }),
    ).toBe("v2");
  });

  it("sem tag de vendedora: retorna null", () => {
    expect(
      resolverEmpresaReferencia({
        origem_tipo: "nf_venda",
        empresa_vendedora_id: null,
      }),
    ).toBeNull();
  });
});

describe("classificarDevolucao — avariado sem quarentena bloqueia [P051]", () => {
  it("lança ANTES de qualquer mov quando o galpão não tem loc tipo quarentena", async () => {
    movSpy.mockClear();
    quarentenaData = null; // galpão SEM quarentena
    await expect(
      classificarDevolucao({
        devolucao_id: "d1",
        classificacao: "avariado",
        produto_id: "11111111-1111-1111-1111-111111111111",
        galpao_id: "22222222-2222-2222-2222-222222222222",
        localizacao_id: "33333333-3333-3333-3333-333333333333",
        qty: 2,
        usuario_id: "44444444-4444-4444-4444-444444444444",
      }),
    ).rejects.toThrow(/quarentena/i);
    expect(movSpy).toHaveBeenCalledTimes(0);
  });
});
