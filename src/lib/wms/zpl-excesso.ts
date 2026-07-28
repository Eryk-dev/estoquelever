// Geração de ZPL pra etiqueta de EXCESSO (overstock) — 10×15 cm em paisagem.
//
// Físico: mesma mídia da etiqueta de envio (10cm × 15cm @ 203dpi → PW=800,
// LL=1200). Todo o conteúdo é rotacionado 90° (campos R) pra leitura em
// paisagem — o operador cola na lateral da caixa e lê com os 15cm na
// horizontal. A quantidade escolhida pelo operador sai ESTAMPADA nela
// (diferente da etiqueta de produto pequena, que imprime N vias de 1
// unidade). Este módulo gera SEMPRE 1 etiqueta; o nº de vias é do caller
// (`imprimirEtiquetaExcesso`), que repete o ZPL.
//
// Layout (visão paisagem 1200×800):
//   ┌──────────┬─────────────────────────────────────────────┐
//   │ EXCESSO  │ DESCRIÇÃO (até 4 linhas)                    │
//   │          ├─────────────────────────────────────────────┤
//   │    24    │              SKU 192847 (grande)            │
//   │          │  ▄▄QR▄▄      ▌▌▌▌ CODE128 ▌▌▌▌              │
//   │ UNIDADES ├─────────────────────────────────────────────┤
//   │          │ A-03-2 · CWB                    06/07/2026  │
//   └──────────┴─────────────────────────────────────────────┘
//
// Sistema de coordenadas: os helpers convertem coordenadas de PAISAGEM
// (lx 0..1200 esq→dir, ly 0..800 topo→base) pro ^FO de retrato. Um campo
// rotacionado R em ^FO(px,py) ocupa px..px+altura × py..py+comprimento, com
// o topo visual (paisagem) em px+altura → px = 800 − ly − altura.
//
// QR e CODE128 carregam o MESMO dado (o SKU) — redundância de leitura:
// coletor 2D/celular lê o QR, leitor 1D legado lê o barcode. O lado do QR
// depende do tamanho do dado (versão) — por isso ele é DIMENSIONADO antes
// (`dimensionarQr`) e o CODE128 começa depois da borda real do QR + folga.
// Posição fixa embolava os dois quando o SKU crescia a versão do QR.

export interface EtiquetaExcessoInput {
  sku: string;
  descricao: string;
  /** Quantidade estampada na etiqueta (clampada pra >= 1). */
  qty: number;
  localizacao: string;
  /** Nome do galpão — impresso junto da loc no rodapé quando presente. */
  galpao?: string;
  /** Data de impressão já formatada (dd/mm/aaaa) — caller formata. */
  data: string;
}

const PW = 800;
const LL = 1200;
/** Altura da etiqueta em paisagem (= largura física da mídia). */
const L_H = 800;

const COL_QTD_W = 440;
const RULE_X = 460;
const COL_INFO_X = 500;
const COL_INFO_W = 660;

/** Borda direita útil da coluna de info. */
const COL_INFO_RIGHT = COL_INFO_X + COL_INFO_W;

/** Orçamento horizontal do QR — a magnificação encolhe pra caber nele. */
const QR_MAX_W = 200;
const QR_MAG_MAX = 8;
/** Piso de magnificação: abaixo disso o QR fica ilegível no coletor. */
const QR_MAG_MIN = 4;
/** Folga entre QR e CODE128 (cobre a quiet zone dos dois). */
const GAP_QR_BAR = 50;
const BAR_HEIGHT = 160;
/** Centro vertical (paisagem) da faixa QR + CODE128. */
const BAND_CY = 500;

function clean(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[\r\n]+/g, " ").trim();
}

/** ^FO de um campo rotacionado R posicionado em paisagem (lx, ly). */
function foR(lx: number, ly: number, altura: number): string {
  return `^FO${L_H - ly - altura},${lx}`;
}

/**
 * ^FO de um ^FB rotacionado multi-linha. O ZPL ancora o bloco no ^FO e
 * cresce (maxLinhas × font) em +x — o topo visual fica em FO + max×font
 * (verificado empiricamente no Labelary). Compensa pra 1ª linha cair em ly.
 */
function foRBloco(lx: number, ly: number, font: number, maxLinhas: number): string {
  return `^FO${L_H - ly - font * maxLinhas},${lx}`;
}

/** Linha horizontal em paisagem (na vertical do retrato). */
function hLine(lx: number, ly: number, len: number): string {
  return `^FO${L_H - ly - 3},${lx}^GB3,${len},3^FS`;
}

/**
 * Fonte + nº de linhas pra descrição caber na coluna de 660 dots.
 * Mesma heurística empírica do zpl-produto: char width ≈ font × 0.55.
 * chars/linha ≈ 660 / (font × 0.55):
 *   font 56 → ~21/linha × 3 = 64
 *   font 48 → ~25/linha × 4 = 100
 *   font 40 → ~30/linha × 4 = 120
 *   font 36 → ~33/linha × 4 = 133
 */
function escolherFonteDescricao(desc: string): {
  texto: string;
  font: number;
  lines: number;
} {
  const len = desc.length;
  if (len <= 64) return { texto: desc, font: 56, lines: 3 };
  if (len <= 100) return { texto: desc, font: 48, lines: 4 };
  if (len <= 120) return { texto: desc, font: 40, lines: 4 };
  if (len <= 133) return { texto: desc, font: 36, lines: 4 };
  return { texto: desc.slice(0, 132) + "…", font: 36, lines: 4 };
}

