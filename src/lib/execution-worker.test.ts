import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Gate de SEPARAÇÃO FUTURA no lançamento de estoque (propria + transferência).
 *
 * Regra dura do domínio: NÃO gerar NF enquanto a etiqueta do ML está `buffered`
 * (venda futura cancela muito; NF emitida que cancela = imposto sobre dinheiro
 * que não entrou, irreversível). A NF só nasce na PROMOÇÃO (etiqueta liberou).
 *
 * O bug: `executarMarcadoresOnly` (decisao=oc) já tinha o gate, mas
 * `executarSaidaPropria` e `executarSaidaTransferencia` geravam NF incondicional.
 * Uma futura com troca equivalente pendente, ao ser aprovada, enfileira
 * `lancar_estoque` (decisao=propria/transferencia) com `separacao_futura` ainda
 * true → o worker emitia NF cedo. Fix: gate no worker (choke point único de
 * `lancar_estoque`), espelhando o que o OC já faz.
 */

const state = {
  pedido: null as Record<string, unknown> | null,
  pedidoCheck: null as Record<string, unknown> | null, // transferência: 2º select
  empresa: { id: "emp-1" } as { id: string } | null,
};

const rec = {
  pedidoUpdates: [] as Array<Record<string, unknown>>,
};

function makeBuilder(table: string) {
  const ops: Array<{ m: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};

  const has = (m: string) => ops.some((o) => o.m === m);
  const opArg = (m: string) => ops.find((o) => o.m === m)?.args[0];

  const resolve = () => {
    if (table === "siso_pedidos") {
      if (has("update")) {
        rec.pedidoUpdates.push(opArg("update") as Record<string, unknown>);
        return { data: null, error: null };
      }
      const selArg = opArg("select");
      const selStr = typeof selArg === "string" ? selArg : "";
      // executarSaidaTransferencia faz um 2º select depois da NF
      if (selStr.includes("chave_acesso_nf")) return { data: state.pedidoCheck, error: null };
      return { data: state.pedido, error: null };
    }
    return { data: null, error: null };
  };

  for (const m of ["select", "insert", "upsert", "update", "delete", "eq", "in", "maybeSingle"]) {
    builder[m] = (...args: unknown[]) => {
      ops.push({ m, args });
      return builder;
    };
  }
  builder.single = async () => resolve();
  builder.maybeSingle = async () => resolve();
  builder.then = (onResolve: (v: unknown) => unknown) => onResolve(resolve());
  return builder;
}

vi.mock("./supabase-server", () => ({
  createServiceClient: () => ({ from: (t: string) => makeBuilder(t) }),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), logError: vi.fn() },
}));

const criarMarcadoresMock = vi.fn(async () => undefined);
const gerarNotaFiscalMock = vi.fn(async () => ({ id: 999, numero: "1" }));
const obterNotaFiscalMock = vi.fn(async () => ({ situacao: 6, chaveAcesso: "CHAVE" }));
vi.mock("./tiny-api", () => ({
  criarMarcadoresPedido: (...a: unknown[]) => criarMarcadoresMock(...(a as [])),
  gerarNotaFiscal: (...a: unknown[]) => gerarNotaFiscalMock(...(a as [])),
  obterNotaFiscal: (...a: unknown[]) => obterNotaFiscalMock(...(a as [])),
}));

