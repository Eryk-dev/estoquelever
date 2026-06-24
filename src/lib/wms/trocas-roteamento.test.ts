import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regressão: troca de equivalência origem `compras` (e `separacao` vinda de
 * `validacao_oc`) APROVAVA — convertia R reserva_troca → reserva_pedido e setava
 * o substituto no item — mas o PEDIDO ficava preso na OC (status_separacao
 * `aguardando_compra`), porque a rota /trocas/[id]/aprovar só liberava o pedido
 * quando `origem_solicitacao === 'roteamento'`.
 *
 * `liberarPedidoPosTrocaOC` (chamada pela rota nas demais origens) tira o item
 * de compras e transiciona o pedido OC → propria, espelhando reconciliador-oc.
 */

// ─── Estado + gravação configuráveis por teste ──────────────────────────────

const state = {
  pedido: null as Record<string, unknown> | null,
  itens: [] as Array<{ compra_status: string | null }>,
  transRows: [{ id: "P1" }] as Array<{ id: string }> | null,
  jobExistente: null as { id: string } | null,
};

const rec = {
  itemUpdates: [] as Array<Record<string, unknown>>,
  pedidoUpdates: [] as Array<Record<string, unknown>>,
  jobInserts: [] as Array<Record<string, unknown>>,
};

function makeBuilder(table: string) {
  const ops: Array<{ m: string; args: unknown[] }> = [];
  const has = (m: string) => ops.some((o) => o.m === m);
  const arg = (m: string) => ops.find((o) => o.m === m)?.args[0];

  const resolve = () => {
    if (table === "siso_pedido_itens") {
      if (has("update")) {
        rec.itemUpdates.push(arg("update") as Record<string, unknown>);
        return { data: null, error: null };
      }
      return { data: state.itens, error: null }; // select compra_status
    }
    if (table === "siso_pedidos") {
      if (has("update")) {
        rec.pedidoUpdates.push(arg("update") as Record<string, unknown>);
        return { data: state.transRows, error: null };
      }
      return { data: state.pedido, error: null }; // select + maybeSingle
    }
    if (table === "siso_fila_execucao") {
      if (has("insert")) {
        rec.jobInserts.push(arg("insert") as Record<string, unknown>);
        return { data: null, error: null };
      }
      return { data: state.jobExistente, error: null }; // select id + maybeSingle
    }
    return { data: null, error: null };
  };

  const builder: Record<string, unknown> = {};
  for (const m of ["update", "insert", "select", "eq", "in", "order", "limit"]) {
    builder[m] = (...args: unknown[]) => {
      ops.push({ m, args });
      return builder;
    };
  }
  builder.maybeSingle = () => Promise.resolve(resolve());
  builder.single = () => Promise.resolve(resolve());
  builder.then = (onF: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onF);
  return builder;
}

vi.mock("@/lib/supabase-server", () => ({
  createServiceClient: () => ({ from: (t: string) => makeBuilder(t) }),
}));

const kickWorker = vi.fn(() => Promise.resolve());
vi.mock("@/lib/execution-worker", () => ({ kickWorker: () => kickWorker() }));

const registrarEvento = vi.fn(() => Promise.resolve());
vi.mock("@/lib/historico-service", () => ({ registrarEvento: () => registrarEvento() }));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), logError: vi.fn() },
}));

import { liberarPedidoPosTrocaOC, ordenarIrmaosCascata } from "./trocas-roteamento";

const ARGS = { pedidoId: "P1", pedidoItemId: 10, usuarioId: "u1", usuarioNome: "Eryk" };

beforeEach(() => {
  state.pedido = null;
  state.itens = [];
  state.transRows = [{ id: "P1" }];
  state.jobExistente = null;
  rec.itemUpdates = [];
  rec.pedidoUpdates = [];
  rec.jobInserts = [];
  kickWorker.mockClear();
  registrarEvento.mockClear();
});

