import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MlShipmentRecuperacao } from "./ml-api";
import type { NfRecuperacaoInput } from "./recuperacao-nf-pedido";

const mocks = vi.hoisted(() => ({
  results: [] as Array<{ data: unknown; error: unknown }>,
  writes: [] as Array<{ table: string; method: string; value: unknown }>,
  pedido: vi.fn(), envio: vi.fn(), processar: vi.fn(), empresa: vi.fn(),
}));
vi.mock("./supabase-server", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const result = mocks.results.shift();
      if (!result) throw new Error(`Consulta inesperada: ${table}`);
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "neq", "or", "limit", "insert", "update"]) {
        chain[method] = (...args: unknown[]) => {
          if (["insert", "update"].includes(method)) mocks.writes.push({ table, method, value: args[0] });
          return chain;
        };
      }
      chain.single = chain.maybeSingle = async () => result;
      chain.then = (resolve: (r: unknown) => unknown) => resolve(result);
      return chain;
    },
  }),
}));
vi.mock("./empresa-lookup", () => ({ getEmpresaByCnpj: mocks.empresa }));
vi.mock("./tiny-api", () => ({ getPedido: mocks.pedido }));
vi.mock("./tiny-oauth", () => ({ getValidTokenByEmpresa: async () => ({ token: "fake" }) }));
vi.mock("./tiny-queue", () => ({ runWithEmpresa: (_: string, fn: () => unknown) => fn() }));
vi.mock("./ml-api", () => ({ getMlShipmentRecuperacao: mocks.envio }));
vi.mock("./webhook-processor-wms", () => ({ processWebhookWms: mocks.processar }));

import { envioPermiteRecuperacao, recuperarPedidoPorNf } from "./recuperacao-nf-pedido";