vi.mock("./tiny-oauth", () => ({
  getValidTokenByEmpresa: vi.fn(async () => ({ token: "tok-1" })),
}));
vi.mock("./tiny-queue", () => ({
  runWithEmpresa: (_id: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("./empresa-lookup", () => ({
  getEmpresaById: vi.fn(async () => state.empresa),
}));
vi.mock("./agrupamento-service", () => ({
  criarAgrupamentoFase1: vi.fn(async () => undefined),
}));
vi.mock("./sku-fornecedor", () => ({
  getFornecedorBySku: vi.fn(() => ({ fornecedor: "F" })),
}));
vi.mock("./execution-worker-wms", () => ({
  executarEstoquePosNfWms: vi.fn(async () => undefined),
}));
const dispararCutoverMock = vi.fn(async () => ({ enqueued: false, motivo: "ok" }));
vi.mock("./wms/cutover", () => ({
  dispararCutoverSePronto: (...a: unknown[]) => dispararCutoverMock(...(a as [])),
}));
vi.mock("./separacao/wms-mapping", () => ({
  resolverProdutoEfetivoDoItem: vi.fn(async () => "uuid-1"),
}));
vi.mock("./wms/jobs-manutencao", () => ({
  backoffManutencao: vi.fn(() => 1000),
}));

import { executarSaidaPropria, executarSaidaTransferencia } from "./execution-worker";

const jobPropria = {
  id: "job-1",
  pedido_id: "938000001",
  tipo: "lancar_estoque",
  empresa_id: "emp-1",
  decisao: "propria",
  tentativas: 0,
  max_tentativas: 5,
};

const jobTransf = { ...jobPropria, decisao: "transferencia" };

beforeEach(() => {
  vi.clearAllMocks();
  rec.pedidoUpdates = [];
  state.empresa = { id: "emp-1" };
  // re-arma defaults (clearAllMocks zera implementações mockResolvedValue)
  gerarNotaFiscalMock.mockResolvedValue({ id: 999, numero: "1" });
  obterNotaFiscalMock.mockResolvedValue({ situacao: 6, chaveAcesso: "CHAVE" });
  dispararCutoverMock.mockResolvedValue({ enqueued: false, motivo: "ok" });
});

describe("executarSaidaPropria — gate separação futura", () => {
  it("futura=true → NÃO gera NF, NÃO dispara cutover, fica em aguardando_separacao", async () => {
    state.pedido = {
      estoque_lancado: false,
      marcadores: ["CWB", "LVR"],
      nota_fiscal_id: null,
      separacao_futura: true,
    };

    await executarSaidaPropria(jobPropria);

    expect(gerarNotaFiscalMock).not.toHaveBeenCalled();
    expect(dispararCutoverMock).not.toHaveBeenCalled();
    // marcadores SÃO inseridos (igual ao OC); status entra na pista futura.
    expect(criarMarcadoresMock).toHaveBeenCalled();
    expect(rec.pedidoUpdates).toContainEqual(
      expect.objectContaining({ status_separacao: "aguardando_separacao" }),
    );
    // NÃO grava nota_fiscal_id (NF não nasceu)
    expect(rec.pedidoUpdates).not.toContainEqual(
      expect.objectContaining({ nota_fiscal_id: expect.anything() }),
    );
  });

  it("regressão: futura=false (normal) → gera NF e dispara cutover", async () => {
    state.pedido = {
      estoque_lancado: false,
      marcadores: ["CWB", "LVR"],
      nota_fiscal_id: null,
      separacao_futura: false,
    };

    await executarSaidaPropria(jobPropria);

    expect(gerarNotaFiscalMock).toHaveBeenCalledTimes(1);
    expect(dispararCutoverMock).toHaveBeenCalledTimes(1);
  });

  it("idempotente: estoque já lançado → early-return (não gera NF nem mexe na futura)", async () => {
    state.pedido = { estoque_lancado: true, marcadores: [], nota_fiscal_id: null, separacao_futura: true };

    await executarSaidaPropria(jobPropria);

    expect(gerarNotaFiscalMock).not.toHaveBeenCalled();
    expect(criarMarcadoresMock).not.toHaveBeenCalled();
    expect(rec.pedidoUpdates).toHaveLength(0);
  });
});

describe("executarSaidaTransferencia — gate separação futura", () => {
  it("futura=true → NÃO gera NF, fica em aguardando_separacao", async () => {
    state.pedido = {
      numero: "51500",
      empresa_origem_id: "emp-1",
      marcadores: ["SP", "LVR"],
      nota_fiscal_id: null,
      separacao_futura: true,
    };

    await executarSaidaTransferencia(jobTransf);

    expect(gerarNotaFiscalMock).not.toHaveBeenCalled();
    expect(criarMarcadoresMock).toHaveBeenCalled();
    expect(rec.pedidoUpdates).toContainEqual(
      expect.objectContaining({ status_separacao: "aguardando_separacao" }),
    );
    expect(rec.pedidoUpdates).not.toContainEqual(
      expect.objectContaining({ nota_fiscal_id: expect.anything() }),
    );
  });

  it("regressão: futura=false (normal) → gera NF", async () => {
    state.pedido = {
      numero: "51500",
      empresa_origem_id: "emp-1",
      marcadores: ["SP", "LVR"],
      nota_fiscal_id: null,
      separacao_futura: false,
    };
    state.pedidoCheck = { chave_acesso_nf: null, status_separacao: "aguardando_nf" };

    await executarSaidaTransferencia(jobTransf);

    expect(gerarNotaFiscalMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Encadeamento fim-a-fim (documentado; as metades testadas acima + nos testes de
 * webhook-processor-wms/separacao-futura):
 *
 *  1. Troca futura aprovada → aprovarPedidoPosTroca enfileira lancar_estoque
 *     (propria) com separacao_futura ainda true → executarSaidaPropria: gate →
 *     SEM NF, aguardando_separacao, separacao_futura permanece true.
 *  2. Etiqueta liberou → promoverPedidoFutura flipa separacao_futura=false +
 *     re-enfileira lancar_estoque → executarSaidaPropria: futura=false → gera NF
 *     (coberto pelo teste de regressão acima).
 */
