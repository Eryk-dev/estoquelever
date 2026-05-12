/**
 * Cenários sintéticos pro Plano 2 — definições compartilhadas entre
 * seed-staging.ts, fake-webhook.ts, seed-cenarios.ts e verificar-saldos.ts.
 *
 * IDs Tiny sintéticos seguem range 90000000-99999999 (10 dígitos, alto o
 * suficiente pra não colidir com Tiny real). Determinístico — re-rodar o
 * seed sempre regenera os mesmos IDs.
 */

// ─── Empresas reais cadastradas em staging ─────────────────────────────────
export const STAGING_EMPRESAS = {
  netair: {
    id: "4473ca97-67e7-44e5-a192-ec756146b691",
    nome: "NetAir",
    cnpj: "34857388000163",
    galpao_nome: "CWB",
    galpao_id: "14e22fe9-8dae-4950-b1e8-f38cffa60646",
    default_picking_id: "5b2e833f-34e0-448c-9905-7af3bcc7480a",
  },
  netparts: {
    id: "c27d85ce-e469-42dc-ae0f-10b722fa5b37",
    nome: "NetParts",
    cnpj: "34857388000244",
    galpao_nome: "SP",
    galpao_id: "afd7097a-cd33-4137-94a7-44b355ab1819",
    default_picking_id: "726e9457-f3f5-4137-b441-16ec48007acb",
  },
} as const;

export type EmpresaKey = keyof typeof STAGING_EMPRESAS;

// ─── Catálogo sintético ────────────────────────────────────────────────────
/**
 * 30 SKUs cobrindo 3 perfis de saldo:
 *   - FARTO   (1-10): saldo alto em CWB+SP — exercita propria auto
 *   - SOSP    (11-20): saldo só em SP — exercita transferencia
 *   - SEM     (21-30): saldo zero em ambos — exercita oc
 *
 * Prefixos exercitam sku-fornecedor.ts:
 *   FARTO → 19FARTO + GBFARTO (Diversos/GAUSS, ambos CWB)
 *   SOSP  → EWSP    + KTSP    (Tiger/Kintop, ambos SP)
 *   SEM   → 19OC    + EWOC    (mix p/ testar fornecedor_oc misto)
 */
export interface ProdutoSintetico {
  index: number;
  sku: string;
  descricao: string;
  perfil: "FARTO" | "SOSP" | "SEM";
  /** Tiny IDs por empresa (sintéticos, range 9XXXXXXXX) */
  tinyIdNetair: number;
  tinyIdNetparts: number;
  saldoCwb: number; // saldo em NetAir/CWB
  saldoSp: number; // saldo em NetParts/SP
}

function produto(
  index: number,
  prefix: string,
  perfil: "FARTO" | "SOSP" | "SEM",
  saldoCwb: number,
  saldoSp: number,
): ProdutoSintetico {
  const sku = `${prefix}-${String(index).padStart(2, "0")}`;
  return {
    index,
    sku,
    descricao: `Produto sintético ${sku} [${perfil}]`,
    perfil,
    tinyIdNetair: 90_000_000 + index * 10 + 0,
    tinyIdNetparts: 90_000_000 + index * 10 + 1,
    saldoCwb,
    saldoSp,
  };
}

export const PRODUTOS: ProdutoSintetico[] = [
  // FARTO 1-10 — saldo alto em ambos galpões
  produto(1, "19FARTO", "FARTO", 150, 120),
  produto(2, "19FARTO", "FARTO", 200, 180),
  produto(3, "19FARTO", "FARTO", 100, 110),
  produto(4, "19FARTO", "FARTO", 180, 150),
  produto(5, "19FARTO", "FARTO", 120, 130),
  produto(6, "GBFARTO", "FARTO", 90, 100),
  produto(7, "GBFARTO", "FARTO", 75, 80),
  produto(8, "GBFARTO", "FARTO", 200, 200),
  produto(9, "GBFARTO", "FARTO", 60, 65),
  produto(10, "GBFARTO", "FARTO", 110, 95),
  // SOSP 11-20 — saldo só em SP (NetAir pedindo deve dar transferencia)
  produto(11, "EWSP", "SOSP", 0, 80),
  produto(12, "EWSP", "SOSP", 0, 120),
  produto(13, "EWSP", "SOSP", 0, 100),
  produto(14, "EWSP", "SOSP", 0, 90),
  produto(15, "EWSP", "SOSP", 0, 70),
  produto(16, "KTSP", "SOSP", 0, 60),
  produto(17, "KTSP", "SOSP", 0, 110),
  produto(18, "KTSP", "SOSP", 0, 85),
  produto(19, "KTSP", "SOSP", 0, 95),
  produto(20, "KTSP", "SOSP", 0, 75),
  // SEM 21-30 — sem estoque, vai pra OC
  produto(21, "19OC", "SEM", 0, 0),
  produto(22, "19OC", "SEM", 0, 0),
  produto(23, "19OC", "SEM", 0, 0),
  produto(24, "19OC", "SEM", 0, 0),
  produto(25, "19OC", "SEM", 0, 0),
  produto(26, "EWOC", "SEM", 0, 0),
  produto(27, "EWOC", "SEM", 0, 0),
  produto(28, "EWOC", "SEM", 0, 0),
  produto(29, "EWOC", "SEM", 0, 0),
  produto(30, "EWOC", "SEM", 0, 0),
];