describe("liberarPedidoPosTrocaOC", () => {
  it("OC + NF já emitida → libera pra aguardando_separacao e enfileira lancar_estoque", async () => {
    state.pedido = {
      id: "P1",
      status: "executando",
      status_separacao: "aguardando_compra",
      empresa_origem_id: "e1",
      separacao_galpao_id: "g1",
      nota_fiscal_id: 999,
      chave_acesso_nf: "CHAVE",
    };
    state.itens = [{ compra_status: null }]; // único item já coberto (pós-claim)

    const r = await liberarPedidoPosTrocaOC(ARGS);

    expect(r.liberado).toBe(true);
    // item saiu de compras
    expect(rec.itemUpdates[0]).toMatchObject({ compra_status: null, ordem_compra_id: null });
    // pedido OC → propria + aguardando_separacao (NF presente)
    expect(rec.pedidoUpdates[0]).toMatchObject({
      decisao_final: "propria",
      status: "executando",
      status_separacao: "aguardando_separacao",
    });
    // enfileira lancar_estoque propria + acorda worker
    expect(rec.jobInserts[0]).toMatchObject({
      pedido_id: "P1",
      tipo: "lancar_estoque",
      decisao: "propria",
      empresa_id: "e1",
    });
    expect(kickWorker).toHaveBeenCalledTimes(1);
  });

  it("OC sem NF → vai pra aguardando_nf (worker gera a NF)", async () => {
    state.pedido = {
      id: "P1",
      status: "executando",
      status_separacao: "validacao_oc",
      empresa_origem_id: "e1",
      separacao_galpao_id: "g1",
      nota_fiscal_id: null,
      chave_acesso_nf: null,
    };
    state.itens = [{ compra_status: null }];

    const r = await liberarPedidoPosTrocaOC(ARGS);

    expect(r.liberado).toBe(true);
    expect(rec.pedidoUpdates[0]).toMatchObject({ status_separacao: "aguardando_nf" });
  });

  it("pedido já em separação (não-OC) → no-op, não transiciona nem enfileira", async () => {
    state.pedido = {
      id: "P1",
      status: "executando",
      status_separacao: "em_separacao",
      empresa_origem_id: "e1",
      separacao_galpao_id: "g1",
      nota_fiscal_id: 999,
      chave_acesso_nf: "CHAVE",
    };
    state.itens = [{ compra_status: null }];

    const r = await liberarPedidoPosTrocaOC(ARGS);

    expect(r.liberado).toBe(false);
    expect(rec.pedidoUpdates).toHaveLength(0);
    expect(rec.jobInserts).toHaveLength(0);
    expect(kickWorker).not.toHaveBeenCalled();
  });

  it("ainda há outro item em compra → espera, não transiciona o pedido", async () => {
    state.pedido = {
      id: "P1",
      status: "executando",
      status_separacao: "aguardando_compra",
      empresa_origem_id: "e1",
      separacao_galpao_id: "g1",
      nota_fiscal_id: 999,
      chave_acesso_nf: "CHAVE",
    };
    state.itens = [{ compra_status: null }, { compra_status: "aguardando_compra" }];

    const r = await liberarPedidoPosTrocaOC(ARGS);

    expect(r.liberado).toBe(false);
    expect(r.motivo).toMatch(/itens em compra/);
    expect(rec.pedidoUpdates).toHaveLength(0);
  });

  it("job lancar_estoque já existe → não duplica insert", async () => {
    state.pedido = {
      id: "P1",
      status: "executando",
      status_separacao: "aguardando_compra",
      empresa_origem_id: "e1",
      separacao_galpao_id: "g1",
      nota_fiscal_id: 999,
      chave_acesso_nf: "CHAVE",
    };
    state.itens = [{ compra_status: null }];
    state.jobExistente = { id: "job-1" };

    const r = await liberarPedidoPosTrocaOC(ARGS);

    expect(r.liberado).toBe(true);
    expect(rec.jobInserts).toHaveLength(0);
  });
});

/**
 * Cascata OC (2026-06-23): ordenação FIFO dos pedidos irmãos parados em OC que
 * recebem a mesma troca. Mais antigo primeiro (saldo escasso do substituto vai
 * pra fila mais velha), desempate estável por pedido_id. Normaliza o pedido
 * embedado que o cliente Supabase às vezes tipa como array.
 */
describe("ordenarIrmaosCascata", () => {
  it("ordena FIFO por criado_em (mais antigo primeiro)", () => {
    const out = ordenarIrmaosCascata([
      { id: 30, pedido_id: "P3", siso_pedidos: { criado_em: "2026-06-23T12:00:00Z" } },
      { id: 10, pedido_id: "P1", siso_pedidos: { criado_em: "2026-06-23T08:00:00Z" } },
      { id: 20, pedido_id: "P2", siso_pedidos: { criado_em: "2026-06-23T10:00:00Z" } },
    ]);
    expect(out.map((i) => i.pedido_id)).toEqual(["P1", "P2", "P3"]);
    expect(out[0]).toMatchObject({ item_id: 10, pedido_id: "P1" });
  });

  it("normaliza pedido embedado como array (cliente Supabase)", () => {
    const out = ordenarIrmaosCascata([
      { id: 10, pedido_id: "P1", siso_pedidos: [{ criado_em: "2026-06-23T08:00:00Z" }] },
    ]);
    expect(out[0].criado_em).toBe("2026-06-23T08:00:00Z");
    expect(out[0].item_id).toBe(10);
  });

  it("desempata por pedido_id quando criado_em empata (mesmo lote de webhook)", () => {
    const out = ordenarIrmaosCascata([
      { id: 22, pedido_id: "P9", siso_pedidos: { criado_em: "2026-06-23T08:00:00Z" } },
      { id: 21, pedido_id: "P5", siso_pedidos: { criado_em: "2026-06-23T08:00:00Z" } },
    ]);
    expect(out.map((i) => i.pedido_id)).toEqual(["P5", "P9"]);
  });
});
