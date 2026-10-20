import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  recuperar: vi.fn(), nota: vi.fn(), agrupar: vi.fn(),
  parcial: false,
  updates: [] as Array<{ table: string; value: Record<string, unknown> }>,
}));
vi.mock("./supabase-server", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      let inserted = false;
      let selected = "";
      let value: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {};
      const resolve = () => {
        if (value) m.updates.push({ table, value });
        if (inserted) return { data: { id: "nf-log" }, error: null };
        if (table === "siso_pedidos" && selected.includes("payload_original") && m.parcial) {
          return { data: { id: "pedido", payload_original: { recuperacao_nf_pendente: "99" } }, error: null };
        }
        return { data: null, error: null };
      };
      for (const method of ["eq", "in", "is", "not", "filter", "limit"]) chain[method] = () => chain;
      chain.select = (s: string) => { selected = s; return chain; };
      chain.insert = () => { inserted = true; return chain; };
      chain.update = (v: Record<string, unknown>) => { value = v; return chain; };
      chain.single = chain.maybeSingle = async () => resolve();
      chain.then = (f: (r: unknown) => unknown) => f(resolve());
      return chain;
    },
  }),
}));
vi.mock("./recuperacao-nf-pedido", () => ({ recuperarPedidoPorNf: m.recuperar }));
vi.mock("./tiny-api", () => ({ obterNotaFiscal: m.nota }));
vi.mock("./tiny-oauth", () => ({ getValidTokenByEmpresa: async () => ({ token: "fake" }) }));
vi.mock("./tiny-queue", () => ({ runWithEmpresa: (_: string, fn: () => unknown) => fn() }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./historico-service", () => ({ registrarEvento: async () => undefined }));
vi.mock("./agrupamento-service", () => ({ criarAgrupamentoFase1: m.agrupar }));
vi.mock("./wms/cutover", () => ({ dispararCutoverSePronto: vi.fn() }));

import { handleNfWebhook } from "./nf-webhook-handler";
const payload = { cnpj: "12345678000199", tipo: "nota_fiscal", dados: { idNotaFiscalTiny: 99 } };
beforeEach(() => {
  vi.resetAllMocks();
  m.updates = [];
  m.parcial = false;
  m.nota.mockResolvedValue({
    id: 99, situacao: 6, chaveAcesso: "1".repeat(44), origem: { tipo: "venda", id: "pedido" },
  });
  m.agrupar.mockResolvedValue(undefined);
});
describe("NF recebida sem pedido", () => {
  it("recupera antes de agrupar e usa chave buscada no Tiny quando o evento não a contém", async () => {
    m.recuperar.mockResolvedValue("pedido");
    await handleNfWebhook(payload, "empresa", { aguardarFase1: true });
    expect(m.recuperar).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      empresaId: "empresa", nf: expect.objectContaining({ id: 99 }),
    }));
    expect(m.updates).toContainEqual(expect.objectContaining({
      table: "siso_pedidos", value: expect.objectContaining({ nota_fiscal_id: "99", chave_acesso_nf: "1".repeat(44) }),
    }));
    expect(m.agrupar).toHaveBeenCalledWith("pedido");
    expect(m.updates.at(-1)?.value.status).toBe("processado");
  });
  it("falha na recuperação mantém NF retryable e não libera separação", async () => {
    m.recuperar.mockRejectedValue(new Error("ML indisponível"));
    await handleNfWebhook(payload, "empresa");
    expect(m.updates).toEqual([{ table: "siso_webhook_logs", value: { status: "aguardando_pedido" } }]);
    expect(m.agrupar).not.toHaveBeenCalled();
  });
  it("cabeçalho parcial não basta para avançar enquanto outro processo conclui o intake", async () => {
    m.parcial = true;
    m.recuperar.mockResolvedValue(null);
    await handleNfWebhook(payload, "empresa");
    expect(m.recuperar).toHaveBeenCalledOnce();
    expect(m.updates).toEqual([{ table: "siso_webhook_logs", value: { status: "aguardando_pedido" } }]);
    expect(m.agrupar).not.toHaveBeenCalled();
  });
});
