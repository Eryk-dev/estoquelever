import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createServiceClient } from "../../src/lib/supabase-server";
import { GET as vendasGET } from "../../src/app/api/wms/vendas/route";
import { montarDashboardTarefas } from "../../src/lib/wms/dashboard-tarefas";

/**
 * Zero-regressão (FULL-07): pedidos Full NÃO vazam pras lanes/telas existentes.
 * Prova (isolado, cleanup próprio) que um Full some de /api/wms/vendas e dos
 * cards da home (dashboard-tarefas), presente só na lane Full.
 *
 * O card da home usa contagem (não ids) → discriminamos com FLIP do flag: com
 * separacao_full=true o Full é excluído; virando false ele entra (delta = +1),
 * provando que o guard filtra exatamente por separacao_full.
 */

const sb = createServiceClient();

let cwbId: string;
let empresaId: string;
let userId: string;
let sessId: string;
const seededPedidoIds: string[] = [];
let seq = 0;

async function seedPedido(opts: { full: boolean; status_separacao: string }): Promise<string> {
  const id = `${opts.full ? "FULLREG" : "NORMREG"}-${Date.now()}-${++seq}`;
  const { error } = await sb.from("siso_pedidos").insert({
    id,
    numero: id,
    status: "executando",
    data: "2026-07-01",
    filial_origem: "CWB",
    cliente_nome: id,
    origem_pedido: "manual",
    empresa_origem_id: empresaId,
    separacao_galpao_id: cwbId,
    separacao_operador_id: userId,
    separacao_full: opts.full,
    status_separacao: opts.status_separacao,
    marcadores: opts.full ? ["WMS", "FULL"] : ["WMS"],
  });
  if (error) throw new Error(`seedPedido (${id}): ${error.message}`);
  seededPedidoIds.push(id);
  return id;
}

function vendas(qs: string) {
  return vendasGET(new NextRequest(`http://test/api/wms/vendas?${qs}`, { headers: { "X-Session-Id": sessId } }));
}

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  cwbId = g!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").eq("cnpj", "34857388000163").single();
  empresaId = e!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "admin-runner").single();
  userId = u!.id as string;
  const { data: s } = await sb
    .from("siso_sessoes")
    .insert({ usuario_id: userId, expira_em: new Date(Date.now() + 3600_000).toISOString() })
    .select("id")
    .single();
  sessId = s!.id as string;
});

afterAll(async () => {
  if (seededPedidoIds.length > 0) await sb.from("siso_pedidos").delete().in("id", seededPedidoIds);
  await sb.from("siso_sessoes").delete().eq("id", sessId);
});

describe("FULL-07 — /api/wms/vendas exclui Full", () => {
  it("Full ausente das abas Pendentes e Em separação; venda manual normal presente", async () => {
    const fullId = await seedPedido({ full: true, status_separacao: "em_separacao" });
    const normalId = await seedPedido({ full: false, status_separacao: "em_separacao" });

    const idsSep = ((await (await vendas("tab=em_separacao")).json()).pedidos as Array<{ id: string }>).map((p) => p.id);
    expect(idsSep).toContain(normalId);
    expect(idsSep).not.toContain(fullId);

    // Full é status=executando → cairia na aba Pendentes sem o guard.
    const idsPend = ((await (await vendas("tab=pendentes")).json()).pedidos as Array<{ id: string }>).map((p) => p.id);
    expect(idsPend).not.toContain(fullId);
  });
});

describe("FULL-07 — dashboard-tarefas (home) exclui Full", () => {
  it("card Separação: Full em em_separacao não conta (flip full→normal soma +1)", async () => {
    const id = await seedPedido({ full: true, status_separacao: "em_separacao" });
    const c1 = (await montarDashboardTarefas(sb, cwbId)).separacao.count;
    await sb.from("siso_pedidos").update({ separacao_full: false }).eq("id", id);
    const c2 = (await montarDashboardTarefas(sb, cwbId)).separacao.count;
    expect(c2).toBe(c1 + 1);
  });

  it("card Embalagem: Full em separado não conta (flip full→normal soma +1)", async () => {
    const id = await seedPedido({ full: true, status_separacao: "separado" });
    const e1 = (await montarDashboardTarefas(sb, cwbId)).embalagem.count;
    await sb.from("siso_pedidos").update({ separacao_full: false }).eq("id", id);
    const e2 = (await montarDashboardTarefas(sb, cwbId)).embalagem.count;
    expect(e2).toBe(e1 + 1);
  });
});
