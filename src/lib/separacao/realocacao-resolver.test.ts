import { describe, it, expect, vi } from "vitest";
import {
  resolverRealocacao,
  type ResolverDeps,
  type EstoqueCandidato,
} from "./realocacao-resolver";

const galpao = "galp1";
const locOriginal = "loc-original";

function makeDeps(estoque: EstoqueCandidato[]): ResolverDeps {
  return {
    listarSaldoCandidato: vi.fn(async () => estoque),
  };
}

describe("resolverRealocacao — pool fungível 3D", () => {
  it("retorna realocação na próxima loc com saldo suficiente", async () => {
    const deps = makeDeps([
      {
        localizacao_id: "loc-A",
        localizacao_codigo: "A-01-02",
        localizacao_tipo: "picking",
        disponivel: 5,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 2,
      },
      deps,
    );

    expect(r.status).toBe("realocado");
    expect(r.realocacoes).toHaveLength(1);
    expect(r.realocacoes[0]).toMatchObject({
      localizacao_id: "loc-A",
      quantidade: 2,
    });
  });

  it("prioriza picking > overstock", async () => {
    const deps = makeDeps([
      {
        localizacao_id: "loc-OS",
        localizacao_codigo: "OVER",
        localizacao_tipo: "overstock",
        disponivel: 10,
      },
      {
        localizacao_id: "loc-P",
        localizacao_codigo: "P",
        localizacao_tipo: "picking",
        disponivel: 3,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 2,
      },
      deps,
    );

    expect(r.realocacoes[0].localizacao_id).toBe("loc-P");
  });

  it("desempata por maior disponível dentro do mesmo tipo", async () => {
    const deps = makeDeps([
      {
        localizacao_id: "loc-small",
        localizacao_codigo: "S",
        localizacao_tipo: "picking",
        disponivel: 3,
      },
      {
        localizacao_id: "loc-big",
        localizacao_codigo: "B",
        localizacao_tipo: "picking",
        disponivel: 10,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 5,
      },
      deps,
    );

    expect(r.realocacoes[0].localizacao_id).toBe("loc-big");
    expect(r.realocacoes[0].quantidade).toBe(5);
  });

  it("fragmenta em múltiplas realocações quando uma loc não cobre", async () => {
    const deps = makeDeps([
      {
        localizacao_id: "loc-A",
        localizacao_codigo: "A",
        localizacao_tipo: "picking",
        disponivel: 2,
      },
      {
        localizacao_id: "loc-B",
        localizacao_codigo: "B",
        localizacao_tipo: "overstock",
        disponivel: 5,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
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

  it("retorna sem_cobertura quando residual > soma de todos os saldos", async () => {
    const deps = makeDeps([
      {
        localizacao_id: "loc-A",
        localizacao_codigo: "A",
        localizacao_tipo: "picking",
        disponivel: 1,
      },
    ]);

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
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
        galpao_id: galpao,
        localizacao_id_original: locOriginal,
        qty_residual: 1,
      },
      deps,
    );

    expect(r.status).toBe("sem_cobertura");
  });

  it("exclui múltiplas localizações via localizacoes_excluir", async () => {
    const deps: ResolverDeps = {
      listarSaldoCandidato: vi.fn(async ({ localizacao_id_excluir, localizacoes_excluir }) => {
        const todas: EstoqueCandidato[] = [
          {
            localizacao_id: "loc-A",
            localizacao_codigo: "A",
            localizacao_tipo: "picking",
            disponivel: 5,
          },
          {
            localizacao_id: "loc-B",
            localizacao_codigo: "B",
            localizacao_tipo: "picking",
            disponivel: 5,
          },
          {
            localizacao_id: "loc-C",
            localizacao_codigo: "C",
            localizacao_tipo: "picking",
            disponivel: 5,
          },
        ];
        const excluidas = new Set(
          localizacoes_excluir ?? (localizacao_id_excluir ? [localizacao_id_excluir] : []),
        );
        return todas.filter((c) => !excluidas.has(c.localizacao_id));
      }),
    };

    const r = await resolverRealocacao(
      {
        produto_id: "prod1",
        galpao_id: galpao,
        localizacoes_excluir: ["loc-A", "loc-B"],
        qty_residual: 3,
      },
      deps,
    );

    expect(r.status).toBe("realocado");
    expect(r.realocacoes).toHaveLength(1);
    expect(r.realocacoes[0].localizacao_id).toBe("loc-C");
  });
});
