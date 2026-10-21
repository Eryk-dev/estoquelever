import { describe, expect, it } from "vitest";
import {
  classifyMlReconciliation as classify, isBellator,
  type MlReconciliationEvidence, type ReconciliationSnapshot,
} from "./ml-reconciliation-policy";

const order: ReconciliationSnapshot = {
  id: "1", empresa_origem_id: "company", id_pedido_ecommerce: "100", ml_shipment_id: "200",
  status_separacao: "embalado", etiqueta_status: "impresso", data: "2026-10-19",
  decisao_final: "propria", impressao_em: null, atividade_em: "2026-10-20T10:00:00Z",
};
const shipment: MlReconciliationEvidence = {
  kind: "shipment", resourceId: "200", orderReference: "100", connectionId: "conn", sellerId: "300",
  checkedAt: "2026-10-20T16:00:00Z", status: "ready_to_ship", substatus: "ready_to_print",
  noShipping: false, history: [],
};
const event = (substatus: string) => ({ date: "2026-10-20T13:00:00Z", status: "ready_to_ship", substatus });

describe("conferência ML só da expedição", () => {
  it.each(["embalado", "conferido"])("%s com envio shipped/delivered vira expedido", status_separacao => {
    expect(classify({ ...order, status_separacao }, { ...shipment, status: "shipped" }).target).toBe("expedido");
    expect(classify({ ...order, status_separacao }, { ...shipment, status: "delivered" }).target).toBe("expedido");
  });
  it("encontra coleta anterior a in_packing_list, que escondia o despacho", () => {
    expect(classify(order, { ...shipment, substatus: "in_packing_list", history: [
      event("printed"), event("picked_up"), event("in_hub"), event("in_packing_list"),
    ] })).toMatchObject({ target: "expedido", collected: true });
  });
  it.each(["printed", "ready_for_pickup", "in_pickup_list"])("%s não prova coleta", substatus => {
    expect(classify(order, { ...shipment, substatus, history: [event("printed")] }))
      .toMatchObject({ target: null, collected: false });
  });
  it("registra perda/devolução como enviado somente quando houve coleta", () => {
    expect(classify(order, { ...shipment, status: "not_delivered", history: [event("picked_up")] }).target).toBe("expedido");
    expect(classify(order, { ...shipment, status: "not_delivered" }).target).toBeNull();
  });
  it("não despacha cancelamentos", () => {
    expect(classify(order, { ...shipment, status: "cancelled", history: [event("picked_up")] }).target).toBeNull();
  });
  it("pedido sem envio (no_shipping) nunca muda de etapa", () => {
    const noShipping: MlReconciliationEvidence = { ...shipment, kind: "order", status: "paid", substatus: null, noShipping: true };
    expect(classify({ ...order, data: "2026-05-01" }, noShipping).target).toBeNull();
  });
  // Regressão 2026-10-21: "printed" do ML vem do download da etiqueta pelo Tiny,
  // e jogava pedidos não embalados direto pra embalado; 2h sem atividade
  // devolvia wave em andamento pra "Pra separar".
  it.each(["aguardando_nf", "validacao_oc", "aguardando_separacao", "em_separacao", "separado"])(
    "nunca mexe em %s, nem com etiqueta baixada ou coleta no ML", status_separacao => {
      const parado = { ...order, status_separacao, etiqueta_status: null, atividade_em: "2026-10-01T00:00:00Z" };
      expect(classify(parado, { ...shipment, substatus: "printed", history: [event("printed")] }).target).toBeNull();
      expect(classify(parado, { ...shipment, status: "shipped" }).target).toBeNull();
    });
  it("não mexe em expedido", () => {
    expect(classify({ ...order, status_separacao: "expedido" }, { ...shipment, status: "shipped" }).target).toBeNull();
  });
  it("exclui Bellator apesar de caixa ou espaços", () => {
    expect(isBellator("  BELLATOR ")).toBe(true);
    expect(isBellator("EasyPeasy SP")).toBe(false);
  });
});
