import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regressão #51426 (2026-06-14): um webhook `atualizacao_pedido` (que o Tiny
 * dispara após emitir a NF / concluir a expedição) reprocessava um pedido
 * `propria` JÁ comprometido, regredindo status_separacao de
 * aguardando_separacao → aguardando_nf (desfazendo a transição da NF) e
 * enfileirando um lancar_estoque duplicado.
 *
 * O fix amplia a guarda de idempotência de `processWebhookWms`: pula o
 * reprocesso quando já existe job `lancar_estoque` pro pedido (sinal de pedido
 * comprometido). Pedidos pendentes / que erraram antes do enqueue não têm job
 * → seguem reprocessando.
 */

// ─── Estado + gravação configuráveis por teste ──────────────────────────────

const state = {
  mappings: [] as Array<{ produto_id: string; tiny_produto_id: number }>,
  produtos: [] as Array<Record<string, unknown>>,
  existente: null as { estoque_lancado: boolean } | null,
  vendedorPrev: null as { vendedor_id: string | null; vendedor_nome: string | null } | null,
  sysUser: null as { id: string } | null,
  // guarda 4b: job lancar_estoque do pedido (qualquer status)
  job: null as { id: string } | null,
  // checagem pré-insert (status pendente/executando)
  jobExistentePendente: null as { id: string } | null,
};

const rec = {
  pedidoUpserts: [] as Array<Record<string, unknown>>,
  jobInserts: [] as Array<Record<string, unknown>>,
  webhookUpdates: [] as Array<Record<string, unknown>>,
};

