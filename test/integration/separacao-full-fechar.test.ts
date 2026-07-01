import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createServiceClient } from "../../src/lib/supabase-server";
import { POST as fecharPOST } from "../../src/app/api/wms/separacao/full/fechar/route";
import { GET as separacaoGET } from "../../src/app/api/wms/separacao/route";

/**
 * Separação Full — etapa Fechar (FULL-04). Fechar só grava fechado_em/por
 * (status_separacao segue `separado`), sem estoque/NF; idempotente; reversível.
 * Abas virtuais: Separado = fechado_em NULL, Fechados = fechado_em NOT NULL.
 *
 * Isolado: usa admin-runner (role admin, criado por seedInicial→seedTestUsers)
 * pois fechar/reabrir são gated (separacao.executar/administrar). Limpa tudo.
 */

const sb = createServiceClient();

let cwbId: string;
let empresaId: string;
let sessId: string;
const seededPedidoIds: string[] = [];
let seq = 0;

async function seedFull(fechado: boolean): Promise<string> {
  const id = `FULL-FECHAR-${Date.now()}-${++seq}`;
  const { error } = await sb.from("siso_pedidos").insert({
    id,
    numero: id,
    status: "executando",
    data: "2026-07-01",
    filial_origem: "CWB",
    cliente_nome: id,
    separacao_galpao_id: cwbId,
    empresa_origem_id: empresaId,
    separacao_full: true,
    decisao_final: "propria",
    status_separacao: "separado",
    fechado_em: fechado ? new Date().toISOString() : null,
    marcadores: ["WMS", "FULL"],
  });
  if (error) throw new Error(`seedFull falhou (${id}): ${error.message}`);
  seededPedidoIds.push(id);
  return id;
}

function fechar(body: unknown) {
  return fecharPOST(
    new NextRequest("http://test/api/wms/separacao/full/fechar", {
      method: "POST",
      headers: { "X-Session-Id": sessId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function getSeparacao(qs: string) {
  return separacaoGET(
    new NextRequest(`http://test/api/wms/separacao?${qs}`, {
      headers: { "X-Session-Id": sessId },
    }),
  );
}

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  cwbId = g!.id;
  const { data: e } = await sb.from("siso_empresas").select("id").eq("cnpj", "34857388000163").single();
  empresaId = e!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "admin-runner").single();
  const { data: s } = await sb
    .from("siso_sessoes")
    .insert({ usuario_id: u!.id, expira_em: new Date(Date.now() + 3600_000).toISOString() })
    .select("id")
    .single();
  sessId = s!.id as string;
});

afterAll(async () => {
  if (seededPedidoIds.length > 0) {
    await sb.from("siso_pedidos").delete().in("id", seededPedidoIds);
  }
  await sb.from("siso_sessoes").delete().eq("id", sessId);
});

describe("POST /api/wms/separacao/full/fechar", () => {
  it("fecha um Full separado: grava fechado_em/por, status segue separado, ledger intacto, idempotente", async () => {
    const id = await seedFull(false);

    // Baseline: nenhuma mov no ledger pro pedido.
    const movsAntes = await sb.from("siso_movimentacoes").select("id", { count: "exact", head: true }).eq("pedido_id", id);
    expect(movsAntes.count ?? 0).toBe(0);

    const res = await fechar({ pedido_ids: [id] });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.atualizados).toContain(id);

    const { data: p } = await sb
      .from("siso_pedidos")
      .select("fechado_em, fechado_por, status_separacao")
      .eq("id", id)
      .single();
    expect(p?.fechado_em).not.toBeNull();
    expect(p?.fechado_por).toBeTruthy();
    expect(p?.status_separacao).toBe("separado"); // fechado é VIRTUAL

    // Ledger inalterado (fechar não mexe em estoque).
    const movsDepois = await sb.from("siso_movimentacoes").select("id", { count: "exact", head: true }).eq("pedido_id", id);
    expect(movsDepois.count ?? 0).toBe(0);

    // Idempotente: fechar de novo = no-op.
    const res2 = await fechar({ pedido_ids: [id] });
    const json2 = await res2.json();
    expect(json2.atualizados).toHaveLength(0);
    expect(json2.ja_no_estado).toBe(1);
  });

  it("reabrir (admin) limpa fechado_em", async () => {
    const id = await seedFull(true);
    const res = await fechar({ pedido_ids: [id], reabrir: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.atualizados).toContain(id);

    const { data: p } = await sb.from("siso_pedidos").select("fechado_em").eq("id", id).single();
    expect(p?.fechado_em).toBeNull();
  });

  it("abas virtuais: separado=fechado_em NULL, fechados=fechado_em NOT NULL", async () => {
    const aberto = await seedFull(false);
    const fechadoId = await seedFull(true);

    const resSep = await getSeparacao("full=1&fechado=0&status_separacao=separado");
    const idsSep = ((await resSep.json()).pedidos as Array<{ id: string }>).map((p) => p.id);
    expect(idsSep).toContain(aberto);
    expect(idsSep).not.toContain(fechadoId);

    const resFech = await getSeparacao("full=1&fechado=1&status_separacao=separado");
    const idsFech = ((await resFech.json()).pedidos as Array<{ id: string }>).map((p) => p.id);
    expect(idsFech).toContain(fechadoId);
    expect(idsFech).not.toContain(aberto);
  });
});
