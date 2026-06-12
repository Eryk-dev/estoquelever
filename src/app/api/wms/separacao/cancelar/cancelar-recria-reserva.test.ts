import { describe, it, expect, vi, beforeEach } from "vitest";

// Bug (2026-06-12): cancelar separação estornava a S do pick mas NÃO recriava
// a R consumida (par L+S). O pedido voltava pra fila com 0 reservas e o
// roteamento prometia o saldo pra outro pedido (overselling no re-pick).
// Fix: espelha reset-state 3b/3c — ressuscita R de cada L de pick
// (estornarLiberacaoReserva) + estorna R cascade residual.

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

const { estornarMovSpy, estornarLiberacaoSpy } = vi.hoisted(() => ({
  estornarMovSpy: vi.fn(),
  estornarLiberacaoSpy: vi.fn(),
}));
vi.mock("@/lib/wms/ledger", () => ({ estornarMovimentacao: estornarMovSpy }));
vi.mock("@/lib/wms/reservas-picking", () => ({
  estornarLiberacaoReserva: estornarLiberacaoSpy,
}));
vi.mock("@/lib/wms/reservas", () => ({ estornarReservaIndividual: vi.fn() }));
vi.mock("@/lib/historico-service", () => ({ registrarEventos: vi.fn() }));
vi.mock("@/lib/wms/cancelamento-parcial", () => ({
  classificarItensParaCancelamento: () => ({ pegos: [], naoPegos: [] }),
}));

// supabase fake: thenable chain que resolve por (tabela, operação, nº da chamada).
// Dados settáveis por teste via `tables`.
const tables: {
  itens: unknown[];
  links: unknown[];
  realocs: unknown[];
  movsReservas: unknown[];
} = { itens: [], links: [], realocs: [], movsReservas: [] };
const selectCount: Record<string, number> = {};
const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];

function dataFor(table: string, op: string, nth: number): unknown {
  if (op !== "select") return null;
  if (table === "siso_pedido_itens") {
    // 1ª select = itens com movs; 2ª = compraRows (classificação de status)
    return nth === 1 ? tables.itens : [];
  }
  if (table === "siso_pedido_item_mov_links") return tables.links;
  if (table === "siso_pedido_item_realocacoes") return tables.realocs;
  if (table === "siso_movimentacoes") return tables.movsReservas;
  return [];
}

vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => ({
    from(table: string) {
      let op = "select";
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "in", "eq", "neq", "not", "delete", "gt", "limit"]) {
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
      chain.then = (resolve: (v: unknown) => void) => {
        const key = `${table}:${op}`;
        selectCount[key] = (selectCount[key] ?? 0) + 1;
        resolve({ data: dataFor(table, op, selectCount[key]), error: null });
      };
      return chain;
    },
  }),
}));

import { POST } from "./route";
import type { NextRequest } from "next/server";

function makeReq(body: unknown): NextRequest {
  return new Request("http://x/api/wms/separacao/cancelar", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(selectCount)) delete selectCount[k];
  updates.length = 0;
  tables.itens = [];
  tables.links = [];
  tables.realocs = [];
  tables.movsReservas = [];
});

