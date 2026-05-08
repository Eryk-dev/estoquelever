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
});

const galpaoCwb: GalpaoLite = { id: "g-cwb", cidade: "CWB", estado: "PR" };
const galpaoSp: GalpaoLite = { id: "g-sp", cidade: "SP", estado: "SP" };
const empresaA: EmpresaLite = { id: "a", galpao_id: "g-cwb" }; // home CWB
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
