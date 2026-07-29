export interface LinhaVendaCobertura {
  produtoId: string | null;
  quantidade: number;
}

export interface SolicitacaoProdutoAgregada {
  quantidade: number;
  linhas: number;
}

export function agregarSolicitacaoPorProduto(
  linhas: LinhaVendaCobertura[],
): Map<string, SolicitacaoProdutoAgregada> {
  const agregadas = new Map<string, SolicitacaoProdutoAgregada>();

  for (const linha of linhas) {
    if (!linha.produtoId) continue;
    const atual = agregadas.get(linha.produtoId);
    agregadas.set(linha.produtoId, {
      quantidade:
        (atual?.quantidade ?? 0) +
        Math.max(0, Number(linha.quantidade) || 0),
      linhas: (atual?.linhas ?? 0) + 1,
    });
  }

  return agregadas;
}

export function produtoTemCobertura(
  solicitacao: SolicitacaoProdutoAgregada | undefined,
  totalDisponivel: number,
): boolean {
  return (
    !!solicitacao &&
    Number(totalDisponivel) >= solicitacao.quantidade
  );
}