/** SKU em destaque — encolhe conforme o comprimento pra caber em 660 dots. */
function escolherFonteSku(sku: string): number {
  const len = sku.length;
  if (len <= 10) return 110;
  if (len <= 13) return 90;
  if (len <= 16) return 72;
  if (len <= 21) return 56;
  return 40;
}

/** Quantidade gigante — encolhe conforme o nº de dígitos (coluna de 440). */
function escolherFonteQty(qtyStr: string): number {
  const len = qtyStr.length;
  if (len <= 2) return 330;
  if (len === 3) return 250;
  if (len === 4) return 190;
  return 150;
}

/** Módulos por lado do QR model 2, versões 1..10. */
const QR_MODULOS = [21, 25, 29, 33, 37, 41, 45, 49, 53, 57];
/**
 * Capacidade em BYTES por versão no modo binário com correção Q (o que o
 * `^FDQA,` escolhe no pior caso). Usar o pior caso garante que a versão
 * estimada nunca fique MENOR que a que a impressora vai gerar — se errar,
 * erra sobrando espaço, não embolando com o barcode.
 */
const QR_CAP_BYTES = [11, 20, 32, 46, 60, 74, 86, 108, 130, 151];

/**
 * Magnificação + lado real (dots) do QR pro dado informado. Encolhe a
 * magnificação conforme a versão cresce pra manter o símbolo dentro de
 * `QR_MAX_W`; nunca abaixo de `QR_MAG_MIN` (legibilidade > orçamento —
 * o barcode é reposicionado a partir do lado REAL, então não embola).
 */
function dimensionarQr(dados: string): { mag: number; size: number } {
  const bytes = new TextEncoder().encode(dados).length;
  const idx = QR_CAP_BYTES.findIndex((cap) => bytes <= cap);
  const modulos = QR_MODULOS[idx === -1 ? QR_MODULOS.length - 1 : idx];
  const mag = Math.max(
    QR_MAG_MIN,
    Math.min(QR_MAG_MAX, Math.floor(QR_MAX_W / modulos)),
  );
  return { mag, size: modulos * mag };
}

/**
 * Module width do CODE128 pro espaço que sobra à direita do QR.
 * Largura em módulos ≈ 11×chars + 35 (start + check + stop, Code B).
 */
function moduleWidthBarcode(sku: string, budget: number): number {
  const modulos = 11 * sku.length + 35;
  return Math.max(1, Math.min(3, Math.floor(budget / modulos)));
}

/**
 * Gera o ZPL completo de UMA etiqueta de excesso (inclui ^XA/^XZ).
 */
export function gerarZplExcesso(input: EtiquetaExcessoInput): string {
  const sku = clean(input.sku);
  const descricao = clean(input.descricao);
  const localizacao = clean(input.localizacao) || "—";
  const galpao = clean(input.galpao);
  const data = clean(input.data);
  const qty = String(Math.max(1, Math.floor(input.qty)));

  const desc = escolherFonteDescricao(descricao);
  const skuFont = escolherFonteSku(sku);
  const qtyFont = escolherFonteQty(qty);
  const qr = dimensionarQr(sku);
  const qrY = Math.round(BAND_CY - qr.size / 2);
  // barcode começa depois da borda REAL do QR — nunca embola.
  const barX = COL_INFO_X + qr.size + GAP_QR_BAR;
  const mod = moduleWidthBarcode(sku, COL_INFO_RIGHT - barX);
  const qtyY = Math.round(400 - qtyFont / 2);
  const locLinha = galpao ? `${localizacao} · ${galpao}` : localizacao;

  return [
    `^XA`,
    `^CI28`,
    `^PW${PW}`,
    `^LL${LL}`,
    `^LH0,0`,
    // ── coluna esquerda: marcador + quantidade gigante
    `${foR(10, 36, 44)}^A0R,44,44^FB${COL_QTD_W},1,0,C^FDEXCESSO^FS`,
    `${foR(10, qtyY, qtyFont)}^A0R,${qtyFont},${qtyFont}^FB${COL_QTD_W},1,0,C^FD${qty}^FS`,
    `${foR(10, 680, 36)}^A0R,36,36^FB${COL_QTD_W},1,0,C^FDUNIDADES^FS`,
    // ── régua vertical entre as colunas
    `^FO30,${RULE_X}^GB740,3,3^FS`,
    // ── coluna direita: descrição
    `${foRBloco(COL_INFO_X, 30, desc.font, desc.lines)}^A0R,${desc.font},${desc.font}^FB${COL_INFO_W},${desc.lines},0,L^FD${desc.texto}^FS`,
    hLine(COL_INFO_X, 240, COL_INFO_W),
    // ── SKU em destaque
    `${foR(COL_INFO_X, 270, skuFont)}^A0R,${skuFont},${skuFont}^FB${COL_INFO_W},1,0,C^FD${sku}^FS`,
    // ── QR (2D) + CODE128 (1D), ambos com o SKU
    `${foR(COL_INFO_X, qrY, qr.size)}^BQN,2,${qr.mag}^FDQA,${sku}^FS`,
    `^BY${mod},2,${BAR_HEIGHT}`,
    `${foR(barX, BAND_CY - BAR_HEIGHT / 2, BAR_HEIGHT)}^BCR,${BAR_HEIGHT},N,N,N^FD${sku}^FS`,
    hLine(COL_INFO_X, 650, COL_INFO_W),
    // ── rodapé: loc/galpão + data
    `${foR(COL_INFO_X, 690, 40)}^A0R,40,40^FD${locLinha}^FS`,
    `${foR(COL_INFO_X, 690, 40)}^A0R,40,40^FB${COL_INFO_W},1,0,R^FD${data}^FS`,
    `^XZ`,
  ].join("\n");
}