describe("cancelar separação — recria reserva (SEP-06)", () => {
  it("estorna a S e ressuscita a R a partir da L par do pick", async () => {
    tables.itens = [
      {
        id: 1,
        pedido_id: "p1",
        mov_saida_id: "mov-s",
        mov_ajuste_loc_zerou_id: null,
        separacao_parcial: false,
      },
    ];
    tables.links = [
      { mov_id: "mov-l", tipo_link: "liberacao_reserva", qty: 4, pedido_item_id: 1 },
      { mov_id: "mov-s", tipo_link: "saida", qty: 4, pedido_item_id: 1 },
    ];

    const res = await POST(makeReq({ pedido_ids: ["p1"] }));
    expect(res.status).toBe(200);

    expect(estornarMovSpy).toHaveBeenCalledWith(
      expect.objectContaining({ mov_id: "mov-s" }),
    );
    expect(estornarLiberacaoSpy).toHaveBeenCalledTimes(1);
    expect(estornarLiberacaoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ liberacao_mov_id: "mov-l", pedido_id: "p1" }),
    );
  });

  it("estorna R cascade residual (não duplica reserva com a R ressuscitada)", async () => {
    tables.itens = [
      {
        id: 1,
        pedido_id: "p1",
        mov_saida_id: "mov-s",
        mov_ajuste_loc_zerou_id: null,
        separacao_parcial: true,
      },
    ];
    tables.links = [
      { mov_id: "mov-l", tipo_link: "liberacao_reserva", qty: 2, pedido_item_id: 1 },
      { mov_id: "mov-s", tipo_link: "saida", qty: 2, pedido_item_id: 1 },
      { mov_id: "mov-r-casc", tipo_link: "reserva_cascade", qty: 2, pedido_item_id: 1 },
    ];

    const res = await POST(makeReq({ pedido_ids: ["p1"] }));
    expect(res.status).toBe(200);

    expect(estornarLiberacaoSpy).toHaveBeenCalledTimes(1);
    expect(estornarMovSpy).toHaveBeenCalledWith(
      expect.objectContaining({ mov_id: "mov-r-casc" }),
    );
  });

  it("item sem L par (pick sem reserva / OC puro) não recria R", async () => {
    tables.itens = [
      {
        id: 1,
        pedido_id: "p1",
        mov_saida_id: "mov-s",
        mov_ajuste_loc_zerou_id: null,
        separacao_parcial: false,
      },
    ];
    tables.links = [{ mov_id: "mov-s", tipo_link: "saida", qty: 4, pedido_item_id: 1 }];

    const res = await POST(makeReq({ pedido_ids: ["p1"] }));
    expect(res.status).toBe(200);

    expect(estornarMovSpy).toHaveBeenCalledWith(
      expect.objectContaining({ mov_id: "mov-s" }),
    );
    expect(estornarLiberacaoSpy).not.toHaveBeenCalled();
  });

  // Bug (2026-06-12, pedido #51261): o reset inline dos itens não zerava
  // quantidade_bipada/bipado_completo (divergia de resetarEstadoSeparacaoItens).
  // O bip fantasma sobrevivia ao cancelamento e o pedido re-separado caía na
  // aba Separados já "Bipado" — etiqueta não disparava no bip de embalagem.
  it("reset dos itens zera o bip de embalagem (quantidade_bipada/bipado_completo)", async () => {
    tables.itens = [
      {
        id: 1,
        pedido_id: "p1",
        mov_saida_id: "mov-s",
        mov_ajuste_loc_zerou_id: null,
        separacao_parcial: false,
      },
    ];
    tables.links = [{ mov_id: "mov-s", tipo_link: "saida", qty: 4, pedido_item_id: 1 }];

    const res = await POST(makeReq({ pedido_ids: ["p1"] }));
    expect(res.status).toBe(200);

    const itemReset = updates.find(
      (u) => u.table === "siso_pedido_itens" && "separacao_marcado" in u.payload,
    );
    expect(itemReset).toBeDefined();
    expect(itemReset!.payload).toMatchObject({
      separacao_marcado: false,
      quantidade_pega: null,
      mov_saida_id: null,
      quantidade_bipada: 0,
      bipado_completo: false,
    });
  });

  it("cancelar_pedido=true (D1, pedido morre) NÃO ressuscita reservas", async () => {
    tables.itens = [
      {
        id: 1,
        pedido_id: "p1",
        mov_saida_id: "mov-s",
        mov_ajuste_loc_zerou_id: null,
        separacao_parcial: false,
      },
    ];

    const res = await POST(makeReq({ pedido_ids: ["p1"], cancelar_pedido: true }));
    expect(res.status).toBe(200);

    expect(estornarLiberacaoSpy).not.toHaveBeenCalled();
  });
});
