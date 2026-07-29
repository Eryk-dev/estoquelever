import { describe, expect, it } from "vitest";
import { itemVisivelNoChecklistPorCompra } from "./visibility";

describe("visibilidade de item por estado de compra no checklist", () => {
  it("oculta decisão OC já resolvida no modo normal, inclusive em pedido misto", () => {
    expect(itemVisivelNoChecklistPorCompra(null, false)).toBe(true);
    expect(itemVisivelNoChecklistPorCompra("oc_pendente", false)).toBe(true);
    expect(itemVisivelNoChecklistPorCompra("aguardando_compra", false)).toBe(false);
    expect(itemVisivelNoChecklistPorCompra("comprado", false)).toBe(false);
    expect(itemVisivelNoChecklistPorCompra("recebido", false)).toBe(false);
  });

  it("preserva itens comprados no pick-OC, mas mantém estados terminais ocultos", () => {
    expect(itemVisivelNoChecklistPorCompra("oc_pendente", true)).toBe(true);
    expect(itemVisivelNoChecklistPorCompra("aguardando_compra", true)).toBe(true);
    expect(itemVisivelNoChecklistPorCompra("comprado", true)).toBe(true);
    expect(itemVisivelNoChecklistPorCompra("recebido", true)).toBe(true);
    expect(itemVisivelNoChecklistPorCompra("indisponivel", true)).toBe(false);
    expect(itemVisivelNoChecklistPorCompra("cancelado", true)).toBe(false);
  });
});
