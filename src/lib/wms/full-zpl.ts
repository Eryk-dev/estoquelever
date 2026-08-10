export interface FullZplItem {
  sku: string;
  quantidade: number;
  ordem: number;
  localizacao: string | null;
}

export function separarEtiquetasZpl(zpl: string): string[] {
  return zpl.match(/\^XA[\s\S]*?\^XZ/gi)?.map((label) => label.trim()) ?? [];
}

function natural(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" });
}

/**
 * A correspondência etiqueta↔item é propositalmente posicional: o operador
 * confirma que o arquivo ML e a lista Full estão na mesma ordem. Depois disso,
 * somente a sequência dos blocos ^XA…^XZ muda.
 */
export function reordenarZplFullPorLocalizacao(
  zpl: string,
  itens: FullZplItem[],
): { zpl: string; total: number } {
  const etiquetas = separarEtiquetasZpl(zpl);
  const unidades = [...itens]
    .sort((a, b) => a.ordem - b.ordem)
    .flatMap((item) =>
      Array.from({ length: Math.max(0, Math.floor(item.quantidade)) }, (_, via) => ({
        ...item,
        via,
      })),
    );
  if (etiquetas.length !== unidades.length) {
    throw new Error(
      `O ZPL contém ${etiquetas.length} etiquetas, mas o envio Full tem ${unidades.length} unidades.`,
    );
  }
  const ordenadas = unidades
    .map((item, index) => ({ item, etiqueta: etiquetas[index], index }))
    .sort((a, b) =>
      natural(a.item.localizacao, b.item.localizacao) ||
      a.item.ordem - b.item.ordem ||
      a.item.via - b.item.via ||
      a.index - b.index,
    );
  return { zpl: ordenadas.map((row) => row.etiqueta).join("\n"), total: etiquetas.length };
}
