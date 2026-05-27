import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { montarDashboardTarefas } from "../../src/lib/wms/dashboard-tarefas";

describe("montarDashboardTarefas - excecoes", () => {
  let sb: ReturnType<typeof createServiceClient>;

  beforeAll(() => {
    sb = createServiceClient();
  });

  it("retorna chave excecoes com 6 contadores", async () => {
    const r = await montarDashboardTarefas(sb, null);
    expect(r.excecoes).toBeDefined();
    expect(r.excecoes).toMatchObject({
      devolucoes: expect.objectContaining({ count: expect.any(Number) }),
      transferencias_transito: expect.objectContaining({
        count: expect.any(Number),
      }),
      inventario_revisao: expect.objectContaining({ count: expect.any(Number) }),
      reservas_orfas: expect.objectContaining({ count: expect.any(Number) }),
      retroativos: expect.objectContaining({ count: expect.any(Number) }),
      recebimento_orfao: expect.objectContaining({ count: expect.any(Number) }),
    });
  });

  it("split aprovacao marketplace + manual = total", async () => {
    const r = await montarDashboardTarefas(sb, null);
    expect(r.aprovacao.marketplace + r.aprovacao.manual).toBe(
      r.aprovacao.count,
    );
  });
});
