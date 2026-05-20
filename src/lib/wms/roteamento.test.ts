import { describe, it, expect } from "vitest";
import { rotearPedido, geoPriority } from "./roteamento";
import type { GalpaoLite, EmpresaLite, RotearContext } from "./roteamento";

describe("geoPriority", () => {
  const home: GalpaoLite = { id: "h", cidade: "CWB", estado: "PR" };

  it("home tem prioridade 0", () => {
    expect(geoPriority({ id: "h", cidade: "CWB", estado: "PR" }, home)).toBe(0);
  });

  it("mesma cidade vira 1", () => {
    expect(geoPriority({ id: "x", cidade: "CWB", estado: "PR" }, home)).toBe(1);
  });

  it("mesmo estado vira 2", () => {
    expect(geoPriority({ id: "x", cidade: "FOZ", estado: "PR" }, home)).toBe(2);
  });

  it("estado diferente vira 3", () => {
    expect(geoPriority({ id: "x", cidade: "SP", estado: "SP" }, home)).toBe(3);
  });

  it("array de homes — retorna a menor distância entre todos", () => {
    const homes: GalpaoLite[] = [
      { id: "h1", cidade: "CWB", estado: "PR" },
      { id: "h2", cidade: "SP", estado: "SP" },
    ];
    expect(geoPriority({ id: "h2", cidade: "SP", estado: "SP" }, homes)).toBe(0);
    expect(geoPriority({ id: "x", cidade: "SP", estado: "SP" }, homes)).toBe(1);
    expect(geoPriority({ id: "x", cidade: "FOZ", estado: "PR" }, homes)).toBe(2);
    expect(geoPriority({ id: "x", cidade: "RJ", estado: "RJ" }, homes)).toBe(3);
  });

  it("array vazio — todos empatam em 0 (sem preferência geo)", () => {
    expect(
      geoPriority({ id: "x", cidade: "RJ", estado: "RJ" }, [] as GalpaoLite[]),
    ).toBe(0);
  });
});

const galpaoCwb: GalpaoLite = { id: "g-cwb", cidade: "CWB", estado: "PR" };
const galpaoSp: GalpaoLite = { id: "g-sp", cidade: "SP", estado: "SP" };
// home CWB — pool fungível: só importa pra decidir "propria" vs "transferencia".
const empresaA: EmpresaLite = { id: "a", galpoes_preferenciais: ["g-cwb"] };

type BuscarLinha = RotearContext["buscarLinha"];

describe("rotearPedido — pool fungível 3D", () => {
  it("propria: galpão home cobre tudo", async () => {
    const buscar: BuscarLinha = async ({ galpao_id }) => {
      if (galpao_id === "g-cwb") {
        return { id: "loc-cwb", localizacao_id: "lc1", disponivel: 5 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      itens: [{ produto_id: "p1", qty: 2 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("propria");
    if (r.decisao !== "oc") {
      expect(r.galpao_id).toBe("g-cwb");
      expect(r.rotas).toHaveLength(1);
      expect(r.rotas[0].tipo).toBe("propria");
      expect(r.rotas[0].localizacao_id).toBe("lc1");
      expect(r.rotas[0].qty).toBe(2);
    }
  });

  it("transferencia: outro galpão cobre, home não", async () => {
    const buscar: BuscarLinha = async ({ galpao_id }) => {
      if (galpao_id === "g-sp") {
        return { id: "loc-sp", localizacao_id: "lsp", disponivel: 10 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      itens: [{ produto_id: "p1", qty: 3 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("transferencia");
    if (r.decisao !== "oc") {
      expect(r.galpao_id).toBe("g-sp");
      expect(r.rotas[0].tipo).toBe("transferencia");
    }
  });

  it("oc(sem_cobertura): nenhum galpão tem nada", async () => {
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      itens: [{ produto_id: "p1", qty: 2 }],
      buscarLinha: async () => null,
    });
    expect(r.decisao).toBe("oc");
    if (r.decisao === "oc") expect(r.motivo).toBe("sem_cobertura");
  });

  it("oc(split_galpoes): cobertura existe mas dividida em galpões", async () => {
    const buscar: BuscarLinha = async ({ produto_id, galpao_id }) => {
      if (produto_id === "p1" && galpao_id === "g-cwb") {
        return { id: "1", localizacao_id: "lc1", disponivel: 5 };
      }
      if (produto_id === "p2" && galpao_id === "g-sp") {
        return { id: "2", localizacao_id: "lc2", disponivel: 5 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      itens: [
        { produto_id: "p1", qty: 1 },
        { produto_id: "p2", qty: 1 },
      ],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("oc");
    if (r.decisao === "oc") expect(r.motivo).toBe("split_galpoes");
  });

  it("prefere home quando ambos os galpões cobrem", async () => {
    const buscar: BuscarLinha = async () => ({
      id: "x",
      localizacao_id: "lx",
      disponivel: 5,
    });
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      itens: [{ produto_id: "p1", qty: 1 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("propria");
    if (r.decisao !== "oc") {
      expect(r.galpao_id).toBe("g-cwb");
      expect(r.rotas[0].tipo).toBe("propria");
    }
  });

  it("sem preferência geográfica (homes vazio) — propria mesmo em galpão arbitrário", async () => {
    const empresaSemHome: EmpresaLite = { id: "b", galpoes_preferenciais: [] };
    const buscar: BuscarLinha = async ({ galpao_id }) => {
      if (galpao_id === "g-sp") {
        return { id: "x", localizacao_id: "lx", disponivel: 3 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaSemHome,
      galpoes: [galpaoCwb, galpaoSp],
      itens: [{ produto_id: "p1", qty: 1 }],
      buscarLinha: buscar,
    });
    // homes vazio → geoPriority sempre 0 → decisao='propria' em qualquer galpão.
    expect(r.decisao).toBe("propria");
    if (r.decisao !== "oc") {
      expect(r.galpao_id).toBe("g-sp");
    }
  });

  it("qty parcial num galpão não basta — exige cobertura completa por galpão", async () => {
    // CWB tem 1, SP tem 1, pedido pede 2. Nenhum galpão sozinho cobre.
    // Resultado: oc(split_galpoes) — não tenta dividir.
    const buscar: BuscarLinha = async ({ qty }) => {
      // Sempre devolve disponivel=1, mas só satisfaz pedidos de qty<=1
      if (qty > 1) return null;
      return { id: "x", localizacao_id: "lx", disponivel: 1 };
    };
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      itens: [{ produto_id: "p1", qty: 2 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("oc");
    if (r.decisao === "oc") expect(r.motivo).toBe("split_galpoes");
  });
});
