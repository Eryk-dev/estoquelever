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
  existente: null as
    | {
        estoque_lancado: boolean;
        separacao_futura?: boolean;
        status_separacao?: string | null;
        decisao_final?: string | null;
        empresa_origem_id?: string | null;
      }
    | null,
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
vi.mock("./ml-api", () => ({
  getActiveMlConnectionForEmpresa: vi.fn(async () => null),
  getMlShipmentSla: vi.fn(async () => null),
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
const ensureProdutoFromTinyMock = vi.fn(async () => "uuid-new");
vi.mock("./wms/sync-tiny", () => ({
  ensureProdutoFromTiny: (...args: unknown[]) => ensureProdutoFromTinyMock(...args),
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

describe("processWebhookWms — produto não vinculado / auto-provisionamento", () => {
  it("item com produto_id=0 → pedido PENDENTE com marcador REQUER_SKU, sem job e sem reserva", async () => {
    const pedidoZero = {
      ...PEDIDO,
      itens: [{ produto: { id: 0, sku: "VERIFICAR LADO", descricao: "Farol" }, quantidade: 1 }],
    } as unknown as TinyPedidoDetalhe;

    const res = await processWebhookWms({ ...input(), pedido: pedidoZero });

    expect(res.status).toBe("pendente");
    expect(rec.jobInserts).toHaveLength(0); // não auto-aprova OC
    expect(rec.pedidoUpserts).toHaveLength(1);
    expect(rec.pedidoUpserts[0]).toMatchObject({
      status: "pendente",
      decisao_final: null,
      status_separacao: null,
      marcadores: ["REQUER_SKU", "LVR"],
    });
    // id=0 não dispara auto-provisionamento (não há como buscar no Tiny)
    expect(ensureProdutoFromTinyMock).not.toHaveBeenCalled();
  });

  it("item com tiny_produto_id válido mas sem mapeamento → auto-provisiona do Tiny", async () => {
    state.mappings = []; // id 111 não mapeado ainda
    state.produtos = [
      { id: "uuid-new", sku: "ACD003", descricao: "Barra", gtin: null, imagem_url: null, eh_kit: false },
    ];

    const res = await processWebhookWms(input());

    expect(ensureProdutoFromTinyMock).toHaveBeenCalledWith("ACD003", "emp-1", 111);
    expect(res.status).toBe("executando"); // resolvido → roteia propria normal
  });
});

describe("processWebhookWms — separação futura (Fase 2)", () => {
  it("futura propria NOVA: reserva sem NF, aguardando_separacao, flag+tag+marcador, ZERO job", async () => {
    state.existente = null;
    state.job = null;

    const res = await processWebhookWms({ ...input(), separacaoFutura: true });

    expect(res.status).toBe("executando");
    expect(rec.pedidoUpserts).toHaveLength(1);
    expect(rec.pedidoUpserts[0]).toMatchObject({
      separacao_futura: true,
      // futura propria NÃO passa por aguardando_nf (sem etapa de NF)
      status_separacao: "aguardando_separacao",
      decisao_final: "propria",
      separacao_tags: ["FUTURA"],
    });
    expect(rec.pedidoUpserts[0].marcadores).toContain("SEP FUTURA");
    // CRUCIAL: futura propria não enfileira lancar_estoque (sem NF, sem baixa;
    // a R segura o estoque; preserva re-processabilidade da promoção).
    expect(rec.jobInserts).toHaveLength(0);
  });

  it("re-detecção de buffered já carregado (poll re-vê) → no-op, não regride pick", async () => {
    // Futura já picada (separado), poll re-detecta como buffered.
    state.existente = { estoque_lancado: false, separacao_futura: true, status_separacao: "separado" };
    state.job = null;

    const res = await processWebhookWms({ ...input(), separacaoFutura: true });

    expect(res.status).toBe("duplicado");
    expect(rec.pedidoUpserts).toHaveLength(0); // NÃO regride separado → aguardando_separacao
    expect(rec.jobInserts).toHaveLength(0);
    expect(rec.webhookUpdates[0]).toMatchObject({ status: "duplicado" });
  });

  it("pedido normal (separacaoFutura ausente) continua aguardando_nf + enfileira job", async () => {
    state.existente = null;
    state.job = null;

    const res = await processWebhookWms(input());

    expect(res.status).toBe("executando");
    expect(rec.pedidoUpserts[0]).toMatchObject({
      separacao_futura: false,
      status_separacao: "aguardando_nf",
    });
    expect(rec.pedidoUpserts[0].separacao_tags).toBeUndefined();
    expect(rec.jobInserts).toHaveLength(1);
  });

  it("futura OC (sem cobertura): ENFILEIRA lancar_estoque decisao=oc (worker resolve compra sem NF)", async () => {
    state.existente = null;
    state.job = null;
    // sem cobertura → rota oc; futura OC precisa do job pra resolver a compra.
    rotearMock.mockResolvedValueOnce(
      { decisao: "oc", motivo: "sem_cobertura" } as unknown as Awaited<
        ReturnType<typeof rotearMock>
      >,
    );

    const res = await processWebhookWms({ ...input(), separacaoFutura: true });

    expect(res.status).toBe("executando");
    expect(rec.pedidoUpserts[0]).toMatchObject({
      separacao_futura: true,
      decisao_final: "oc",
      status_separacao: null, // worker (executarMarcadoresOnly) seta validacao_oc
    });
    expect(rec.pedidoUpserts[0].marcadores).toEqual(
      expect.arrayContaining(["OC", "SEP FUTURA"]),
    );
    expect(rec.jobInserts).toHaveLength(1);
    expect(rec.jobInserts[0]).toMatchObject({ tipo: "lancar_estoque", decisao: "oc" });
  });
});

describe("processWebhookWms — promoção futura (Fase 6: etiqueta liberou)", () => {
  it("futura separado + webhook normal → PROMOVE: flip flag + enfileira lancar_estoque, SEM regredir o pick", async () => {
    // Futura já picada (separado), decisao propria. Chega webhook normal (sem
    // separacaoFutura) = etiqueta liberou.
    state.existente = {
      estoque_lancado: false,
      separacao_futura: true,
      status_separacao: "separado",
      decisao_final: "propria",
      empresa_origem_id: "emp-1",
    };
    state.job = null;
    state.jobExistentePendente = null;

    const res = await processWebhookWms(input()); // sem separacaoFutura

    expect(res.status).toBe("promovido");
    // NÃO passa pelo upsert ingênuo (não regride separado → aguardando_nf).
    expect(rec.pedidoUpserts).toHaveLength(0);
    // Enfileira lancar_estoque (agora gera NF + agrupamento).
    expect(rec.jobInserts).toHaveLength(1);
    expect(rec.jobInserts[0]).toMatchObject({ tipo: "lancar_estoque", decisao: "propria" });
    expect(rec.webhookUpdates[0]).toMatchObject({ status: "concluido" });
  });

  it("promoção idempotente: 2ª re-entrega com job já existente → duplicado (não duplica NF)", async () => {
    // Após promover, já há job lancar_estoque → early-return de idempotência.
    state.existente = {
      estoque_lancado: false,
      separacao_futura: false, // já promovido
      status_separacao: "separado",
      decisao_final: "propria",
      empresa_origem_id: "emp-1",
    };
    state.job = { id: "job-promo" }; // job de promoção já existe

    const res = await processWebhookWms(input());

    expect(res.status).toBe("duplicado");
    expect(rec.jobInserts).toHaveLength(0);
  });
});
