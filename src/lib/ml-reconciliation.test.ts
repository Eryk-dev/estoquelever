import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), read: vi.fn(), release: vi.fn() }));
vi.mock("./supabase-server", () => ({ createServiceClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("./ml-reconciliation-api", () => ({ getMlReconciliationEvidence: mocks.read }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
import { reconcileMlOrders } from "./ml-reconciliation";

const companies = ["NetAir", "NetParts", "EasyPeasy", "EasyPeasy SP", "141AIR", "Bellator"]
  .map((nome, index) => ({ id: `company-${index}`, nome }));
const connections = companies.map(e => ({ id: `conn-${e.id}`, empresa_id: e.id, ml_user_id: 300 }));
const snapshots = companies.map(e => ({
  id: e.id, empresa_origem_id: e.id, id_pedido_ecommerce: "100", ml_shipment_id: "200",
  status_separacao: "embalado", etiqueta_status: "impresso", data: "2026-10-19",
  decisao_final: "propria", impressao_em: null, atividade_em: "2026-10-20T10:00:00Z",
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({
    kind: "shipment", resourceId: "200", orderReference: "100", connectionId: "conn", sellerId: "300",
    checkedAt: new Date().toISOString(), status: "shipped", substatus: null, noShipping: false, history: [],
  });
  mocks.from.mockImplementation((table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      update: (data: unknown) => { mocks.release(data); return query; },
      in: (_column: string, ids: string[]) => Promise.resolve({ data: connections.filter(c => ids.includes(c.empresa_id)) }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: table === "siso_empresas" ? companies : null })),
    };
    return query;
  });
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name.endsWith("_claim")) {
      return { data: args.p_lane === "dispatch" ? snapshots.filter(s => s.empresa_origem_id === args.p_empresa_id) : [] };
    }
    return { data: { changed: true, conflict: false } };
  });
});

describe("varredura automática por empresa", () => {
  it("confere todas as cinco empresas e nunca consulta Bellator", async () => {
    const result = await reconcileMlOrders();
    expect(result.companies).toHaveLength(5);
    expect(result.companies.every(c => c.changed === 1 && c.errors === 0)).toBe(true);
    expect(mocks.read).toHaveBeenCalledTimes(5);
    expect(mocks.rpc.mock.calls.some(([, args]) => args.p_empresa_id === "company-5")).toBe(false);
    expect(mocks.release).toHaveBeenCalledTimes(5);
  });
  it("falha de API registra erro sem propor mudança de etapa", async () => {
    mocks.read.mockRejectedValue(new Error("ML API 429"));
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name.endsWith("_claim")) return { data: args.p_lane === "dispatch" ? [snapshots.find(s => s.id === args.p_empresa_id)] : [] };
      return { data: { changed: false } };
    });
    const result = await reconcileMlOrders();
    expect(result.companies.every(c => c.errors === 1 && c.changed === 0)).toBe(true);
    const finishes = mocks.rpc.mock.calls.filter(([name]) => name.endsWith("_finish"));
    expect(finishes.every(([, args]) => args.p_target === null && args.p_error === "ML API 429" && args.p_evidence === null)).toBe(true);
  });
  it("não força novamente uma atualização que perdeu a corrida com a operação", async () => {
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name.endsWith("_claim")) return { data: args.p_lane === "dispatch" ? [snapshots.find(s => s.id === args.p_empresa_id)] : [] };
      return { data: { changed: false, conflict: true } };
    });
    const result = await reconcileMlOrders({ dryRun: true });
    expect(result.companies.every(c => c.changed === 0 && c.conflicts === 1)).toBe(true);
    expect(mocks.rpc.mock.calls.filter(([name]) => name.endsWith("_finish"))).toHaveLength(5);
    expect(mocks.rpc.mock.calls.filter(([name]) => name.endsWith("_finish")).every(([, args]) => args.p_dry_run)).toBe(true);
  });
  it("429 interrompe a conta até o próximo ciclo, sem martelar os demais pedidos", async () => {
    mocks.read.mockRejectedValue(new Error("ML API 429 /shipments/200: rate_limit"));
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name.endsWith("_claim")) {
        const snapshot = snapshots.find(s => s.id === args.p_empresa_id)!;
        return { data: args.p_lane === "dispatch" ? [snapshot, { ...snapshot, id: `${snapshot.id}-2` }] : [] };
      }
      return { data: { changed: false } };
    });
    const result = await reconcileMlOrders();
    expect(mocks.read).toHaveBeenCalledTimes(5);
    expect(result.companies.every(c => c.errors === 1 && c.deferred === 1)).toBe(true);
    expect(mocks.release).toHaveBeenCalledTimes(5);
  });
});
