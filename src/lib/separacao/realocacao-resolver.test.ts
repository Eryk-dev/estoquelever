import { describe, it, expect, vi } from "vitest";
import {
  resolverRealocacao,
  type ResolverDeps,
  type EstoqueCandidato,
} from "./realocacao-resolver";

const empresaOrigem = "empA";
const empresaOutra = "empB";
const galpao = "galp1";
const locOriginal = "loc-original";

function makeDeps(estoque: EstoqueCandidato[]): ResolverDeps {
  return {
    listarEmpresasDoGrupoMesmoGalpao: vi.fn(async () => [empresaOrigem, empresaOutra]),
    listarSaldoCandidato: vi.fn(async () => estoque),
  };
}

describe("resolverRealocacao", () => {
  it("retorna realocacao na mesma empresa quando há saldo suficiente", async () => {
    const deps = makeDeps([
      {
        empresa_dona_id: empresaOrigem,
        localizacao_id: "loc-A",
        localizacao_codigo: "A-01-02",
        localizacao_tipo: "picking",
        disponivel: 5,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 2,
      },
      deps,
    );

    expect(r.status).toBe("realocado");
    expect(r.realocacoes).toHaveLength(1);
    expect(r.realocacoes[0]).toMatchObject({
      empresa_dona_id: empresaOrigem,
      localizacao_id: "loc-A",
      quantidade: 2,
      is_emprestimo: false,
    });
  });

  it("prioriza mesma empresa > outra empresa do grupo", async () => {
    const deps = makeDeps([
      {
        empresa_dona_id: empresaOutra,
        localizacao_id: "loc-X",
        localizacao_codigo: "X",
        localizacao_tipo: "picking",
        disponivel: 10,
      },
      {
        empresa_dona_id: empresaOrigem,
        localizacao_id: "loc-Y",
        localizacao_codigo: "Y",
        localizacao_tipo: "picking",
        disponivel: 5,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 3,
      },
      deps,
    );

    expect(r.status).toBe("realocado");
    expect(r.realocacoes[0].empresa_dona_id).toBe(empresaOrigem);
    expect(r.realocacoes[0].is_emprestimo).toBe(false);
  });

  it("prioriza picking > overstock dentro da mesma empresa", async () => {
    const deps = makeDeps([
      {
        empresa_dona_id: empresaOrigem,
        localizacao_id: "loc-OS",
        localizacao_codigo: "OVER",
        localizacao_tipo: "overstock",
        disponivel: 10,
      },
      {
        empresa_dona_id: empresaOrigem,
        localizacao_id: "loc-P",
        localizacao_codigo: "P",
        localizacao_tipo: "picking",
        disponivel: 3,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 2,
      },
      deps,
    );

    expect(r.realocacoes[0].localizacao_id).toBe("loc-P");
  });

  it("fragmenta em múltiplas realocações quando uma loc não cobre", async () => {
    const deps = makeDeps([
      {
        empresa_dona_id: empresaOrigem,
        localizacao_id: "loc-A",
        localizacao_codigo: "A",
        localizacao_tipo: "picking",
        disponivel: 2,
      },
      {
        empresa_dona_id: empresaOrigem,
        localizacao_id: "loc-B",
        localizacao_codigo: "B",
        localizacao_tipo: "overstock",
        disponivel: 5,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 4,
      },
      deps,
    );

    expect(r.status).toBe("realocado");
    expect(r.realocacoes).toHaveLength(2);
    expect(r.realocacoes[0]).toMatchObject({ localizacao_id: "loc-A", quantidade: 2 });
    expect(r.realocacoes[1]).toMatchObject({ localizacao_id: "loc-B", quantidade: 2 });
  });

  it("marca is_emprestimo quando empresa diferente", async () => {
    const deps = makeDeps([
      {
        empresa_dona_id: empresaOutra,
        localizacao_id: "loc-A",
        localizacao_codigo: "A",
        localizacao_tipo: "picking",
        disponivel: 5,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 2,
      },
      deps,
    );

    expect(r.realocacoes[0].is_emprestimo).toBe(true);
    expect(r.realocacoes[0].empresa_devedora_id).toBe(empresaOrigem);
  });

  it("retorna sem_cobertura quando residual > soma de todos os saldos", async () => {
    const deps = makeDeps([
      {
        empresa_dona_id: empresaOrigem,
        localizacao_id: "loc-A",
        localizacao_codigo: "A",
        localizacao_tipo: "picking",
        disponivel: 1,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 5,
      },
      deps,
    );

    expect(r.status).toBe("sem_cobertura");
    expect(r.realocacoes).toHaveLength(0);
  });

  it("retorna sem_cobertura quando lista de candidatos vazia", async () => {
    const deps = makeDeps([]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        empresa_origem_id: empresaOrigem,
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 1,
      },
      deps,
    );

    expect(r.status).toBe("sem_cobertura");
  });
});