function makeBuilder(table: string) {
  const ops: Array<{ m: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};

  const has = (m: string) => ops.some((o) => o.m === m);
  const opArg = (m: string) => ops.find((o) => o.m === m)?.args[0];

  const resolve = () => {
    const selArg = opArg("select");
    const selStr = typeof selArg === "string" ? selArg : "";

    if (table === "siso_produto_empresas") return { data: state.mappings, error: null };
    if (table === "siso_produtos") return { data: state.produtos, error: null };

    if (table === "siso_pedidos") {
      if (has("upsert")) {
        rec.pedidoUpserts.push(opArg("upsert") as Record<string, unknown>);
        return { data: null, error: null };
      }
      if (selStr.includes("estoque_lancado")) return { data: state.existente, error: null };
      if (selStr.includes("vendedor_id")) return { data: state.vendedorPrev, error: null };
      return { data: null, error: null };
    }

    if (table === "siso_fila_execucao") {
      if (has("insert")) {
        rec.jobInserts.push(opArg("insert") as Record<string, unknown>);
        return { data: null, error: null };
      }
      // checagem pré-insert tem filtro .in("status", [...]); a guarda 4b não.
      if (has("in")) return { data: state.jobExistentePendente, error: null };
      return { data: state.job, error: null };
    }

    if (table === "siso_pedido_itens") return { data: null, error: null }; // upsert + delete órfãos
    if (table === "siso_empresas") return { data: { nome: "EasyPeasy" }, error: null };
    if (table === "siso_usuarios") return { data: state.sysUser, error: null };
    if (table === "siso_webhook_logs") {
      if (has("update")) rec.webhookUpdates.push(opArg("update") as Record<string, unknown>);
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };

  for (const m of [
    "select", "insert", "upsert", "update", "delete",
    "eq", "neq", "in", "not", "or", "gte", "lt", "order", "limit",
  ]) {
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

const rotearMock = vi.fn(async (..._args: unknown[]) => ({
  decisao: "propria",
  galpao_id: "galpao-1",
  motivo: "estoque_proprio",
  rotas: [{ produto_id: "uuid-1", galpao_id: "galpao-1", localizacao_id: "loc-1", qty: 1 }],
}));
vi.mock("./wms/roteamento", () => ({
  rotearPedidoDoBanco: (...args: unknown[]) => rotearMock(...args),
}));

vi.mock("./wms/trocas-roteamento", () => ({
  planejarTrocaRoteamento: vi.fn(async () => null),
  planejarTrocaRemota: vi.fn(async () => null),
  aplicarTrocasRoteamento: vi.fn(async () => undefined),
}));

vi.mock("./wms/reservas", () => ({
  reservarAtomico: vi.fn(async () => "R-1"),
  estornarReservaIndividual: vi.fn(async () => undefined),
}));

vi.mock("./tiny-api", () => ({
  criarMarcadoresPedido: vi.fn(async () => undefined),
}));
vi.mock("./tiny-oauth", () => ({
  getValidTokenByEmpresa: vi.fn(async () => ({ token: "tok-1" })),
}));
vi.mock("./tiny-queue", () => ({
  runWithEmpresa: (_id: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("./historico-service", () => ({
  registrarEvento: vi.fn(async () => undefined),
}));
vi.mock("./execution-worker", () => ({
  kickWorker: vi.fn(async () => undefined),
}));
vi.mock("./sku-fornecedor", () => ({
  getFornecedorBySku: vi.fn(() => null),
}));

import { processWebhookWms } from "./webhook-processor-wms";
import type { TinyPedidoDetalhe } from "./tiny-api";

const PEDIDO = {
  id: "938268400",
  numero: "51426",
  data: "2026-06-14",
  cliente: { nome: "Sandra Das Dores", cpfCnpj: "123" },
  itens: [{ produto: { id: 111, sku: "ACD003", descricao: "Barra" }, quantidade: 1 }],
  nomeEcommerce: "Mercado Livre",
  idPedidoEcommerce: "2000016940388786",
  formaEnvio: { id: "1", descricao: "ME" },
  formaFrete: { id: "2" },
  transportadorId: null,
  dataEnvio: null,
} as unknown as TinyPedidoDetalhe;

function input() {
  return {
    webhookLogId: "wlog-1",
    pedido: PEDIDO,
    empresaOrigemId: "emp-1",
    galpaoOrigemId: "galpao-1",
    galpaoOrigemNome: "CWB" as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rec.pedidoUpserts = [];
  rec.jobInserts = [];
  rec.webhookUpdates = [];
  state.mappings = [{ produto_id: "uuid-1", tiny_produto_id: 111 }];
  state.produtos = [
    { id: "uuid-1", sku: "ACD003", descricao: "Barra", gtin: null, imagem_url: null, eh_kit: false },
  ];
  state.existente = null;
  state.vendedorPrev = null;
  state.sysUser = null;
  state.job = null;
  state.jobExistentePendente = null;
});

describe("processWebhookWms — idempotência de re-entrega (regressão #51426)", () => {
  it("pula reprocesso quando já existe job lancar_estoque (não regride status nem duplica job)", async () => {
    // Pedido comprometido: propria já intake'd (job existe), ainda não picado
    // (estoque_lancado=false). Simula o atualizacao_pedido pós-NF.
    state.existente = { estoque_lancado: false };
    state.job = { id: "job-1" };

    const res = await processWebhookWms(input());

    expect(res.status).toBe("duplicado");
    expect(rec.pedidoUpserts).toHaveLength(0); // NÃO regride status_separacao
    expect(rec.jobInserts).toHaveLength(0); // NÃO enfileira job duplicado
    expect(rec.webhookUpdates[0]).toMatchObject({ status: "duplicado" });
  });

  it("processa normalmente um pedido NOVO (sem job): upsert aguardando_nf + enfileira job", async () => {
    state.existente = null;
    state.job = null;

    const res = await processWebhookWms(input());

    expect(res.status).toBe("executando");
    expect(rec.pedidoUpserts).toHaveLength(1);
    expect(rec.pedidoUpserts[0]).toMatchObject({ status_separacao: "aguardando_nf", decisao_final: "propria" });
    expect(rec.jobInserts).toHaveLength(1);
    expect(rec.jobInserts[0]).toMatchObject({ tipo: "lancar_estoque" });
  });

  it("NÃO super-pula: pedido existe mas SEM job (erro antes do enqueue / retry) → reprocessa", async () => {
    state.existente = { estoque_lancado: false };
    state.job = null; // nenhum job ainda → não está comprometido

    const res = await processWebhookWms(input());

    expect(res.status).toBe("executando");
    expect(rec.pedidoUpserts).toHaveLength(1);
    expect(rec.jobInserts).toHaveLength(1);
  });
});