export function findProduto(sku: string): ProdutoSintetico {
  const p = PRODUTOS.find((p) => p.sku === sku);
  if (!p) throw new Error(`SKU sintético desconhecido: ${sku}`);
  return p;
}

// ─── Cenários de webhook ───────────────────────────────────────────────────
export interface CenarioPedido {
  /** Identificador estável do cenário (também serve de chave em siso_stub_pedidos.cenario) */
  id: string;
  /** ID Tiny sintético do pedido — usado como id no payload e em siso_pedidos.id */
  pedidoTinyId: string;
  /** Empresa que recebeu o pedido (origem) */
  empresa: EmpresaKey;
  /** Itens do pedido — SKUs do catálogo sintético */
  itens: Array<{ sku: string; quantidade: number }>;
  /** Decisão esperada após processamento */
  decisaoEsperada: "propria" | "transferencia" | "oc";
  /** Se true, dispara webhook de cancelamento após processar */
  cancelarApos?: "pre-separado" | "pos-separado";
  /** Descrição livre */
  descricao: string;
}

function pedidoId(index: number): string {
  return String(91_000_000 + index);
}

export const CENARIOS: CenarioPedido[] = [
  // ─── Propria auto-aprovado ───────────────────────────────────────────────
  {
    id: "propria-auto-1",
    pedidoTinyId: pedidoId(1),
    empresa: "netair",
    itens: [{ sku: "19FARTO-01", quantidade: 2 }],
    decisaoEsperada: "propria",
    descricao: "NetAir vende SKU farto — auto-aprovado",
  },
  {
    id: "propria-auto-2",
    pedidoTinyId: pedidoId(2),
    empresa: "netair",
    itens: [
      { sku: "GBFARTO-06", quantidade: 1 },
      { sku: "GBFARTO-07", quantidade: 3 },
    ],
    decisaoEsperada: "propria",
    descricao: "NetAir multi-item farto — auto",
  },
  {
    id: "propria-auto-3",
    pedidoTinyId: pedidoId(3),
    empresa: "netparts",
    itens: [{ sku: "EWSP-12", quantidade: 5 }],
    decisaoEsperada: "propria",
    descricao: "NetParts vende SKU SOSP (próprio do galpão dela)",
  },
  // ─── Transferencia ───────────────────────────────────────────────────────
  {
    id: "transferencia-1",
    pedidoTinyId: pedidoId(4),
    empresa: "netair",
    itens: [{ sku: "EWSP-11", quantidade: 4 }],
    decisaoEsperada: "transferencia",
    descricao: "NetAir vende SKU SOSP — vai de SP",
  },
  {
    id: "transferencia-2",
    pedidoTinyId: pedidoId(5),
    empresa: "netair",
    itens: [
      { sku: "KTSP-16", quantidade: 2 },
      { sku: "KTSP-17", quantidade: 1 },
    ],
    decisaoEsperada: "transferencia",
    descricao: "NetAir multi-item SOSP — transferência integral",
  },
  // ─── OC ──────────────────────────────────────────────────────────────────
  {
    id: "oc-1",
    pedidoTinyId: pedidoId(6),
    empresa: "netair",
    itens: [{ sku: "19OC-21", quantidade: 3 }],
    decisaoEsperada: "oc",
    descricao: "NetAir vende SKU SEM — vai pra OC Diversos",
  },
  {
    id: "oc-2",
    pedidoTinyId: pedidoId(7),
    empresa: "netparts",
    itens: [
      { sku: "EWOC-26", quantidade: 2 },
      { sku: "EWOC-27", quantidade: 1 },
    ],
    decisaoEsperada: "oc",
    descricao: "NetParts multi-item SEM — OC Tiger",
  },
  // ─── Parcial (alguns têm estoque, outros não) ────────────────────────────
  {
    id: "parcial-1",
    pedidoTinyId: pedidoId(8),
    empresa: "netair",
    itens: [
      { sku: "19FARTO-02", quantidade: 1 }, // tem em CWB
      { sku: "19OC-22", quantidade: 1 }, // não tem em lugar nenhum
    ],
    decisaoEsperada: "oc",
    descricao: "NetAir parcial: 1 item farto + 1 SEM — vai pra OC",
  },
  // ─── Cancelamento pré-separado ───────────────────────────────────────────
  {
    id: "cancel-pre-1",
    pedidoTinyId: pedidoId(9),
    empresa: "netair",
    itens: [{ sku: "19FARTO-03", quantidade: 2 }],
    decisaoEsperada: "propria",
    cancelarApos: "pre-separado",
    descricao: "NetAir vende farto — cancelado antes da separação",
  },
  // ─── Cancelamento pós-separado (precisa ser processado primeiro) ────────
  {
    id: "cancel-pos-1",
    pedidoTinyId: pedidoId(10),
    empresa: "netair",
    itens: [{ sku: "19FARTO-04", quantidade: 1 }],
    decisaoEsperada: "propria",
    cancelarApos: "pos-separado",
    descricao: "NetAir vende farto — cancelado após NF",
  },
  // ─── Volume extra pra cobertura ──────────────────────────────────────────
  {
    id: "propria-auto-4",
    pedidoTinyId: pedidoId(11),
    empresa: "netparts",
    itens: [{ sku: "GBFARTO-08", quantidade: 10 }],
    decisaoEsperada: "propria",
    descricao: "NetParts vende GBFARTO grande qty",
  },
  {
    id: "propria-auto-5",
    pedidoTinyId: pedidoId(12),
    empresa: "netair",
    itens: [{ sku: "19FARTO-05", quantidade: 4 }],
    decisaoEsperada: "propria",
    descricao: "NetAir vende 19FARTO",
  },
  {
    id: "transferencia-3",
    pedidoTinyId: pedidoId(13),
    empresa: "netair",
    itens: [{ sku: "KTSP-18", quantidade: 3 }],
    decisaoEsperada: "transferencia",
    descricao: "NetAir vende KTSP — transfer de NetParts",
  },
  {
    id: "oc-3",
    pedidoTinyId: pedidoId(14),
    empresa: "netair",
    itens: [{ sku: "EWOC-28", quantidade: 5 }],
    decisaoEsperada: "oc",
    descricao: "NetAir vende EWOC — OC Tiger",
  },
  {
    id: "propria-auto-6",
    pedidoTinyId: pedidoId(15),
    empresa: "netair",
    itens: [
      { sku: "19FARTO-01", quantidade: 1 },
      { sku: "GBFARTO-09", quantidade: 2 },
    ],
    decisaoEsperada: "propria",
    descricao: "NetAir 2 items farto",
  },
];

