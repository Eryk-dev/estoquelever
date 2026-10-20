import { describe, expect, it } from "vitest";
import {
  classifyMlReconciliation as classify, isBellator, orderAgeDays,
  type MlReconciliationEvidence, type ReconciliationSnapshot,
} from "./ml-reconciliation-policy";

const now = new Date("2026-10-20T16:00:00Z");
const order: ReconciliationSnapshot = {
  id: "1", empresa_origem_id: "company", id_pedido_ecommerce: "100", ml_shipment_id: "200",
  status_separacao: "em_separacao", etiqueta_status: null, data: "2026-10-19",
  decisao_final: "propria", impressao_em: null, atividade_em: "2026-10-20T10:00:00Z",
};
const shipment: MlReconciliationEvidence = {
  kind: "shipment", resourceId: "200", orderReference: "100", connectionId: "conn", sellerId: "300",
  checkedAt: now.toISOString(), status: "ready_to_ship", substatus: "ready_to_print",
  noShipping: false, history: [],
};
const event = (substatus: string) => ({ date: "2026-10-20T13:00:00Z", status: "ready_to_ship", substatus });

describe("conferência ML das etapas", () => {
  it.each(["shipped", "delivered"])("envio %s tem precedência sobre impressão", status => {
    expect(classify({ ...order, etiqueta_status: "impresso" }, { ...shipment, status }, now).target).toBe("expedido");
  });
  it("encontra coleta anterior a in_packing_list, que escondia o despacho", () => {
    expect(classify(order, { ...shipment, substatus: "in_packing_list", history: [
      event("printed"), event("picked_up"), event("in_hub"), event("in_packing_list"),
    ] }, now)).toMatchObject({ target: "expedido", collected: true });
  });
  it.each(["printed", "ready_for_pickup", "in_pickup_list"])("%s não prova coleta", substatus => {
    expect(classify(order, { ...shipment, substatus, history: [event("printed")] }, now))
      .toMatchObject({ target: "embalado", collected: false });
  });
  it("registra perda/devolução como enviado somente quando houve coleta", () => {
    expect(classify(order, { ...shipment, status: "not_delivered", history: [event("picked_up")] }, now).target).toBe("expedido");
    expect(classify(order, { ...shipment, status: "not_delivered" }, now).target).toBeNull();
  });
  it("não reabre ou despacha cancelamentos", () => {
    expect(classify(order, { ...shipment, status: "cancelled", history: [event("picked_up")] }, now).target).toBeNull();
  });
  it("histórico local de impressão vale mesmo se etiqueta_status foi limpo", () => {
    expect(classify({ ...order, impressao_em: "2026-10-19T13:00:00Z" }, shipment, now).target).toBe("embalado");
  });
  it("etiqueta gerada, data de embalagem antiga e falha de impressão não provam impressão", () => {
    expect(classify({ ...order, etiqueta_status: "falhou", embalagem_concluida_em: "2026-08-01" }, shipment, now))
      .toMatchObject({ target: "aguardando_separacao", printed: false });
  });
  it("preserva a separação ativa e devolve a abandonada ao completar 2h", () => {
    expect(classify({ ...order, atividade_em: "2026-10-20T14:00:01Z" }, shipment, now).target).toBeNull();
    expect(classify({ ...order, atividade_em: "2026-10-20T14:00:00Z" }, shipment, now).target).toBe("aguardando_separacao");
    expect(classify({ ...order, atividade_em: "inválida" }, shipment, now).target).toBeNull();
  });
  it("mantém o roteamento OC ao voltar para Pra separar", () => {
    expect(classify({ ...order, decisao_final: "oc" }, shipment, now).target).toBe("validacao_oc");
  });
  it.each(["embalado", "conferido", "expedido"])("não regride %s", status_separacao => {
    expect(classify({ ...order, status_separacao }, shipment, now).target).toBeNull();
  });
  it("regra de idade exige no_shipping confirmado e mais de 20 dias", () => {
    const noShipping: MlReconciliationEvidence = { ...shipment, kind: "order", status: "paid", substatus: null, noShipping: true };
    expect(classify({ ...order, data: "2026-09-29" }, noShipping, now))
      .toMatchObject({ target: "embalado", reason: "sem_rastreio_mais_20_dias", printed: false, collected: false });
    expect(classify({ ...order, data: "2026-09-30" }, noShipping, now).target).toBe("aguardando_separacao");
    expect(classify({ ...order, data: "2026-05-01" }, shipment, now).target).toBe("aguardando_separacao");
    expect(classify({ ...order, data: "2026-05-01" }, { ...noShipping, noShipping: false }, now).target).toBeNull();
  });
  it("limiar usa o dia de São Paulo, inclusive antes de meia-noite local", () => {
    expect(orderAgeDays("2026-09-29", new Date("2026-10-20T01:00:00Z"))).toBe(20);
    expect(orderAgeDays("2026-09-29", now)).toBe(21);
  });
  it("exclui Bellator apesar de caixa ou espaços", () => {
    expect(isBellator("  BELLATOR ")).toBe(true);
    expect(isBellator("EasyPeasy SP")).toBe(false);
  });
});
