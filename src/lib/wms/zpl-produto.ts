// Geração de ZPL pra etiqueta de produto (recebimento/guarda).
//
// Físico: folha 100mm × ~50mm dividida ao meio por gap → 2 colunas.
// PW=800, LL=200. Cada metade tem LABEL_WIDTH=400.
//
// Layout (igual ao n8n original):
//   ┌─────────── DESCRIÇÃO (2 linhas, centro) ───────────┐
//   │                                                     │
//   │           ▌▌▌▌▌▌▌ BARCODE CODE128 ▌▌▌▌▌▌▌           │
//   │                                                     │
//   │  SKU: 19XXXX           A-01-1                       │
//   └─────────────────────────────────────────────────────┘
//
// Pareamento 2-por-folha: itens consecutivos viram esquerda/direita da mesma
// folha. Item ímpar no fim deixa a coluna direita em branco — comportamento
// idêntico ao gerarZplPequena() de zpl-endereco.ts.
//
// Expansão por quantidade: a função `expandirPorQty` repete N vezes a mesma
// linha pra qty=N (1 etiqueta física por unidade).

export interface EtiquetaProdutoInput {
  sku: string;
  descricao: string;
  localizacao: string;
}

const PAGE_WIDTH = 800;
const LABEL_WIDTH = 400;
const PAGE_HEIGHT = 200;
const COLUNA_DIREITA_X = 400; // offset pra começar a coluna da direita
const LEFT_MARGIN = 5;

const DESC_Y = 20;
const BARCODE_Y = 80;
const FOOTER_Y = 150;

const MODULE_WIDTH = 1;
const BAR_RATIO = 2;
const BAR_HEIGHT = 50;

function clean(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[\r\n]+/g, " ").trim();
}

/**
 * Calcula a largura aproximada do code128 baseado no nº de chars do SKU,
 * pra centralizar o barcode na coluna. Mesma heurística do n8n original.
 */
function barcodeX(sku: string, offsetX: number): number {
  const estModules = sku.length * 11;
  const barcodeWidth = estModules * MODULE_WIDTH * BAR_RATIO;
  return offsetX + Math.round((LABEL_WIDTH - barcodeWidth) / 2);
}

/**
 * Gera os campos ZPL de uma única metade (esquerda OU direita) da folha.
 * Não emite ^XA/^XZ — caller compõe a folha inteira.
 */
function gerarMetade(input: EtiquetaProdutoInput, offsetX: number): string {
  const sku = clean(input.sku);
  const descricao = clean(input.descricao);
  const localizacao = clean(input.localizacao);

  const descX = offsetX + LEFT_MARGIN;
  const descBlockWidth = LABEL_WIDTH - LEFT_MARGIN * 2;
  const bcX = barcodeX(sku, offsetX);
  const footerSkuX = offsetX + LEFT_MARGIN;
  const footerLocX = offsetX + Math.round(LABEL_WIDTH / 2) + 10;

  return [
    `^CF0,25`,
    `^FO${descX},${DESC_Y}^FB${descBlockWidth},2,,C^FD${descricao}^FS`,
    `^BY${MODULE_WIDTH},${BAR_RATIO},${BAR_HEIGHT}`,
    `^FO${bcX},${BARCODE_Y}^BCN,${BAR_HEIGHT},N,N,N^FD${sku}^FS`,
    `^CF0,20`,
    `^FO${footerSkuX},${FOOTER_Y}^FDSKU: ${sku}^FS`,
    `^FO${footerLocX},${FOOTER_Y}^FD${localizacao}^FS`,
  ].join("\n");
}

/**
 * Gera o ZPL completo pra uma folha (1 ou 2 etiquetas). Inclui ^XA/^XZ.
 */
function gerarFolha(esquerda: EtiquetaProdutoInput, direita?: EtiquetaProdutoInput): string {
  const partes: string[] = [
    `^XA`,
    `^CI28`,
    `^PW${PAGE_WIDTH}`,
    `^LL${PAGE_HEIGHT}`,
    `^LH0,0`,
    gerarMetade(esquerda, 0),
  ];
  if (direita) {
    partes.push(gerarMetade(direita, COLUNA_DIREITA_X));
  }
  partes.push(`^XZ`);
  return partes.join("\n");
}

/**
 * Recebe uma lista de etiquetas (ordem importa) e retorna ZPL com
 * pareamento 2-por-folha. Lista ímpar deixa a direita em branco na última.
 *
 * Exemplo:
 *   gerarZplProduto([A,B,C,D,E]) → folha(A,B) + folha(C,D) + folha(E)
 */
export function gerarZplProduto(itens: EtiquetaProdutoInput[]): string {
  const folhas: string[] = [];
  for (let i = 0; i < itens.length; i += 2) {
    folhas.push(gerarFolha(itens[i], itens[i + 1]));
  }
  return folhas.join("\n");
}

/**
 * Expande uma lista de { etiqueta, qty } em N cópias por unidade.
 *   [{etq: A, qty: 3}, {etq: B, qty: 1}] → [A, A, A, B]
 *
 * Usado pelo recebimento: cada linha (SKU + qty=N) vira N etiquetas físicas,
 * uma por unidade.
 */
export function expandirPorQty(
  linhas: { etiqueta: EtiquetaProdutoInput; qty: number }[],
): EtiquetaProdutoInput[] {
  const out: EtiquetaProdutoInput[] = [];
  for (const linha of linhas) {
    const qty = Math.max(1, Math.floor(linha.qty));
    for (let i = 0; i < qty; i++) out.push(linha.etiqueta);
  }
  return out;
}

/**
 * Conta quantas folhas físicas vão sair pra uma lista de etiquetas
 * (depois de expandir por qty). Útil pra UI mostrar "X folhas vão imprimir".
 */
export function contarFolhas(totalEtiquetas: number): number {
  return Math.ceil(totalEtiquetas / 2);
}
