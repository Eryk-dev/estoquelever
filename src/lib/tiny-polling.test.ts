import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Estado configurável por teste ──────────────────────────────────────────

interface LogAprovado {
  tiny_pedido_id: string;
  tipo: string;
  status: string;
  criado_em: string;
}

const state = {
  connections: [] as Array<{ cnpj: string; empresa_id: string }>,
  pedidosExistentes: [] as Array<{ id: string; status: string }>,
  logsAprovados: [] as LogAprovado[],
  logsNf: [] as string[],
  insertError: null as { code: string; message: string } | null,
  inserts: [] as Array<Record<string, unknown>>,
  // log retornado no lookup pós-23505 (retry de aprovado/cancelado)
  logExistente: { id: "log-existente" } as Record<string, unknown> | null,
};

let insertSeq = 0;

function makeBuilder(table: string) {
  const ops: Array<{ m: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};

  const resolve = (shape: "list" | "single") => {
    const pick = <T,>(rows: T[]) =>
      shape === "single" ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };

    if (table === "siso_tiny_connections") {
      return { data: state.connections, error: null };
    }
    if (table === "siso_pedidos") {
      const inOp = ops.find((o) => o.m === "in");
      const eqId = ops.find((o) => o.m === "eq" && o.args[0] === "id");
      let rows = state.pedidosExistentes;
      if (inOp) rows = rows.filter((p) => (inOp.args[1] as string[]).includes(p.id));
      if (eqId) rows = rows.filter((p) => p.id === eqId.args[1]);
      if (ops.some((o) => o.m === "neq")) rows = rows.filter((p) => p.status !== "cancelado");
      return pick(rows);
    }
    if (table === "siso_webhook_logs") {
      const isInsert = ops.some((o) => o.m === "insert");
      if (isInsert) {
        const row = ops.find((o) => o.m === "insert")!.args[0] as Record<string, unknown>;
        if (state.insertError) return { data: null, error: state.insertError };
        state.inserts.push(row);
        insertSeq++;
        return { data: { id: `log-${insertSeq}` }, error: null };
      }
      const eqs = ops.filter((o) => o.m === "eq");
      const isNf = eqs.some((o) => o.args[0] === "tipo" && o.args[1] === "nota_fiscal");
      const isOwnLogLookup = eqs.some(
        (o) => o.args[0] === "tipo" && o.args[1] === "polling_pedido",
      );
      const isAprovado = eqs.some(
        (o) => o.args[0] === "codigo_situacao" && o.args[1] === "aprovado",
      );
      const inOp = ops.find((o) => o.m === "in");
      const ids = (inOp?.args[1] as string[]) ?? [];
      if (isNf) {
        return pick(
          state.logsNf.filter((id) => ids.includes(id)).map((id) => ({ tiny_pedido_id: id })),
        );
      }
      if (isOwnLogLookup) {
        // lookup do log existente no retry pós-23505
        return { data: state.logExistente, error: null };
      }
      if (isAprovado) {
        const eqPedido = eqs.find((o) => o.args[0] === "tiny_pedido_id");
        let rows = state.logsAprovados;
        if (inOp) rows = rows.filter((l) => ids.includes(l.tiny_pedido_id));
        if (eqPedido) rows = rows.filter((l) => l.tiny_pedido_id === eqPedido.args[1]);
        return pick(rows);
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };

  for (const m of ["select", "insert", "eq", "neq", "in", "not", "update"]) {
    builder[m] = (...args: unknown[]) => {
      ops.push({ m, args });
      return builder;
    };
  }
  builder.single = async () => resolve("single");
  builder.maybeSingle = async () => resolve("single");
  builder.then = (onResolve: (v: unknown) => unknown) => onResolve(resolve("list"));
  return builder;
}

vi.mock("./supabase-server", () => ({
  createServiceClient: () => ({ from: (t: string) => makeBuilder(t) }),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), logError: vi.fn() },
}));

vi.mock("./tiny-oauth", () => ({
  getValidTokenByEmpresa: vi.fn(async () => ({ token: "tok-1" })),
}));

vi.mock("./tiny-queue", () => ({
  runWithEmpresa: (_id: string, fn: () => Promise<unknown>) => fn(),
}));

