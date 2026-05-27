import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { montarDashboardTarefas } from "../../src/lib/wms/dashboard-tarefas";

/**
 * P5 §2 — Reproduz bug 0.5/5.8 do filtro galpao_id em pedidos
 * pendentes (aprovação). Pedidos `pendente` recém-chegados ainda têm
 * `separacao_galpao_id IS NULL` — operador precisa vê-los no filtro do
 * galpão dele pra decidir. Antes do fix, `.eq("separacao_galpao_id", X)`
 * excluía esses NULL.
 *
 * NOTE: requer `.env.test.local` com SUPABASE_SERVICE_ROLE_KEY válido.
 * Sem isso, `createServiceClient()` falha e o test não roda. O harness
 * (globalSetup) também trunca dados operacionais antes — por isso
 * limpamos APENAS as rows que esse teste cria (idempotente).
 */

const PEDIDO_PREFIX = "P5-TEST-GALPAO-FILTER";

describe("montarDashboardTarefas - galpão filter", () => {
  let sb: ReturnType<typeof createServiceClient>;
  let galpaoCwbId: string;
  let empresaId: string;
  let createdPedidos: string[] = [];

  beforeEach(async () => {
    sb = createServiceClient();
    const { data: g, error: eg } = await sb
      .from("siso_galpoes")
      .select("id")
      .eq("nome", "CWB")
      .single();
    if (eg || !g) throw new Error(`Galpão CWB não encontrado: ${eg?.message ?? "vazio"}`);
    galpaoCwbId = (g as { id: string }).id;

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

  it("filtro de galpão inclui pendentes com separacao_galpao_id NULL", async () => {
    const tag = Date.now().toString(36);
    const hoje = new Date().toISOString().slice(0, 10);
    const baseRow = {
      data: hoje,
      filial_origem: "CWB" as const,
      cliente_nome: "Cliente teste P5 §2",
      status: "pendente" as const,
      empresa_origem_id: empresaId,
      origem_pedido: "manual" as const,
    };
    const seed = [
      { id: `${PEDIDO_PREFIX}-${tag}-1`, numero: `${PEDIDO_PREFIX}-${tag}-1`, ...baseRow, separacao_galpao_id: null },
      { id: `${PEDIDO_PREFIX}-${tag}-2`, numero: `${PEDIDO_PREFIX}-${tag}-2`, ...baseRow, separacao_galpao_id: null },
      { id: `${PEDIDO_PREFIX}-${tag}-3`, numero: `${PEDIDO_PREFIX}-${tag}-3`, ...baseRow, separacao_galpao_id: null },
      { id: `${PEDIDO_PREFIX}-${tag}-4`, numero: `${PEDIDO_PREFIX}-${tag}-4`, ...baseRow, separacao_galpao_id: galpaoCwbId },
      { id: `${PEDIDO_PREFIX}-${tag}-5`, numero: `${PEDIDO_PREFIX}-${tag}-5`, ...baseRow, separacao_galpao_id: galpaoCwbId },
    ];
    const { data, error } = await sb.from("siso_pedidos").insert(seed).select("id");
    if (error) throw error;
    createdPedidos = (data as Array<{ id: string }>).map((r) => r.id);

    const r = await montarDashboardTarefas(sb, galpaoCwbId);
    // 5 pedidos seedados — 3 com galpão NULL + 2 com CWB. Todos devem ser
    // visíveis pelo operador do CWB.
    expect(r.aprovacao.count).toBeGreaterThanOrEqual(5);

    const rSemFiltro = await montarDashboardTarefas(sb, null);
    expect(rSemFiltro.aprovacao.count).toBeGreaterThanOrEqual(r.aprovacao.count);
  });
});
