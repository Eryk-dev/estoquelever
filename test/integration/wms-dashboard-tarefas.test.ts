import { describe, it, expect, beforeAll, afterEach } from "vitest";
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

describe("montarDashboardTarefas - aprovacao só transferência", () => {
  let sb: ReturnType<typeof createServiceClient>;
  let empresaId: string;
  const PEDIDO_PREFIX = "TEST-APROVACAO-SUGESTAO";
  let createdPedidos: string[] = [];

  beforeAll(async () => {
    sb = createServiceClient();
    const { data: e, error: ee } = await sb
      .from("siso_empresas")
      .select("id")
      .limit(1)
      .single();
    if (ee || !e) throw new Error(`Nenhuma empresa cadastrada: ${ee?.message ?? "vazio"}`);
    empresaId = (e as { id: string }).id;
  });

  afterEach(async () => {
    if (createdPedidos.length > 0) {
      await sb.from("siso_pedidos").delete().in("id", createdPedidos);
      createdPedidos = [];
    }
  });

  it("aprovacao conta só transferência", async () => {
    const tag = Date.now().toString(36);
    const hoje = new Date().toISOString().slice(0, 10);
    const baseRow = {
      data: hoje,
      filial_origem: "CWB" as const,
      cliente_nome: "Cliente teste aprovacao sugestao",
      status: "pendente" as const,
      empresa_origem_id: empresaId,
      origem_pedido: "webhook" as const,
    };
    const seed = [
      {
        id: `${PEDIDO_PREFIX}-${tag}-1`,
        numero: `${PEDIDO_PREFIX}-${tag}-1`,
        ...baseRow,
        sugestao: "propria",
      },
      {
        id: `${PEDIDO_PREFIX}-${tag}-2`,
        numero: `${PEDIDO_PREFIX}-${tag}-2`,
        ...baseRow,
        sugestao: "oc",
      },
      {
        id: `${PEDIDO_PREFIX}-${tag}-3`,
        numero: `${PEDIDO_PREFIX}-${tag}-3`,
        ...baseRow,
        sugestao: "transferencia",
      },
    ];
    const { data, error } = await sb.from("siso_pedidos").insert(seed).select("id");
    if (error) throw error;
    createdPedidos = (data as Array<{ id: string }>).map((r) => r.id);

    const dash = await montarDashboardTarefas(sb, null);
    // Apenas o pedido com sugestao='transferencia' deve ser contado
    // — propria e oc auto-aprovam no webhook (FASE 1).
    // Usamos count >= 1 pois pode haver outras transferências no staging.
    // A invariante real: count NÃO inclui propria e oc que inserimos.
    // Verificamos pela diferença: contar apenas transferência deve ser
    // menor que contar os 3 (o que a query fazia antes do fix).
    expect(dash.aprovacao.count).toBeGreaterThanOrEqual(1);

    // Verificação precisa: pedidos propria e oc que inserimos NÃO devem
    // elevar o count. Chamamos sem os seeds para comparar:
    // Alternativa: conta direto no banco quantos pendentes+transferência existem.
    const { count: transferCount } = await sb
      .from("siso_pedidos")
      .select("id", { count: "exact", head: true })
      .eq("status", "pendente")
      .eq("sugestao", "transferencia");

    expect(dash.aprovacao.count).toBe(transferCount ?? 0);
  });
});
