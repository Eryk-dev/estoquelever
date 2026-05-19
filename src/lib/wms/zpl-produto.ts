// Geração de ZPL pra etiqueta de produto (recebimento/guarda).
//
// Físico: folha ~105mm × ~25mm dividida ao meio por gap → 2 colunas.
// PW=840, LL=200. Cada metade tem LABEL_WIDTH=400; coluna direita começa
// em X=440 pra compensar gap físico maior (+5mm).
//
// Layout:
//   ┌─────────── DESCRIÇÃO (2 linhas, centro) ───────────┐
//   │                                                     │
//   │       [QR] ▌▌▌▌ BARCODE CODE128 ▌▌▌▌                │
//   │       (conjunto QR+barcode centralizado)            │
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

const PAGE_WIDTH = 840; // 105mm @ 8 dots/mm — acomoda shift de 5mm da coluna direita
const LABEL_WIDTH = 400;
const PAGE_HEIGHT = 200;
const COLUNA_DIREITA_X = 440; // +40 dots (5mm) vs antes pra compensar gap físico maior
const LEFT_MARGIN = 5;

const DESC_Y = 20;
const BARCODE_Y = 80;
const FOOTER_Y = 150;

const MODULE_WIDTH = 1;
const BAR_RATIO = 2;
const BAR_HEIGHT = 50;

// QR code ao lado do barcode. Model 2, magnification 3 → ~60 dots (~7.5mm)
// pra SKUs curtos. ECC M (correção média) — robusto pra thermal print.
const QR_MAGNIFICATION = 3;
const QR_SIZE = 60; // estimativa pra cálculo de centro; ZPL emite o tamanho real
const QR_BARCODE_GAP = 8; // ~1mm de gap entre QR e barcode
const QR_Y = BARCODE_Y - Math.round((QR_SIZE - BAR_HEIGHT) / 2); // alinha centro vertical

function clean(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[\r\n]+/g, " ").trim();
}

/**
 * Gera os campos ZPL de uma única metade (esquerda OU direita) da folha.
 * Não emite ^XA/^XZ — caller compõe a folha inteira.
 *
 * Layout do bloco central: [QR][gap][CODE128], centralizado horizontalmente
 * na coluna. Largura do barcode estimada pelo nº de chars do SKU (mesma
 * heurística do n8n original).
 */
function gerarMetade(input: EtiquetaProdutoInput, offsetX: number): string {
  const sku = clean(input.sku);
  const descricao = clean(input.descricao);
  const localizacao = clean(input.localizacao);

  const descX = offsetX + LEFT_MARGIN;
  const descBlockWidth = LABEL_WIDTH - LEFT_MARGIN * 2;

  const estModules = sku.length * 11;
  const barcodeWidth = estModules * MODULE_WIDTH * BAR_RATIO;
  const groupWidth = QR_SIZE + QR_BARCODE_GAP + barcodeWidth;
  const groupX = offsetX + Math.round((LABEL_WIDTH - groupWidth) / 2);
  const qrX = groupX;
  const bcX = groupX + QR_SIZE + QR_BARCODE_GAP;

  const footerSkuX = offsetX + LEFT_MARGIN;
  const footerLocX = offsetX + Math.round(LABEL_WIDTH / 2) + 10;

  return [
    `^CF0,25`,
    `^FO${descX},${DESC_Y}^FB${descBlockWidth},2,,C^FD${descricao}^FS`,
    `^FO${qrX},${QR_Y}^BQN,2,${QR_MAGNIFICATION}^FDMA,${sku}^FS`,
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