const NF: NfRecuperacaoInput = {
  empresaId: "netair", cnpj: "12345678000199",
  nf: { id: 900001, situacao: 6, chaveAcesso: "1".repeat(44), origem: { id: "900002", tipo: "venda" } },
};
const ENVIO: MlShipmentRecuperacao = {
  id: 123, sender_id: 123456, logistic_type: "cross_docking",
  status: "ready_to_ship", substatus: "ready_to_print",
  status_history: { date_shipped: null },
};
const ok = (data: unknown) => ({ data, error: null });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.results = [];
  mocks.writes = [];
  mocks.empresa.mockResolvedValue({ empresaId: "netair", galpaoId: "cwb", galpaoNome: "CWB" });
  mocks.pedido.mockResolvedValue({
    id: "900002", numero: "1001", nomeEcommerce: "Mercado Livre", idPedidoEcommerce: "2000000000000001",
  });
  mocks.envio.mockResolvedValue(ENVIO);
  mocks.processar.mockResolvedValue({ ok: true });
});
function prepararAusente() {
  mocks.results.push(ok(null), ok({ id: "conn", ml_user_id: 123456 }));
}
describe("elegibilidade de recuperação fiscal", () => {
  it.each(["ready_to_print", "printed", "invoice_pending"])("permite venda aguardando despacho: %s", (substatus) => {
    expect(envioPermiteRecuperacao({ ...ENVIO, substatus }, 123456)).toBe(true);
  });
  it.each(["picked_up", "authorized_by_carrier", "in_hub", "buffered", null, "desconhecido"])(
    "não confunde ready_to_ship/%s com venda a separar", (substatus) => {
      expect(envioPermiteRecuperacao({ ...ENVIO, substatus }, 123456)).toBe(false);
    });
  it.each(["shipped", "delivered", "not_delivered", "cancelled", null])("recusa status %s", (status) => {
    expect(envioPermiteRecuperacao({ ...ENVIO, status }, 123456)).toBe(false);
  });
  it("recusa Full, outro vendedor, envio desconhecido ou já despachado no histórico", () => {
    expect(envioPermiteRecuperacao({ ...ENVIO, logistic_type: "fulfillment" }, 123456)).toBe(false);
    expect(envioPermiteRecuperacao(ENVIO, 99)).toBe(false);
    expect(envioPermiteRecuperacao(null, 123456)).toBe(false);
    expect(envioPermiteRecuperacao({ ...ENVIO, status_history: { date_shipped: "2026-10-19" } }, 123456)).toBe(false);
  });
});
describe("recuperarPedidoPorNf", () => {
  it("exclui Bellator da recuperação", async () => {
    mocks.results.push(ok(null));
    mocks.empresa.mockResolvedValue({ empresaId: "netair", empresaNome: "Bellator" });
    expect(await recuperarPedidoPorNf(NF)).toBeNull();
    expect(mocks.pedido).not.toHaveBeenCalled();
    expect(mocks.processar).not.toHaveBeenCalled();
  });
  it("recupera faturado ausente com a mesma NF e o mesmo shipment antes de enfileirar", async () => {
    prepararAusente();
    mocks.results.push(ok([]), ok({ id: "log-recuperacao" }));
    expect(await recuperarPedidoPorNf(NF)).toBe("900002");
    expect(mocks.processar).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      webhookLogId: "log-recuperacao", empresaOrigemId: "netair", galpaoOrigemNome: "CWB",
      recuperacaoNf: { id: "900001", chaveAcesso: "1".repeat(44), shipmentId: "123", retomar: false },
    }));
  });
  it.each([1, 2, 5, 9])("não recupera NF não autorizada (%s)", async (situacao) => {
    expect(await recuperarPedidoPorNf({ ...NF, nf: { ...NF.nf, situacao } })).toBeNull();
    expect(mocks.pedido).not.toHaveBeenCalled();
    expect(mocks.processar).not.toHaveBeenCalled();
  });
  it("preserva pedido já existente sem consultar ou reemitir nada", async () => {
    mocks.results.push(ok({ id: "900002", empresa_origem_id: "netair" }));
    expect(await recuperarPedidoPorNf(NF)).toBe("900002");
    expect(mocks.pedido).not.toHaveBeenCalled();
    expect(mocks.processar).not.toHaveBeenCalled();
  });
  it("bloqueia duplicação do carrinho mesmo com outro Tiny id", async () => {
    prepararAusente();
    mocks.results.push(ok([{ id: "outro-tiny-id" }]));
    expect(await recuperarPedidoPorNf(NF)).toBeNull();
    expect(mocks.processar).not.toHaveBeenCalled();
    expect(mocks.writes).toHaveLength(0);
  });
  it("falha de ML não é permissão para importar", async () => {
    prepararAusente();
    mocks.envio.mockRejectedValue(new Error("ML indisponível"));
    await expect(recuperarPedidoPorNf(NF)).rejects.toThrow("ML indisponível");
    expect(mocks.processar).not.toHaveBeenCalled();
    expect(mocks.writes).toHaveLength(0);
  });
  it("outra execução com lease recente não duplica intake", async () => {
    prepararAusente();
    mocks.results.push(ok([]), { data: null, error: { code: "23505" } },
      ok({ id: "lease", status: "processando", criado_em: new Date().toISOString() }));
    expect(await recuperarPedidoPorNf(NF)).toBeNull();
    expect(mocks.processar).not.toHaveBeenCalled();
  });
  it("retoma intake parcial após falha mantendo o id da NF", async () => {
    mocks.results.push(ok({
      id: "900002", empresa_origem_id: "netair",
      payload_original: { recuperacao_nf_pendente: "900001" },
    }), ok({ id: "conn", ml_user_id: 123456 }), ok([]),
    { data: null, error: { code: "23505" } },
    ok({ id: "lease", status: "erro", criado_em: "2026-10-19T12:00:00Z" }), ok({ id: "lease" }));
    await recuperarPedidoPorNf(NF);
    expect(mocks.processar).toHaveBeenCalledWith(expect.objectContaining({
      recuperacaoNf: expect.objectContaining({ id: "900001", retomar: true }),
    }));
  });
  it("grava erro retryable quando o intake falha", async () => {
    prepararAusente();
    mocks.results.push(ok([]), ok({ id: "lease" }), ok(null));
    mocks.processar.mockRejectedValue(new Error("reserva falhou"));
    await expect(recuperarPedidoPorNf(NF)).rejects.toThrow("reserva falhou");
    expect(mocks.writes.at(-1)).toMatchObject({
      table: "siso_webhook_logs", method: "update", value: { status: "erro", erro: "reserva falhou" },
    });
  });
});
