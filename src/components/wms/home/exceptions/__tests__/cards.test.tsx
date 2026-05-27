import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { CardDevolucoesPendentes } from "../card-devolucoes-pendentes";
import { CardTransferenciasEmTransito } from "../card-transferencias-em-transito";
import { CardInventarioRevisao } from "../card-inventario-revisao";
import { CardReservasOrfas } from "../card-reservas-orfas";
import { CardRetroativos } from "../card-retroativos";
import { CardRecebimentoOrfao } from "../card-recebimento-orfao";

// next/link em ambiente de teste — renderiza como <a> simples.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("Cards de exceções — vazios", () => {
  it("CardDevolucoesPendentes count=0 mostra placeholder", () => {
    const { getByText } = render(
      <CardDevolucoesPendentes count={0} itens={[]} />,
    );
    expect(getByText(/Nada na fila/i)).toBeTruthy();
  });

  it("CardTransferenciasEmTransito count=0 mostra placeholder", () => {
    const { getByText } = render(
      <CardTransferenciasEmTransito count={0} itens={[]} />,
    );
    expect(getByText(/Nada em trânsito/i)).toBeTruthy();
  });

  it("CardInventarioRevisao count=0 mostra placeholder", () => {
    const { getByText } = render(
      <CardInventarioRevisao count={0} itens={[]} />,
    );
    expect(getByText(/Nenhum em revisão/i)).toBeTruthy();
  });

  it("CardReservasOrfas count=0 mostra placeholder", () => {
    const { getByText } = render(<CardReservasOrfas count={0} itens={[]} />);
    expect(getByText(/Sem Rs órfãs/i)).toBeTruthy();
  });

  it("CardRetroativos count=0 mostra placeholder", () => {
    const { getByText } = render(<CardRetroativos count={0} itens={[]} />);
    expect(getByText(/Nenhum lançamento aberto/i)).toBeTruthy();
  });

  it("CardRecebimentoOrfao count=0 mostra placeholder", () => {
    const { getByText } = render(
      <CardRecebimentoOrfao count={0} itens={[]} />,
    );
    expect(getByText(/Dock limpo/i)).toBeTruthy();
  });
});

describe("Cards de exceções — populados", () => {
  it("CardReservasOrfas count=6 mostra alerta", () => {
    const itens = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      pedido_id: `p${i}`,
      pedido_numero: `${i}`,
      produto_sku: `SKU-${i}`,
      qty: 1,
      criada_em: new Date().toISOString(),
    }));
    const { getByText } = render(
      <CardReservasOrfas count={6} itens={itens} />,
    );
    expect(getByText(/Acima de 5/i)).toBeTruthy();
  });

  it("CardTransferenciasEmTransito count=2 mostra 2 linhas + idade", () => {
    const itens = [
      {
        id: "t1",
        origem_galpao_nome: "CWB",
        destino_galpao_nome: "SP",
        criada_em: new Date(Date.now() - 5 * 3_600_000).toISOString(),
        qty_itens: 8,
      },
      {
        id: "t2",
        origem_galpao_nome: "SP",
        destino_galpao_nome: "CWB",
        criada_em: new Date(Date.now() - 25 * 3_600_000).toISOString(),
        qty_itens: 3,
      },
    ];
    const { getByText } = render(
      <CardTransferenciasEmTransito count={2} itens={itens} />,
    );
    expect(getByText(/CWB → SP/)).toBeTruthy();
    expect(getByText(/1d/)).toBeTruthy(); // 25h → 1d
  });

  it("CardDevolucoesPendentes count=4 mostra +1 pendência", () => {
    const itens = Array.from({ length: 3 }, (_, i) => ({
      id: `d${i}`,
      nota_fiscal_id: 100 + i,
      empresa_referencia_nome: "ACME",
      criada_em: new Date(Date.now() - 30 * 60_000).toISOString(),
    }));
    const { getByText } = render(
      <CardDevolucoesPendentes count={4} itens={itens} />,
    );
    expect(getByText(/\+1 pendência/i)).toBeTruthy();
  });

  it("CardInventarioRevisao count=2 mostra divergências por sessão", () => {
    const itens = [
      {
        id: "s1",
        nome: "Sessão CWB · 2026-05",
        galpao_nome: "CWB",
        total_divergencias: 4,
        criado_em: new Date().toISOString(),
      },
      {
        id: "s2",
        nome: "Sessão SP · 2026-05",
        galpao_nome: "SP",
        total_divergencias: 0,
        criado_em: new Date().toISOString(),
      },
    ];
    const { getByText } = render(
      <CardInventarioRevisao count={2} itens={itens} />,
    );
    expect(getByText(/4 div\./)).toBeTruthy();
    expect(getByText(/0 div\./)).toBeTruthy();
  });

  it("CardRecebimentoOrfao count=1 mostra produto + galpão", () => {
    const itens = [
      {
        produto_id: "p1",
        produto_sku: "GB-42",
        galpao_id: "g1",
        galpao_nome: "CWB",
        localizacao_codigo: "RECEBIMENTO",
        saldo: 5,
      },
    ];
    const { getByText } = render(
      <CardRecebimentoOrfao count={1} itens={itens} />,
    );
    expect(getByText(/GB-42/)).toBeTruthy();
    expect(getByText(/CWB · RECEBIMENTO/)).toBeTruthy();
  });
});
