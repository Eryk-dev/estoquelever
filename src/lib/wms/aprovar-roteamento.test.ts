import { describe, it, expect } from "vitest";
import { escolherGalpaoSeparacaoTransferencia } from "./aprovar-roteamento";

// Bug (2026-06-22): pedido transferência ficava órfão da própria reserva.
// No intake o webhook cria a R `reserva_pedido` no galpão de cobertura (CWB) e
// zera o `disponivel` daquele galpão. Na aprovação humana, /pedidos/aprovar
// RE-ROTEAVA contra siso_estoque.disponivel LIVE — que já está zerado pela
// PRÓPRIA reserva → rota=oc/sem-cobertura → fallback jogava separacao_galpao_id
// pra casa (SP). A reserva ficava em CWB, o pedido na fila do SP, impossível de
// separar ("saldo 0, sem loc"). Fix: quando há R viva, ela É o plano — vence o
// re-roteamento.
const CWB = "14e22fe9-cwb";
const SP = "afd7097a-sp";

describe("escolherGalpaoSeparacaoTransferencia", () => {
  it("reserva viva vence o re-roteamento furado (repro do bug órfão)", () => {
    // Cenário real: reserva em CWB, mas rota recém-rodada diz 'oc' porque a
    // própria reserva já zerou o disponível do CWB.
    const r = escolherGalpaoSeparacaoTransferencia({
      galpaoReservaViva: CWB,
      rotaDecisao: "oc",
      rotaGalpao: null,
      galpaoCasa: SP,
    });
    expect(r.galpao).toBe(CWB); // NÃO a casa (SP)
    expect(r.cobertura).toBe(true);
    expect(r.origem).toBe("reserva_viva");
  });

  it("sem reserva, rota cobre via transferência → usa o galpão da rota", () => {
    const r = escolherGalpaoSeparacaoTransferencia({
      galpaoReservaViva: null,
      rotaDecisao: "transferencia",
      rotaGalpao: CWB,
      galpaoCasa: SP,
    });
    expect(r.galpao).toBe(CWB);
    expect(r.cobertura).toBe(true);
    expect(r.origem).toBe("rota");
  });

  it("sem reserva e rota sem cobertura → fallback casa (sem cobertura)", () => {
    const r = escolherGalpaoSeparacaoTransferencia({
      galpaoReservaViva: null,
      rotaDecisao: "oc",
      rotaGalpao: null,
      galpaoCasa: SP,
    });
    expect(r.galpao).toBe(SP);
    expect(r.cobertura).toBe(false);
    expect(r.origem).toBe("fallback_casa");
  });

  it("reserva viva é fonte de verdade mesmo se a rota apontaria outro galpão", () => {
    const r = escolherGalpaoSeparacaoTransferencia({
      galpaoReservaViva: CWB,
      rotaDecisao: "transferencia",
      rotaGalpao: SP,
      galpaoCasa: SP,
    });
    expect(r.galpao).toBe(CWB);
    expect(r.origem).toBe("reserva_viva");
  });
});
