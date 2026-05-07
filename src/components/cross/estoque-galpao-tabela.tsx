import type { EstoqueGalpao } from "@/lib/cross/types";

interface EstoqueGalpaoTabelaProps {
  estoques: Record<string, EstoqueGalpao>;
}

export function EstoqueGalpaoTabela({ estoques }: EstoqueGalpaoTabelaProps) {
  const linhas = Object.entries(estoques);

  if (linhas.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <h3 className="text-sm font-semibold mb-2">Estoque por galpão</h3>
        <p className="text-sm text-zinc-500">
          Sem informação de estoque (produto pode não estar cadastrado nas empresas do grupo).
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <h3 className="text-sm font-semibold mb-3">Estoque por galpão</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-zinc-500 uppercase border-b border-zinc-100 dark:border-zinc-800">
            <th className="text-left py-1.5 font-medium">Galpão</th>
            <th className="text-right py-1.5 font-medium">Saldo</th>
            <th className="text-right py-1.5 font-medium">Reserv.</th>
            <th className="text-right py-1.5 font-medium">Disp.</th>
          </tr>
        </thead>
        <tbody>
          {linhas.map(([nome, e]) => (
            <tr key={nome} className="border-b border-zinc-50 dark:border-zinc-900 last:border-0">
              <td className="py-2 font-medium">{nome}</td>
              <td className="py-2 text-right font-mono">{e.saldo}</td>
              <td className="py-2 text-right font-mono text-zinc-500">{e.reservado}</td>
              <td className="py-2 text-right font-mono font-semibold">{e.disponivel}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
