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
const empresaA: EmpresaLite = { id: "a", galpoes_preferenciais: ["g-cwb"] }; // home CWB
// Empresa B simulada para testes de empréstimo (saldo em outra dona)

type BuscarLinha = RotearContext["buscarLinha"];

describe("rotearPedido", () => {
  it("auto-aprova quando vendedora tem todos os itens no galpão home", async () => {
    const buscar: BuscarLinha = async ({ produto_id, empresa_dona_id, galpao_id }) => {
      if (produto_id === "p1" && empresa_dona_id === "a" && galpao_id === "g-cwb") {
        return { id: "loc-cwb", localizacao_id: "lc1", disponivel: 5 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      itens: [{ produto_id: "p1", qty: 2 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("propria");
    if (r.decisao !== "oc") {
      expect(r.rotas).toHaveLength(1);
      expect(r.galpao_id).toBe("g-cwb");
    }
  });

  it("vai pra OC quando vendedora não tem e nenhuma credora cobre", async () => {
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      itens: [{ produto_id: "p1", qty: 2 }],
      buscarLinha: async () => null,
    });
    expect(r.decisao).toBe("oc");
    if (r.decisao === "oc") expect(r.motivo).toBe("sem_cobertura");
  });

  it("usa empréstimo quando próprio falha mas credora cobre tudo num galpão", async () => {
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (empresa_dona_id === "b" && galpao_id === "g-cwb") {
        return { id: "x", localizacao_id: "lc-x", disponivel: 5 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb],
      credoras: ["b"],
      itens: [{ produto_id: "p1", qty: 1 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("emprestimo");
  });

  it("vai pra OC com motivo split_galpoes quando cobertura exigiria 2 galpões", async () => {
    const buscar: BuscarLinha = async ({ produto_id, galpao_id }) => {
      if (produto_id === "p1" && galpao_id === "g-cwb") return { id: "1", localizacao_id: "lc1", disponivel: 5 };
      if (produto_id === "p2" && galpao_id === "g-sp") return { id: "2", localizacao_id: "lc2", disponivel: 5 };
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      itens: [
        { produto_id: "p1", qty: 1 },
        { produto_id: "p2", qty: 1 },
      ],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("oc");
    if (r.decisao === "oc") expect(r.motivo).toBe("split_galpoes");
  });

  it("prefere galpão home da vendedora quando há múltiplos candidatos", async () => {
    const buscar: BuscarLinha = async () => ({
      id: "x",
      localizacao_id: "lx",
      disponivel: 5,
    });
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      itens: [{ produto_id: "p1", qty: 1 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("propria");
    if (r.decisao !== "oc") expect(r.galpao_id).toBe("g-cwb");
  });
});

// ─── Plano 4: testes de swap ─────────────────────────────────────────────
describe("rotearPedido — swap (Plano 4)", () => {
  it("escolhe swap quando V não tem em home mas par tem + V tem espelho", async () => {
    // V vendendo p1 qty=2.
    // home V = CWB. Em CWB: NetParts tem p1 (qty>=2). Em SP: V tem p1 (qty>=2).
    // Swap deveria rolar: V ganha em CWB, NetParts ganha em SP.
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (empresa_dona_id === "np" && galpao_id === "g-cwb") {
        return { id: "lc-cwb-np", localizacao_id: "lc-cwb-np", disponivel: 10 };
      }
      if (empresa_dona_id === "a" && galpao_id === "g-sp") {
        return { id: "lc-sp-a", localizacao_id: "lc-sp-a", disponivel: 10 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      swapPartners: ["np"],
      itens: [{ produto_id: "p1", qty: 2 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("propria"); // decisao agregada continua propria
    if (r.decisao !== "oc") {
      expect(r.rotas).toHaveLength(1);
      expect(r.rotas[0].tipo).toBe("swap");
      expect(r.rotas[0].galpao_id).toBe("g-cwb");
      expect(r.rotas[0].empresa_dona_id).toBe("a");
      expect(r.rotas[0].swap?.empresa_par_id).toBe("np");
      expect(r.rotas[0].swap?.galpao_par_id).toBe("g-sp");
    }
  });

  it("ignora swap quando V não tem espelho em nenhum outro galpão", async () => {
    // NetParts tem em CWB mas V não tem em SP — sem espelho → não-swap.
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (empresa_dona_id === "np" && galpao_id === "g-cwb") {
        return { id: "x", localizacao_id: "lx", disponivel: 10 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      swapPartners: ["np"],
      itens: [{ produto_id: "p1", qty: 2 }],
      buscarLinha: buscar,
    });
    // Sem swap nem própria nem empréstimo (credoras=[]) → OC
    expect(r.decisao).toBe("oc");
  });

  it("prefere própria sobre swap mesmo quando swap é possível", async () => {
    // V tem direto em CWB E swap também seria possível. Própria ganha.
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (empresa_dona_id === "a" && galpao_id === "g-cwb") {
        return { id: "own", localizacao_id: "lown", disponivel: 10 };
      }
      if (empresa_dona_id === "np" && galpao_id === "g-cwb") {
        return { id: "np-cwb", localizacao_id: "lnp-cwb", disponivel: 10 };
      }
      if (empresa_dona_id === "a" && galpao_id === "g-sp") {
        return { id: "v-sp", localizacao_id: "lv-sp", disponivel: 10 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      swapPartners: ["np"],
      itens: [{ produto_id: "p1", qty: 1 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("propria");
    if (r.decisao !== "oc") {
      expect(r.rotas[0].tipo).toBe("propria");
      expect(r.rotas[0].localizacao_id).toBe("lown");
    }
  });

  it("prefere swap sobre empréstimo quando ambos são viáveis", async () => {
    // V não tem em CWB. NetParts (swap partner) tem em CWB + V tem em SP.
    // OutraEmpresa (credora) também tem em CWB.
    // Swap deve ganhar (não cria saldo devedor).
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (empresa_dona_id === "np" && galpao_id === "g-cwb") {
        return { id: "np-cwb", localizacao_id: "lnp-cwb", disponivel: 10 };
      }
      if (empresa_dona_id === "credora" && galpao_id === "g-cwb") {
        return { id: "cred-cwb", localizacao_id: "lcred", disponivel: 10 };
      }
      if (empresa_dona_id === "a" && galpao_id === "g-sp") {
        return { id: "a-sp", localizacao_id: "la-sp", disponivel: 10 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: ["credora"],
      swapPartners: ["np"],
      itens: [{ produto_id: "p1", qty: 1 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("propria");
    if (r.decisao !== "oc") {
      expect(r.rotas[0].tipo).toBe("swap");
      expect(r.rotas[0].swap?.empresa_par_id).toBe("np");
    }
  });

  it("cai pra empréstimo quando swap falha por falta de espelho", async () => {
    // NetParts tem em CWB. V não tem em outro galpão (sem espelho). Credora
    // tem em CWB → empréstimo.
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (empresa_dona_id === "np" && galpao_id === "g-cwb") {
        return { id: "np", localizacao_id: "lnp", disponivel: 10 };
      }
      if (empresa_dona_id === "credora" && galpao_id === "g-cwb") {
        return { id: "cred", localizacao_id: "lcred", disponivel: 10 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: ["credora"],
      swapPartners: ["np"],
      itens: [{ produto_id: "p1", qty: 1 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("emprestimo");
    if (r.decisao !== "oc") {
      expect(r.rotas[0].tipo).toBe("emprestimo");
      expect(r.rotas[0].empresa_dona_id).toBe("credora");
    }
  });

  it("OC quando swap impossível e sem credoras", async () => {
    // NetParts tem em CWB, mas V não tem em outro lugar. Sem credoras. → OC.
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (empresa_dona_id === "np" && galpao_id === "g-cwb") {
        return { id: "x", localizacao_id: "lx", disponivel: 10 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaA,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      swapPartners: ["np"],
      itens: [{ produto_id: "p1", qty: 1 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("oc");
  });
});