const EMPRESA = {
  empresaId: "emp-1",
  empresaNome: "NetAir",
  galpaoId: "galpao-1",
  galpaoNome: "CWB",
  grupoId: "grupo-1",
  grupoNome: "Autopecas",
};

vi.mock("./empresa-lookup", () => ({
  getEmpresaByCnpj: vi.fn(async () => EMPRESA),
}));

const listarPedidosMock = vi.fn();
const listarNotasMock = vi.fn();
vi.mock("./tiny-api", () => ({
  listarPedidos: (...args: unknown[]) => listarPedidosMock(...args),
  listarNotas: (...args: unknown[]) => listarNotasMock(...args),
}));

const processWebhookMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("./webhook-processor", () => ({
  processWebhook: (...args: unknown[]) => processWebhookMock(...args),
}));

const handleNfWebhookMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("./nf-webhook-handler", () => ({
  handleNfWebhook: (...args: unknown[]) => handleNfWebhookMock(...args),
}));

const cancelMock = vi.fn(async (..._args: unknown[]) => ({ status: "cancelled" }));
vi.mock("./pedido-cancel-handler", () => ({
  handlePedidoCancelamento: (...args: unknown[]) => cancelMock(...args),
}));

import { pollTiny } from "./tiny-polling";
import { getEmpresaByCnpj } from "./empresa-lookup";

