import { describe, it, expect } from "vitest";
import { distribuirQtyPega } from "./distribuir-qty-pega";

describe("distribuirQtyPega — desconta quantidade_pega já existente", () => {
  it("item virgem: distribui a nova qty e calcula residual sobre o pedido", () => {
    const r = distribuirQtyPega(
      [{ id: 1, quantidade_pedida: 10, quantidade_pega: 0 }],
      6,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ qty_para_este: 6, qty_residual: 4 });
  });

  it("item já parcial (6/10) + pega os 4 restantes → residual 0 (completo)", () => {
    // Bug #3: a lógica antiga calculava residual = pedida - qty_para_este = 10 - 4 = 6,
    // nunca fechando o item. O correto desconta o que já foi pego.
    const r = distribuirQtyPega(
      [{ id: 1, quantidade_pedida: 10, quantidade_pega: 6 }],
      4,
    );
    expect(r[0]).toMatchObject({ qty_para_este: 4, qty_residual: 0 });
  });

  it("over-pick é limitado ao que falta (não acumula além do pedido)", () => {
    const r = distribuirQtyPega(
      [{ id: 1, quantidade_pedida: 10, quantidade_pega: 6 }],
      10,
    );
    // só faltavam 4 → só 4 são alocados; o excesso fica de fora
    expect(r[0]).toMatchObject({ qty_para_este: 4, qty_residual: 0 });
    const totalAlocado = r.reduce((s, d) => s + d.qty_para_este, 0);
    expect(totalAlocado).toBe(4); // < 10 sinaliza over-pick pro caller
  });

  it("multi-item FCFS: distribui em ordem até esgotar a nova qty", () => {
    const r = distribuirQtyPega(
      [
        { id: 1, quantidade_pedida: 5, quantidade_pega: 0 },
        { id: 2, quantidade_pedida: 5, quantidade_pega: 0 },
      ],
      7,
    );
    expect(r[0]).toMatchObject({ qty_para_este: 5, qty_residual: 0 });
    expect(r[1]).toMatchObject({ qty_para_este: 2, qty_residual: 3 });
  });

  it("multi-item com um já completo: pula o cheio e abastece o que falta", () => {
    const r = distribuirQtyPega(
      [
        { id: 1, quantidade_pedida: 5, quantidade_pega: 5 },
        { id: 2, quantidade_pedida: 5, quantidade_pega: 0 },
      ],
      3,
    );
    expect(r[0]).toMatchObject({ qty_para_este: 0, qty_residual: 0 });
    expect(r[1]).toMatchObject({ qty_para_este: 3, qty_residual: 2 });
  });

  it("quantidade_pega null é tratado como 0", () => {
    const r = distribuirQtyPega(
      [{ id: 1, quantidade_pedida: 4, quantidade_pega: null }],
      4,
    );
    expect(r[0]).toMatchObject({ qty_para_este: 4, qty_residual: 0 });
  });
});
