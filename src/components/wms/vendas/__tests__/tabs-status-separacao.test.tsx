import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TabsStatusSeparacao } from "../tabs-status-separacao";

const COUNTS = {
  aguardando_compra: 0,
  aguardando_nf: 0,
  aguardando_separacao: 1,
  em_separacao: 2,
  separado: 3,
  encaixotado: 0,
  fechado: 4,
  embalado: 0,
  conferido: 0,
  pendente_realocacao: 0,
  cancelado: 0,
};

const FULL_TABS = ["aguardando_separacao", "em_separacao", "separado", "fechado"] as const;

describe("TabsStatusSeparacao — aba Fechados (lane Full)", () => {
  it("lane normal (sem visibleTabs) não mostra Fechados nem Encaixotados", () => {
    render(
      <TabsStatusSeparacao active="separado" onChange={() => {}} counts={COUNTS} />,
    );
    expect(screen.queryByText("Fechados")).toBeNull();
    expect(screen.queryByText("Encaixotados")).toBeNull();
  });

  it("lane Full (visibleTabs=FULL_TABS) mostra exatamente as 4 abas, incluindo Fechados com seu count", () => {
    render(
      <TabsStatusSeparacao
        active="fechado"
        onChange={() => {}}
        counts={COUNTS}
        visibleTabs={[...FULL_TABS]}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, "").trim())).toEqual([
      "Pra separar",
      "Em separação",
      "Separados",
      "Fechados",
    ]);
    expect(screen.getByText("Fechados").closest('[role="tab"]')?.textContent).toContain("4");
  });
});
