import { describe, it, expect, vi, beforeEach } from "vitest";

// Bug (2026-06-12, pedido #51261): "encontrei" na validação OC pré-marcava
// bipado_completo=true + quantidade_bipada=quantidade_pedida. O pedido caía
// na aba Separados já "Bipado", o bip do embalador retornava 404 "já bipado"
// e a etiqueta (disparada só dentro do bip que completa o pedido) nunca saía
// — o operador precisava reiniciar a embalagem e re-bipar tudo.
// Fix: encontrei marca só o PICK (separacao_marcado/quantidade_pega); o bip
// de embalagem fica pendente (bipado_completo=false, quantidade_bipada=0).

vi.mock("@/lib/session", () => ({
  getSessionUser: async () => ({ id: "u1", nome: "Op" }),
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logError: vi.fn(() => ({ id: "e1", timestamp: "t" })),
  },
}));
vi.mock("@/lib/sku-fornecedor", () => ({
  getFornecedorBySku: () => ({ fornecedor: "FORN" }),
}));
vi.mock("@/lib/historico-service", () => ({
  registrarEvento: vi.fn(async () => undefined),
}));
const { estornarMovSpy } = vi.hoisted(() => ({
  estornarMovSpy: vi.fn(async () => undefined),
}));
const { rpcSpy } = vi.hoisted(() => ({
  rpcSpy: vi.fn(async () => ({ data: null, error: null })),
}));
vi.mock("@/lib/wms/ledger", () => ({
  estornarMovimentacao: estornarMovSpy,
  inserirMovimentacao: vi.fn(),
}));
vi.mock("@/lib/wms/reservas-picking", () => ({
  estornarLiberacaoReserva: vi.fn(async () => undefined),
}));
vi.mock("@/lib/separacao/wms-mapping", () => ({
  resolverProdutoWms: vi.fn(async () => "prod-uuid"),
  resolverProdutoEfetivoDoItem: vi.fn(async () => "prod-uuid"),
  resolverLocalizacaoWms: vi.fn(async () => "loc-uuid"),
}));
vi.mock("@/lib/wms/contagem-inline", () => ({
  registrarContagemInline: vi.fn(),
  enfileirarLocParaContagem: vi.fn(async () => undefined),
}));
vi.mock("@/lib/wms/separacao/alocacao-contagem", () => ({
  alocarContagem: vi.fn(() => new Map()),
}));

const { pickMovSpy } = vi.hoisted(() => ({
  pickMovSpy: vi.fn(async () => ({ movSaidaId: "mov-s1" })),
}));
vi.mock("@/lib/wms/separacao/pick-mov", () => ({ pickMovPicking: pickMovSpy }));
// O ramo "encontrei" resolve o produto WMS via auto-sync (commit c7cb101) — sem
// este mock a função real bate no DB e o handler estoura 500 (test drift).
vi.mock("@/lib/wms/sync-tiny", () => ({
  resolverProdutoEfetivoComAutoSync: vi.fn(async () => "prod-wms-uuid"),
}));
vi.mock("@/lib/compras-oc", () => ({
  findOrCreateOcAberta: vi.fn(async () => "oc-uuid"),
}));

// supabase fake: thenable chain que resolve por (tabela, operação, nº da
// chamada). Updates capturados em `updates` pra asserts de payload.
const tables: { itens: unknown[]; itensFull: unknown[]; pedidosCtx: unknown[] } = {
  itens: [],
  itensFull: [],
  pedidosCtx: [],
};
const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
const selectCount: Record<string, number> = {};

function dataFor(table: string, nth: number, single: boolean): unknown {
  if (table === "siso_pedido_itens") {
    // 1ª select = items; 2ª = itensFull; 3ª = allItems (transição)
    if (nth === 1) return tables.itens;
    if (nth === 2) return tables.itensFull;
    return [{ id: 1, compra_status: null, separacao_marcado: true }];
  }
  if (table === "siso_pedidos") {
    // 1ª = pedidosCtx (array); 2ª = pedido .single()
    if (nth === 1) return tables.pedidosCtx;
    return single
      ? { id: "p1", status_separacao: "validacao_oc", decisao_final: "oc" }
      : [];
  }
  if (table === "siso_estoque") {
    // produto tem loc com saldo → caminho normal (sem "encontrei sem cadastro")
    return [{ localizacao_id: "loc1" }];
  }
  if (table === "siso_movimentacoes") {
    return single
      ? { id: "mov-s1", origem_detalhes: {} }
      : [];
  }
  if (table === "siso_pedido_item_mov_links") {
    if (nth === 1) {
      return [
        {
          id: "link-new",
          mov_id: "mov-s1",
          qty: 1,
          criado_em: "2026-07-28T20:00:00Z",
        },
        {
          id: "link-old",
          mov_id: "mov-s-parcial",
          qty: 5,
          criado_em: "2026-07-28T19:00:00Z",
        },
      ];
    }
    return [{ mov_id: "mov-s-parcial" }];
  }
  return [];
}

vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => ({
    from(table: string) {
      let op = "select";
      let single = false;
      const chain: Record<string, unknown> = {};
      for (const m of [
        "select",
        "in",
        "eq",
        "neq",
        "not",
        "delete",
        "gt",
        "limit",
        "order",
      ]) {
        chain[m] = () => {
          if (m === "delete") op = m;
          return chain;
        };
      }
      chain.update = (payload: Record<string, unknown>) => {
        op = "update";
        updates.push({ table, payload });
        return chain;
      };
      chain.single = () => {
        single = true;
        return chain;
      };
      chain.maybeSingle = chain.single;
      chain.then = (resolve: (v: unknown) => void) => {
        if (op !== "select") {
          resolve({ data: null, error: null });
          return;
        }
        const key = `${table}:select`;
        selectCount[key] = (selectCount[key] ?? 0) + 1;
        resolve({ data: dataFor(table, selectCount[key], single), error: null });
      };
      return chain;
    },
    rpc: rpcSpy,
  }),
}));

import { POST } from "./route";
import type { NextRequest } from "next/server";

function makeReq(body: unknown): NextRequest {
  return new Request("http://x/api/wms/separacao/validar-oc-item", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(selectCount)) delete selectCount[k];
  updates.length = 0;
  tables.itens = [
    {
      id: 1,
      pedido_id: "p1",
      sku: "CAR006-1",
      quantidade_pedida: 4,
      quantidade_pega: 0,
      compra_status: "oc_pendente",
      fornecedor_oc: null,
    },
  ];
  tables.itensFull = [
    {
      id: 1,
      pedido_id: "p1",
      produto_id: "915088409",
      sku: "CAR006-1",
      quantidade_pedida: 4,
      mov_saida_id: null,
    },
  ];
  tables.pedidosCtx = [
    { id: "p1", numero: "51261", empresa_origem_id: "e1", separacao_galpao_id: "g1" },
  ];
});

