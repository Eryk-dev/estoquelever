import { describe, it, expect } from "vitest";
import {
  ttlHorasReservaFutura,
  classificarPromocaoFutura,
} from "./separacao-futura";

describe("classificarPromocaoFutura", () => {
  it("etiqueta ainda buffered → manter na pista futura", () => {
    expect(classificarPromocaoFutura("buffered")).toBe("manter");
  });

  it("sem leitura de substatus (ML off / shipment não achado) → ignorar", () => {
    expect(classificarPromocaoFutura(null)).toBe("ignorar");
    expect(classificarPromocaoFutura(undefined)).toBe("ignorar");
  });

  it("etiqueta liberou (ready_to_print/invoice_pending/ready_to_ship) → promover", () => {
    expect(classificarPromocaoFutura("ready_to_print")).toBe("promover");
    expect(classificarPromocaoFutura("invoice_pending")).toBe("promover");
    expect(classificarPromocaoFutura("ready_to_ship")).toBe("promover");
  });

  it("OC sem estoque também PROMOVE quando libera (gera NF+agrupamento igual normal)", () => {
    // caso dos 8 OC de 25/06: invoice_pending no ML. Promove → worker emite NF +
    // agrupamento e segue a compra (estoque é fulfillment, não trava a promoção).
    expect(classificarPromocaoFutura("invoice_pending")).toBe("promover");
  });

  it("shipment CANCELADO no ML → manter (não gera NF de venda cancelada)", () => {
    // substatus não-nulo + status cancelled: NÃO promove (oversold fiscal).
    expect(classificarPromocaoFutura("ready_to_ship", "cancelled")).toBe("manter");
    expect(classificarPromocaoFutura("invoice_pending", "not_delivered")).toBe("manter");
  });

  it("shipment ativo (status ready_to_ship) liberado → promove", () => {
    expect(classificarPromocaoFutura("ready_to_print", "ready_to_ship")).toBe("promover");
  });
});

describe("ttlHorasReservaFutura", () => {
  const now = new Date("2026-06-24T12:00:00-03:00");

  it("prazo 2026-07-14 → ~34d (prazo + 14d buffer) a partir de 2026-06-24", () => {
    // botão 2000017087998330: dataPrevista 2026-07-14. 20d até o prazo + 14d = 34d.
    const ttl = ttlHorasReservaFutura("2026-07-14T23:59:59-03:00", now);
    const dias = ttl / 24;
    expect(dias).toBeGreaterThan(33);
    expect(dias).toBeLessThan(35);
  });

  it("cobre além dos 30d fixos do fluxo normal (não expiraria antes da etiqueta)", () => {
    const ttl = ttlHorasReservaFutura("2026-07-14T23:59:59-03:00", now);
    expect(ttl).toBeGreaterThan(30 * 24);
  });

  it("sem prazo → fallback 90d", () => {
    expect(ttlHorasReservaFutura(null, now)).toBe(90 * 24);
    expect(ttlHorasReservaFutura(undefined, now)).toBe(90 * 24);
  });

  it("prazo inválido → fallback 90d", () => {
    expect(ttlHorasReservaFutura("não-é-data", now)).toBe(90 * 24);
  });

  it("prazo já passou → fallback 90d (nunca TTL <= 0)", () => {
    expect(ttlHorasReservaFutura("2026-06-01T00:00:00-03:00", now)).toBe(90 * 24);
  });
});