// ─── Tiny webhook payload builder ──────────────────────────────────────────
/**
 * Monta payload no formato exato que o Tiny mandaria pra /api/webhook/tiny
 * — campos checados pelo webhook handler em src/app/api/webhook/tiny/route.ts.
 */
export function buildWebhookPayload(
  cenario: CenarioPedido,
  situacao: "aprovado" | "cancelado" = "aprovado",
): {
  tipo: string;
  cnpj: string;
  dados: { id: string; codigoSituacao: string };
} {
  const emp = STAGING_EMPRESAS[cenario.empresa];
  return {
    tipo: "atualizacao_pedido",
    cnpj: emp.cnpj,
    dados: {
      id: cenario.pedidoTinyId,
      codigoSituacao: situacao,
    },
  };
}

// ─── Tiny pedido full payload (siso_stub_pedidos) ──────────────────────────
/**
 * TinyPedidoRaw shape — corresponde ao que getPedido stub vai retornar.
 * Veja TinyPedidoRaw em src/lib/tiny-api.ts.
 */
export function buildPedidoFullPayload(cenario: CenarioPedido) {
  const emp = STAGING_EMPRESAS[cenario.empresa];
  const empresaIsNetair = cenario.empresa === "netair";
  const itens = cenario.itens.map(({ sku, quantidade }) => {
    const p = findProduto(sku);
    return {
      produto: {
        id: empresaIsNetair ? p.tinyIdNetair : p.tinyIdNetparts,
        sku: p.sku,
        descricao: p.descricao,
      },
      quantidade,
      valorUnitario: 100,
    };
  });

  const pedidoNum = parseInt(cenario.pedidoTinyId, 10) % 1_000_000;
  return {
    id: parseInt(cenario.pedidoTinyId, 10),
    numeroPedido: pedidoNum,
    data: new Date().toISOString().slice(0, 10),
    dataEnvio: null,
    dataPrevista: null,
    cliente: {
      id: 999_001,
      nome: `Cliente Sintético ${cenario.id}`,
      cpfCnpj: "00000000000",
    },
    ecommerce: {
      id: 1,
      nome: "MERCADO_LIVRE",
      numeroPedidoEcommerce: `ML-STAGING-${cenario.id}`,
    },
    transportador: {
      id: 1,
      formaEnvio: { id: 1, nome: "Correios SEDEX" },
      formaFrete: { id: 1, nome: "CIF" },
    },
    itens,
    _empresa_origem_id: emp.id, // metadata p/ scripts; ignored by webhook
  };
}
