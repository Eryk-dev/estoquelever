import { describe, it, expect } from "vitest";
import { rotearPedido } from "./roteamento";
import type { GalpaoLite, EmpresaLite, RotearContext } from "./roteamento";

const galpaoCwb: GalpaoLite = { id: "g-cwb", cidade: "CWB", estado: "PR" };
const galpaoSp: GalpaoLite = { id: "g-sp", cidade: "SP", estado: "SP" };
const empresaNetair: EmpresaLite = { id: "netair", galpoes_preferenciais: ["g-cwb"] };

type BuscarLinha = RotearContext["buscarLinha"];

// ─────────────────────────────────────────────────────────────────────────
// Cenário 2 — Fragmentação de qty: swap parcial + empréstimo + combinações
// (refatorado pós-implementação da fragmentação no algoritmo)
// ─────────────────────────────────────────────────────────────────────────
describe("Cenário 2 — Fragmentação de qty (swap parcial + empréstimo combinado)", () => {
  it("quando partner cobre só parte do qty, combina swap parcial + empréstimo da credora", async () => {
    // V quer qty=10 em CWB. V tem qty=10 em SP (espelho ok).
    // NetParts (partner) tem qty=3 em CWB (parcial).
    // Credora tem qty=10 em CWB (cobre o resto via empréstimo).
    // Resultado esperado: 2 rotas — 1 swap (qty=3) + 1 empréstimo (qty=7).
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (empresa_dona_id === "netparts" && galpao_id === "g-cwb") {
        return { id: "np", localizacao_id: "lnp", disponivel: 3 };
      }
      if (empresa_dona_id === "credora" && galpao_id === "g-cwb") {
        return { id: "cred", localizacao_id: "lcred", disponivel: 10 };
      }
      if (empresa_dona_id === "netair" && galpao_id === "g-sp") {
        return { id: "v-sp", localizacao_id: "lv-sp", disponivel: 10 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaNetair,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: ["credora"],
      swapPartners: ["netparts"],
      itens: [{ produto_id: "PEC", qty: 10 }],
      buscarLinha: buscar,
    });
    // Tudo no galpão CWB (preferencial) — vira "emprestimo" porque uma rota é emprestimo
    expect(r.decisao).toBe("emprestimo");
    if (r.decisao !== "oc") {
      expect(r.galpao_id).toBe("g-cwb");
      expect(r.rotas).toHaveLength(2);
      const swap = r.rotas.find((x) => x.tipo === "swap");
      const emprestimo = r.rotas.find((x) => x.tipo === "emprestimo");
      expect(swap?.qty).toBe(3);
      expect(swap?.swap?.empresa_par_id).toBe("netparts");
      expect(emprestimo?.qty).toBe(7);
      expect(emprestimo?.empresa_dona_id).toBe("credora");
      // qtys somam o pedido
      expect(r.rotas.reduce((s, x) => s + x.qty, 0)).toBe(10);
    }
  });

  it("quando partner cobre só parte E V não cobre como própria em nenhum galpão, cai em OC inteiro", async () => {
    // V quer qty=10. Partner tem só qty=3 em CWB. V tem qty=5 em SP (insuficiente).
    // - Galpão CWB: V não tem, swap parcial é ignorado, sem credora → não cobre.
    // - Galpão SP: V tem só 5 (gte 10 falha) → não cobre.
    // → OC qty inteiro. Confirma que swap parcial NÃO entra em jogo.
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id, qty }) => {
      if (empresa_dona_id === "netparts" && galpao_id === "g-cwb") {
        if (qty > 3) return null;
        return { id: "np", localizacao_id: "lnp", disponivel: 3 };
      }
      if (empresa_dona_id === "netair" && galpao_id === "g-sp") {
        if (qty > 5) return null;
        return { id: "v-sp", localizacao_id: "lv-sp", disponivel: 5 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaNetair,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      swapPartners: ["netparts"],
      itens: [{ produto_id: "PEC", qty: 10 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("oc");
  });

  it("FEEDBACK DO USUÁRIO: com 2 partners que somam o qty (3+7), algoritmo COMBINA 2 swaps em uma transação", async () => {
    // NetAir quer qty=10 em CWB. NetAir tem qty=10 em SP (espelho).
    // NetParts tem qty=3 em CWB. 141AIR tem qty=7 em CWB.
    // Resultado: 2 swaps (3 com NetParts + 7 com 141AIR) → tudo em CWB, zero dívida.
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (empresa_dona_id === "netparts" && galpao_id === "g-cwb") {
        return { id: "np", localizacao_id: "lnp", disponivel: 3 };
      }
      if (empresa_dona_id === "141air" && galpao_id === "g-cwb") {
        return { id: "141", localizacao_id: "l141", disponivel: 7 };
      }
      if (empresa_dona_id === "netair" && galpao_id === "g-sp") {
        return { id: "v-sp", localizacao_id: "lv-sp", disponivel: 10 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaNetair,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: ["netparts", "141air"],
      swapPartners: ["netparts", "141air"],
      itens: [{ produto_id: "PEC", qty: 10 }],
      buscarLinha: buscar,
    });
    // 2 swaps combinados — todos no preferencial CWB, sem penalização ML.
    expect(r.decisao).toBe("propria");
    if (r.decisao !== "oc") {
      expect(r.galpao_id).toBe("g-cwb");
      expect(r.rotas).toHaveLength(2);
      expect(r.rotas.every((x) => x.tipo === "swap")).toBe(true);
      const partners = r.rotas.map((x) => x.swap?.empresa_par_id).sort();
      expect(partners).toEqual(["141air", "netparts"]);
      // qtys somam o pedido
      expect(r.rotas.reduce((s, x) => s + x.qty, 0)).toBe(10);
    }
  });

  it("Sem espelho: 2 credoras que somam o qty COMBINAM em 2 empréstimos", async () => {
    // Mesma config sem o espelho da NetAir. NetParts=3 + 141AIR=7 = 10 em CWB.
    // Sem espelho swap é impossível — algoritmo cai pra 2 empréstimos parciais.
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (empresa_dona_id === "netparts" && galpao_id === "g-cwb") {
        return { id: "np", localizacao_id: "lnp", disponivel: 3 };
      }
      if (empresa_dona_id === "141air" && galpao_id === "g-cwb") {
        return { id: "141", localizacao_id: "l141", disponivel: 7 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaNetair,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: ["netparts", "141air"],
      swapPartners: ["netparts", "141air"],
      itens: [{ produto_id: "PEC", qty: 10 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("emprestimo");
    if (r.decisao !== "oc") {
      expect(r.galpao_id).toBe("g-cwb");
      expect(r.rotas).toHaveLength(2);
      expect(r.rotas.every((x) => x.tipo === "emprestimo")).toBe(true);
      expect(r.rotas.reduce((s, x) => s + x.qty, 0)).toBe(10);
    }
  });

  it("APRENDIZADO: se partner tem parcial mas V tem espelho que cobre o pedido, algoritmo despacha do espelho como própria (NÃO faz swap parcial)", async () => {
    // V quer qty=10. Partner tem qty=3 em CWB. V tem qty=10 em SP.
    // O algoritmo NÃO combina swap parcial. Simplesmente escolhe SP como próprio.
    // Esse comportamento revela que swap só roda quando cobre 100% no galpão.
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id, qty }) => {
      if (empresa_dona_id === "netparts" && galpao_id === "g-cwb") {
        if (qty > 3) return null;
        return { id: "np", localizacao_id: "lnp", disponivel: 3 };
      }
      if (empresa_dona_id === "netair" && galpao_id === "g-sp") {
        return { id: "v-sp", localizacao_id: "lv-sp", disponivel: 10 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaNetair,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      swapPartners: ["netparts"],
      itens: [{ produto_id: "PEC", qty: 10 }],
      buscarLinha: buscar,
    });
    // Algoritmo escolhe SP (própria) em vez de fazer swap parcial em CWB.
    // ML penaliza por despachar de SP, mas a alternativa seria OC (pior).
    expect(r.decisao).toBe("propria");
    if (r.decisao !== "oc") {
      expect(r.galpao_id).toBe("g-sp");
      expect(r.rotas[0].tipo).toBe("propria");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cenário 5 — Despacho fora do preferencial (com penalização ML)
// ─────────────────────────────────────────────────────────────────────────
describe("Cenário 5 — Despacho fora do preferencial (penalização ML)", () => {
  it("quando V só tem estoque em galpão não-home, despacha de lá como própria", async () => {
    // V (preferencial=CWB) quer qty=2.
    // V tem qty=2 só em SP (não-home).
    // Ninguém tem em CWB pra swap nem empréstimo.
    // Esperado: decisao=propria, galpao_id=SP (não CWB).
    // Operador despacha de SP — ML penaliza, mas pedido sai.
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (empresa_dona_id === "netair" && galpao_id === "g-sp") {
        return { id: "v-sp", localizacao_id: "lv-sp", disponivel: 2 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaNetair,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      swapPartners: [],
      itens: [{ produto_id: "PEC", qty: 2 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("propria");
    if (r.decisao !== "oc") {
      expect(r.galpao_id).toBe("g-sp"); // ← saiu de SP, NÃO de CWB
      expect(r.rotas[0].tipo).toBe("propria");
      expect(r.rotas[0].empresa_dona_id).toBe("netair");
      expect(r.rotas[0].galpao_id).toBe("g-sp");
    }
  });

  it("prefere galpão home quando ambos cobrem (não usa galpão não-home gratuitamente)", async () => {
    // V tem em CWB E em SP. Algoritmo deve escolher CWB (home, geo-priority 0).
    const buscar: BuscarLinha = async ({ empresa_dona_id }) => {
      if (empresa_dona_id === "netair") {
        return { id: "v", localizacao_id: "lv", disponivel: 5 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaNetair,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      swapPartners: [],
      itens: [{ produto_id: "PEC", qty: 1 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("propria");
    if (r.decisao !== "oc") {
      expect(r.galpao_id).toBe("g-cwb"); // ← preferiu o home
    }
  });

  it("quando home NÃO cobre mas tem 2 galpões não-home, escolhe o de menor geo-priority", async () => {
    // home = CWB (PR). Galpões: SP (estado diferente, gp=3) e Curitiba2 (mesma cidade, gp=1).
    // V só tem em ambos não-home. Deve escolher Curitiba2 (gp=1).
    const galpaoCwb2: GalpaoLite = { id: "g-cwb2", cidade: "CWB", estado: "PR" };
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (empresa_dona_id === "netair" && galpao_id !== "g-cwb") {
        return { id: galpao_id, localizacao_id: "l" + galpao_id, disponivel: 5 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaNetair,
      galpoes: [galpaoCwb, galpaoCwb2, galpaoSp],
      credoras: [],
      swapPartners: [],
      itens: [{ produto_id: "PEC", qty: 1 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("propria");
    if (r.decisao !== "oc") {
      expect(r.galpao_id).toBe("g-cwb2"); // mesma cidade (gp=1) vence SP (gp=3)
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cenário 7 — Swap regular (algoritmo é agnóstico à preferência do partner)
// ─────────────────────────────────────────────────────────────────────────
describe("Cenário 7 — Swap regular (partner fica fora do preferencial dela)", () => {
  it("algoritmo faz swap mesmo quando o partner é uma quarta empresa hipotética com preferencial igual à vendedora", async () => {
    // Hipótese: existe TechCWB (id='techcwb') que também prefere CWB.
    // V (NetAir, pref=CWB) quer qty=5 em CWB.
    // V tem em SP. TechCWB tem em CWB.
    // Swap: NetAir vira dona em CWB (perfeito pra ela), TechCWB vira dona em SP
    // (fora do preferencial dela — "swap regular" da perspectiva contábil).
    // O algoritmo não sabe da preferência do partner — ele só faz o swap.
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (empresa_dona_id === "techcwb" && galpao_id === "g-cwb") {
        return { id: "tc-cwb", localizacao_id: "ltc-cwb", disponivel: 10 };
      }
      if (empresa_dona_id === "netair" && galpao_id === "g-sp") {
        return { id: "v-sp", localizacao_id: "lv-sp", disponivel: 10 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaNetair,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      swapPartners: ["techcwb"],
      itens: [{ produto_id: "PEC", qty: 5 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("propria");
    if (r.decisao !== "oc") {
      expect(r.rotas[0].tipo).toBe("swap");
      expect(r.rotas[0].galpao_id).toBe("g-cwb"); // V ganhou em CWB
      expect(r.rotas[0].swap?.empresa_par_id).toBe("techcwb");
      expect(r.rotas[0].swap?.galpao_par_id).toBe("g-sp"); // TechCWB foi pra SP
    }
  });

  it("entre múltiplos partners disponíveis, usa o primeiro que dá match (sem preferência por preferencial)", async () => {
    // V tem espelho em SP. Dois partners têm em CWB: netparts (id1) e techcwb (id2).
    // Algoritmo escolhe o primeiro da lista swapPartners — não otimiza por preferência.
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (galpao_id === "g-cwb" && (empresa_dona_id === "netparts" || empresa_dona_id === "techcwb")) {
        return { id: empresa_dona_id, localizacao_id: "l" + empresa_dona_id, disponivel: 10 };
      }
      if (empresa_dona_id === "netair" && galpao_id === "g-sp") {
        return { id: "v-sp", localizacao_id: "lv-sp", disponivel: 10 };
      }
      return null;
    };
    const r = await rotearPedido({
      vendedora: empresaNetair,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      swapPartners: ["netparts", "techcwb"], // ordem: netparts primeiro
      itens: [{ produto_id: "PEC", qty: 2 }],
      buscarLinha: buscar,
    });
    expect(r.decisao).toBe("propria");
    if (r.decisao !== "oc") {
      expect(r.rotas[0].tipo).toBe("swap");
      expect(r.rotas[0].swap?.empresa_par_id).toBe("netparts"); // 1º da lista
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cenário 8 — Concorrência (algoritmo é determinístico; lock é responsabilidade do banco)
// ─────────────────────────────────────────────────────────────────────────
describe("Cenário 8 — Concorrência (comportamento do algoritmo)", () => {
  it("duas chamadas paralelas com o mesmo estado retornam o mesmo plano (algoritmo é puro)", async () => {
    // Algoritmo é stateless — duas chamadas com mesmo input dão mesmo output.
    // A proteção real contra race condition é o lock pessimista do banco,
    // que acontece DENTRO de wms_inserir_movimentacao (não testado aqui).
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id }) => {
      if (empresa_dona_id === "netparts" && galpao_id === "g-cwb") {
        return { id: "np-cwb", localizacao_id: "lnp-cwb", disponivel: 3 };
      }
      if (empresa_dona_id === "netair" && galpao_id === "g-sp") {
        return { id: "v-sp", localizacao_id: "lv-sp", disponivel: 3 };
      }
      return null;
    };
    const ctx: RotearContext = {
      vendedora: empresaNetair,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      swapPartners: ["netparts"],
      itens: [{ produto_id: "PEC", qty: 3 }],
      buscarLinha: buscar,
    };
    const [r1, r2] = await Promise.all([rotearPedido(ctx), rotearPedido(ctx)]);
    expect(r1.decisao).toBe("propria");
    expect(r2.decisao).toBe("propria");
    if (r1.decisao !== "oc" && r2.decisao !== "oc") {
      expect(r1.rotas[0].tipo).toBe("swap");
      expect(r2.rotas[0].tipo).toBe("swap");
      // Mesmas escolhas (algoritmo é determinístico)
      expect(r1.galpao_id).toBe(r2.galpao_id);
    }
    // NOTA: ambos retornam o mesmo plano porque buscarLinha é fake.
    // Em prod, só uma das duas chamadas a wms_inserir_movimentacao
    // consegue o lock — a outra recebe erro de saldo insuficiente e
    // o webhook re-tenta com estado atualizado.
  });

  it("quando estoque baixa entre 1ª e 2ª chamada (simulando race), a 2ª degrada pra outra rota", async () => {
    // Simula que o estoque do partner E o espelho da V foram consumidos após a 1ª leitura.
    // Após o swap, ambos foram "movidos" contábilmente — em prod, o lock do banco
    // garantiria que a 2ª chamada veja o estado atualizado.
    let chamadas = 0;
    const LIMITE_CHAMADAS_COM_ESTOQUE = 10; // 1ª rodada (~5-7 chamadas) tem estoque
    const buscar: BuscarLinha = async ({ empresa_dona_id, galpao_id, qty }) => {
      chamadas++;
      const aindaTemEstoque = chamadas <= LIMITE_CHAMADAS_COM_ESTOQUE;
      // Partner perde estoque após 1ª rodada
      if (empresa_dona_id === "netparts" && galpao_id === "g-cwb" && aindaTemEstoque) {
        if (qty > 3) return null;
        return { id: "np-cwb", localizacao_id: "lnp-cwb", disponivel: 3 };
      }
      // V perde espelho em SP após 1ª rodada (foi swapado contábilmente)
      if (empresa_dona_id === "netair" && galpao_id === "g-sp" && aindaTemEstoque) {
        if (qty > 3) return null;
        return { id: "v-sp", localizacao_id: "lv-sp", disponivel: 3 };
      }
      return null;
    };
    const ctx: RotearContext = {
      vendedora: empresaNetair,
      galpoes: [galpaoCwb, galpaoSp],
      credoras: [],
      swapPartners: ["netparts"],
      itens: [{ produto_id: "PEC", qty: 3 }],
      buscarLinha: buscar,
    };
    const r1 = await rotearPedido(ctx);
    // Reseta o contador pra "simular" 2 invocações distintas pós-consumo
    chamadas = LIMITE_CHAMADAS_COM_ESTOQUE + 1;
    const r2 = await rotearPedido(ctx);
    expect(r1.decisao).toBe("propria"); // 1ª pegou swap
    // 2ª chamada não tem mais nem partner nem espelho → OC
    expect(r2.decisao).toBe("oc");
  });
});
