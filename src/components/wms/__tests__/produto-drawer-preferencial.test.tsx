import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FornecedorEditCard } from "../produto-drawer";

vi.mock("../ui/wms-ui", async (orig) => {
  const real = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...real, Icon: () => <span /> };
});

const row = {
  id: "f1",
  fornecedor: { nome: "Forn A", prefixo_sku: "AA" },
  preferencial: false,
  codigo_fornecedor: null,
  custo_unitario: null,
  qty_minima_pedido: 1,
  multiplo_compra: 1,
  lead_time_dias_medio: 14,
} as never;

describe("FornecedorEditCard — botão preferencial", () => {
  it("não dispara onPatch num 2º clique quando mutationPending=true", () => {
    const onPatch = vi.fn();
    render(<FornecedorEditCard row={row} onPatch={onPatch} onRemove={() => {}} mutationPending />);
    const btn = screen.getByTitle("Marcar como preferencial");
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("dispara onPatch quando mutationPending=false", () => {
    const onPatch = vi.fn();
    render(<FornecedorEditCard row={row} onPatch={onPatch} onRemove={() => {}} mutationPending={false} />);
    fireEvent.click(screen.getByTitle("Marcar como preferencial"));
    expect(onPatch).toHaveBeenCalledWith({ preferencial: true });
  });
});