describe("validar-oc-item encontrei — não pré-marca bip de embalagem", () => {
  it("marca o pick mas deixa bipado_completo=false / quantidade_bipada=0", async () => {
    const res = await POST(makeReq({ item_ids: ["1"], acao: "encontrei" }));
    expect(res.status).toBe(200);

    expect(pickMovSpy).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: 1, qty: 4, contexto: "encontrei_oc" }),
    );

    const itemUpdate = updates.find(
      (u) => u.table === "siso_pedido_itens" && "separacao_marcado" in u.payload,
    );
    expect(itemUpdate).toBeDefined();
    expect(itemUpdate!.payload).toMatchObject({
      separacao_marcado: true,
      quantidade_pega: 4,
      mov_saida_id: "mov-s1",
      bipado_completo: false,
      quantidade_bipada: 0,
    });
  });

  it("baixa somente o residual quando o item já teve pick parcial", async () => {
    tables.itens = [
      {
        ...tables.itens[0] as Record<string, unknown>,
        quantidade_pedida: 6,
        quantidade_pega: 5,
        compra_status: "oc_pendente",
        mov_saida_id: "mov-s-parcial",
      },
    ];
    tables.itensFull = [
      {
        ...tables.itensFull[0] as Record<string, unknown>,
        quantidade_pedida: 6,
        mov_saida_id: "mov-s-parcial",
      },
    ];

    const res = await POST(
      makeReq({ item_ids: ["1"], acao: "encontrei" }),
    );

    expect(res.status).toBe(200);
    expect(pickMovSpy).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: 1, qty: 1 }),
    );
    expect(
      updates.some(
        (u) =>
          u.table === "siso_pedido_itens" &&
          u.payload.mov_saida_id === "mov-s1" &&
          u.payload.quantidade_pega === 6,
      ),
    ).toBe(true);
  });

  it("bloqueia Encontrei stale em item comprado parcial", async () => {
    tables.itens = [
      {
        ...tables.itens[0] as Record<string, unknown>,
        quantidade_pedida: 6,
        quantidade_pega: 5,
        compra_status: "comprado",
        mov_saida_id: "mov-s-parcial",
      },
    ];

    const res = await POST(
      makeReq({ item_ids: ["1"], acao: "encontrei" }),
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("estado_oc_invalido");
    expect(pickMovSpy).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("trata retry de Encontrei já concluído como no-op", async () => {
    tables.itens = [
      {
        ...tables.itens[0] as Record<string, unknown>,
        quantidade_pedida: 6,
        quantidade_pega: 6,
        compra_status: null,
        mov_saida_id: "mov-s1",
      },
    ];
    tables.itensFull = [
      {
        ...tables.itensFull[0] as Record<string, unknown>,
        quantidade_pedida: 6,
        mov_saida_id: "mov-s1",
      },
    ];

    const res = await POST(
      makeReq({ item_ids: ["1"], acao: "encontrei" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.itens_atualizados).toBe(0);
    expect(pickMovSpy).not.toHaveBeenCalled();
    expect(
      updates.some((u) => u.table === "siso_pedido_itens"),
    ).toBe(false);
  });

  it("bloqueia Esgotado stale em item já comprado", async () => {
    tables.itens = [
      {
        ...tables.itens[0] as Record<string, unknown>,
        quantidade_pedida: 6,
        quantidade_pega: 5,
        compra_status: "comprado",
        mov_saida_id: "mov-s-parcial",
      },
    ];

    const res = await POST(
      makeReq({ item_ids: ["1"], acao: "esgotado" }),
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("estado_oc_invalido");
    expect(updates).toHaveLength(0);
  });

  it("trata retry de Esgotado já confirmado como no-op", async () => {
    tables.itens = [
      {
        ...tables.itens[0] as Record<string, unknown>,
        quantidade_pedida: 6,
        quantidade_pega: 5,
        compra_status: "aguardando_compra",
        mov_saida_id: "mov-s-parcial",
      },
    ];

    const res = await POST(
      makeReq({ item_ids: ["1"], acao: "esgotado" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.itens_atualizados).toBe(0);
    expect(
      updates.some((u) => u.table === "siso_pedido_itens"),
    ).toBe(false);
  });

  it("não deixa desfazer enquanto o item ainda aguarda a decisão OC", async () => {
    tables.itens = [
      {
        ...tables.itens[0] as Record<string, unknown>,
        quantidade_pedida: 6,
        quantidade_pega: 5,
        compra_status: "oc_pendente",
        mov_saida_id: "mov-s-parcial",
      },
    ];

    const res = await POST(
      makeReq({ item_ids: ["1"], acao: "desfazer_encontrei" }),
    );

    expect(res.status).toBe(409);
    expect(estornarMovSpy).not.toHaveBeenCalled();
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("não deixa desfazer item que já foi enviado para compras", async () => {
    tables.itens = [
      {
        ...tables.itens[0] as Record<string, unknown>,
        quantidade_pedida: 6,
        quantidade_pega: 5,
        compra_status: "aguardando_compra",
        mov_saida_id: "mov-s-parcial",
      },
    ];

    const res = await POST(
      makeReq({ item_ids: ["1"], acao: "desfazer_encontrei" }),
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("encontrei_nao_confirmado");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("falha orientando reparo quando Encontrei não tem movimento vinculado", async () => {
    tables.itens = [
      {
        ...tables.itens[0] as Record<string, unknown>,
        quantidade_pedida: 6,
        quantidade_pega: 6,
        compra_status: null,
        mov_saida_id: null,
      },
    ];

    const res = await POST(
      makeReq({ item_ids: ["1"], acao: "desfazer_encontrei" }),
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("movimento_encontrei_ausente");
    expect(body.message).toContain("reparo");
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("ao desfazer, estorna só o residual e preserva o pick parcial anterior", async () => {
    tables.itens = [
      {
        ...tables.itens[0] as Record<string, unknown>,
        quantidade_pedida: 6,
        quantidade_pega: 6,
        compra_status: null,
        mov_saida_id: "mov-s1",
      },
    ];

    const res = await POST(
      makeReq({ item_ids: ["1"], acao: "desfazer_encontrei" }),
    );

    expect(res.status).toBe(200);
    expect(rpcSpy).toHaveBeenCalledWith(
      "wms_desmarcar_item_atomico",
      expect.objectContaining({
        p_mov_s_id: "mov-s1",
        p_qty_link: 1,
        p_pedido_item_id: 1,
      }),
    );
    expect(estornarMovSpy).not.toHaveBeenCalled();
    expect(
      updates.some(
        (u) =>
          u.table === "siso_pedido_itens" &&
          u.payload.compra_status === "oc_pendente" &&
          u.payload.compra_quantidade_solicitada === 1 &&
          u.payload.mov_saida_id === "mov-s-parcial" &&
          u.payload.quantidade_pega === 5 &&
          u.payload.separacao_parcial === true,
      ),
    ).toBe(true);
  });
});