function setTinyVazio() {
  listarPedidosMock.mockResolvedValue({ itens: [] });
  listarNotasMock.mockResolvedValue({ itens: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  insertSeq = 0;
  state.connections = [{ cnpj: "34857388000163", empresa_id: "emp-1" }];
  state.pedidosExistentes = [];
  state.logsAprovados = [];
  state.logsNf = [];
  state.insertError = null;
  state.inserts = [];
  state.logExistente = { id: "log-existente" };
  vi.mocked(getEmpresaByCnpj).mockResolvedValue(EMPRESA);
  setTinyVazio();
});

describe("pollTiny — pedidos aprovados", () => {
  it("processa pedido aprovado sem webhook (insere log + processWebhook)", async () => {
    listarPedidosMock.mockImplementation(async (_t: unknown, params: { situacao: number }) =>
      params.situacao === 3 ? { itens: [{ id: 111, numeroPedido: 9 }] } : { itens: [] },
    );

    const result = await pollTiny();

    expect(processWebhookMock).toHaveBeenCalledTimes(1);
    expect(processWebhookMock).toHaveBeenCalledWith(
      "log-1",
      "111",
      "emp-1",
      "galpao-1",
      "grupo-1",
    );
    expect(state.inserts[0]).toMatchObject({
      tiny_pedido_id: "111",
      tipo: "polling_pedido",
      codigo_situacao: "aprovado",
      empresa_id: "emp-1",
    });
    expect(result.empresas[0].pedidos_processados).toBe(1);
  });

  it("passa janela de 7 dias como dataInicial", async () => {
    await pollTiny();

    const esperado = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    expect(listarPedidosMock).toHaveBeenCalledWith(
      "tok-1",
      expect.objectContaining({ situacao: 3, dataInicial: esperado }),
    );
  });

  it("pula pedido que já existe em siso_pedidos", async () => {
    state.pedidosExistentes = [{ id: "111", status: "executando" }];
    listarPedidosMock.mockImplementation(async (_t: unknown, params: { situacao: number }) =>
      params.situacao === 3 ? { itens: [{ id: 111 }] } : { itens: [] },
    );

    await pollTiny();

    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("pula pedido que já tem webhook log de aprovação", async () => {
    state.logsAprovados = [
      {
        tiny_pedido_id: "111",
        tipo: "inclusao_pedido",
        status: "concluido",
        criado_em: new Date().toISOString(),
      },
    ];
    listarPedidosMock.mockImplementation(async (_t: unknown, params: { situacao: number }) =>
      params.situacao === 3 ? { itens: [{ id: 111 }] } : { itens: [] },
    );

    await pollTiny();

    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("re-tenta pedido cujo poll anterior falhou (log polling_pedido status=erro)", async () => {
    state.logsAprovados = [
      {
        tiny_pedido_id: "111",
        tipo: "polling_pedido",
        status: "erro",
        criado_em: new Date().toISOString(),
      },
    ];
    state.insertError = { code: "23505", message: "duplicate" };
    state.logExistente = {
      id: "log-existente",
      tiny_pedido_id: "111",
      tipo: "polling_pedido",
      status: "erro",
      criado_em: new Date().toISOString(),
    };
    listarPedidosMock.mockImplementation(async (_t: unknown, params: { situacao: number }) =>
      params.situacao === 3 ? { itens: [{ id: 111 }] } : { itens: [] },
    );

    const result = await pollTiny();

    expect(processWebhookMock).toHaveBeenCalledWith(
      "log-existente",
      "111",
      "emp-1",
      "galpao-1",
      "grupo-1",
    );
    expect(result.empresas[0].pedidos_processados).toBe(1);
  });

  it("NÃO re-tenta log de webhook real com status=erro (recovery é manual)", async () => {
    state.logsAprovados = [
      {
        tiny_pedido_id: "111",
        tipo: "inclusao_pedido",
        status: "erro",
        criado_em: new Date().toISOString(),
      },
    ];
    listarPedidosMock.mockImplementation(async (_t: unknown, params: { situacao: number }) =>
      params.situacao === 3 ? { itens: [{ id: 111 }] } : { itens: [] },
    );

    await pollTiny();

    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("conflito 23505 com log fresco de outro poll → não processa", async () => {
    state.insertError = { code: "23505", message: "duplicate" };
    // log existente fresco em 'processando' (outro poll acabou de criar) — bloqueia
    state.logExistente = {
      id: "log-existente",
      tiny_pedido_id: "111",
      tipo: "polling_pedido",
      status: "processando",
      criado_em: new Date().toISOString(),
    };
    listarPedidosMock.mockImplementation(async (_t: unknown, params: { situacao: number }) =>
      params.situacao === 3 ? { itens: [{ id: 111 }] } : { itens: [] },
    );

    const result = await pollTiny();

    expect(processWebhookMock).not.toHaveBeenCalled();
    expect(result.empresas[0].erros).toHaveLength(0);
  });

  it("pagina até esgotar (lote cheio → busca próxima página)", async () => {
    const pagina1 = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i }));
    listarPedidosMock.mockImplementation(
      async (_t: unknown, params: { situacao: number; offset?: number }) => {
        if (params.situacao !== 3) return { itens: [] };
        return params.offset ? { itens: [{ id: 2000 }] } : { itens: pagina1 };
      },
    );

    const result = await pollTiny();

    expect(result.empresas[0].pedidos_aprovados_vistos).toBe(101);
  });
});

describe("pollTiny — pedidos cancelados", () => {
  it("varre cancelados por dataAtualizacao (não data de criação)", async () => {
    await pollTiny();

    const esperado = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    expect(listarPedidosMock).toHaveBeenCalledWith(
      "tok-1",
      expect.objectContaining({ situacao: 2, dataAtualizacao: esperado }),
    );
    const chamadaCancelados = listarPedidosMock.mock.calls.find(
      (c) => (c[1] as { situacao: number }).situacao === 2,
    );
    expect(chamadaCancelados![1]).not.toHaveProperty("dataInicial");
  });

  it("aplica cancelamento de pedido ativo no SISO e cancelado no Tiny", async () => {
    state.pedidosExistentes = [{ id: "222", status: "executando" }];
    listarPedidosMock.mockImplementation(async (_t: unknown, params: { situacao: number }) =>
      params.situacao === 2 ? { itens: [{ id: 222 }] } : { itens: [] },
    );

    const result = await pollTiny();

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).toHaveBeenCalledWith({
      pedidoId: "222",
      webhookLogId: "log-1",
      empresaId: "emp-1",
    });
    expect(result.empresas[0].cancelamentos_aplicados).toBe(1);
  });

  it("ignora cancelado no Tiny que já está cancelado no SISO", async () => {
    state.pedidosExistentes = [{ id: "222", status: "cancelado" }];
    listarPedidosMock.mockImplementation(async (_t: unknown, params: { situacao: number }) =>
      params.situacao === 2 ? { itens: [{ id: 222 }] } : { itens: [] },
    );

    await pollTiny();

    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("ignora cancelado no Tiny desconhecido do SISO", async () => {
    listarPedidosMock.mockImplementation(async (_t: unknown, params: { situacao: number }) =>
      params.situacao === 2 ? { itens: [{ id: 999 }] } : { itens: [] },
    );

    await pollTiny();

    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("retry: 23505 no insert reusa log existente e re-tenta cancelamento", async () => {
    state.pedidosExistentes = [{ id: "222", status: "executando" }];
    state.insertError = { code: "23505", message: "duplicate" };
    listarPedidosMock.mockImplementation(async (_t: unknown, params: { situacao: number }) =>
      params.situacao === 2 ? { itens: [{ id: 222 }] } : { itens: [] },
    );

    await pollTiny();

    expect(cancelMock).toHaveBeenCalledWith({
      pedidoId: "222",
      webhookLogId: "log-existente",
      empresaId: "emp-1",
    });
  });
});

describe("pollTiny — notas fiscais", () => {
  it("processa NF autorizada sem webhook via handleNfWebhook", async () => {
    listarNotasMock.mockImplementation(async (_t: unknown, params: { situacao: number }) =>
      params.situacao === 6
        ? {
            itens: [
              {
                id: 333,
                numero: "55",
                serie: "1",
                chaveAcesso: "CHAVE-333",
                dataEmissao: "2026-06-09",
                valor: 99.9,
              },
            ],
          }
        : { itens: [] },
    );

    const result = await pollTiny();

    expect(handleNfWebhookMock).toHaveBeenCalledTimes(1);
    expect(handleNfWebhookMock).toHaveBeenCalledWith(
      {
        cnpj: "34857388000163",
        tipo: "nota_fiscal",
        dados: {
          idNotaFiscalTiny: 333,
          numero: "55",
          serie: "1",
          chaveAcesso: "CHAVE-333",
          dataEmissao: "2026-06-09",
          valorNota: 99.9,
        },
      },
      "emp-1",
    );
    expect(result.empresas[0].notas_processadas).toBe(1);
  });

  it("consulta situações 6 e 7 (autorizada + emitida danfe) e dedup por id", async () => {
    listarNotasMock.mockResolvedValue({ itens: [{ id: 333 }] });

    const result = await pollTiny();

    const situacoes = listarNotasMock.mock.calls.map(
      (c) => (c[1] as { situacao: number }).situacao,
    );
    expect(situacoes).toEqual([6, 7]);
    // mesma NF nas duas listas → processa uma vez só
    expect(handleNfWebhookMock).toHaveBeenCalledTimes(1);
    expect(result.empresas[0].notas_vistas).toBe(1);
  });

  it("pula NF que já tem webhook log", async () => {
    state.logsNf = ["333"];
    listarNotasMock.mockImplementation(async (_t: unknown, params: { situacao: number }) =>
      params.situacao === 6 ? { itens: [{ id: 333 }] } : { itens: [] },
    );

    await pollTiny();

    expect(handleNfWebhookMock).not.toHaveBeenCalled();
  });
});

describe("pollTiny — isolamento de erros", () => {
  it("empresa sem cadastro não derruba as demais", async () => {
    state.connections = [
      { cnpj: "00000000000000", empresa_id: "emp-x" },
      { cnpj: "34857388000163", empresa_id: "emp-1" },
    ];
    vi.mocked(getEmpresaByCnpj).mockImplementation(async (cnpj: string) =>
      cnpj === "34857388000163" ? EMPRESA : null,
    );
    listarPedidosMock.mockImplementation(async (_t: unknown, params: { situacao: number }) =>
      params.situacao === 3 ? { itens: [{ id: 111 }] } : { itens: [] },
    );

    const result = await pollTiny();

    expect(result.empresas).toHaveLength(2);
    expect(result.empresas[0].erros).toHaveLength(1);
    expect(result.empresas[1].pedidos_processados).toBe(1);
  });

  it("falha num pedido não bloqueia os seguintes", async () => {
    listarPedidosMock.mockImplementation(async (_t: unknown, params: { situacao: number }) =>
      params.situacao === 3 ? { itens: [{ id: 111 }, { id: 112 }] } : { itens: [] },
    );
    processWebhookMock.mockRejectedValueOnce(new Error("boom"));

    const result = await pollTiny();

    expect(processWebhookMock).toHaveBeenCalledTimes(2);
    expect(result.empresas[0].pedidos_processados).toBe(1);
    expect(result.empresas[0].erros).toHaveLength(1);
  });
});
