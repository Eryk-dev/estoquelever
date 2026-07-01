import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createServiceClient } from "../../src/lib/supabase-server";
import { GET as separacaoGET } from "../../src/app/api/wms/separacao/route";

/**
 * Separação Full — lane de listagem (FULL-02) + zero-regressão (FULL-07).
 *
 * `?full=1` deve listar SÓ pedidos `separacao_full=true`; a lane normal (sem
 * `full`) deve EXCLUÍ-los. Cobre as 4 abas da lane Full.
 */

const sb = createServiceClient();

let cwbId: string;
let userId: string;
let sessId: string;
let seq = 0;

// Isolamento: staging é vivo, nunca truncamos. Este teste cria pedidos com id
// único e DELETA todos ao fim (afterAll) — zero resíduo na lane real.
const seededPedidoIds: string[] = [];

function pedidoId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function seedPedido(opts: {
  separacao_full?: boolean;
  status_separacao?: string;
  fechado_em?: string | null;
}): Promise<string> {
  const id = pedidoId(opts.separacao_full ? "FULL" : "NORM");
  const { error } = await sb.from("siso_pedidos").insert({
    id,
    status: "executando",
    numero: id,
    data: "2026-07-01",
    filial_origem: "CWB",
    cliente_nome: id, // NOT NULL no schema; valor único pra rastrear/limpar
    separacao_galpao_id: cwbId,
    separacao_full: opts.separacao_full ?? false,
    status_separacao: opts.status_separacao ?? "aguardando_separacao",
    fechado_em: opts.fechado_em ?? null,
    marcadores: opts.separacao_full ? ["WMS", "FULL"] : ["WMS"],
  });
  if (error) throw new Error(`seedPedido falhou (${id}): ${error.message}`);
  seededPedidoIds.push(id);
  return id;
}

function getSeparacao(qs: string, sessionId: string) {
  return separacaoGET(
    new NextRequest(`http://test/api/wms/separacao?${qs}`, {
      headers: { "X-Session-Id": sessionId },
    }),
  );
}

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  cwbId = g!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  userId = u!.id;
  const { data: s } = await sb
    .from("siso_sessoes")
    .insert({ usuario_id: userId, expira_em: new Date(Date.now() + 3600_000).toISOString() })
    .select("id")
    .single();
  sessId = s!.id as string;
});

afterAll(async () => {
  // Limpa TUDO que o teste criou (pedidos + eventual sessão). Sem isso, os
  // NORM-*/FULL-* vazariam pra lane real de separação.
  if (seededPedidoIds.length > 0) {
    await sb.from("siso_pedido_itens").delete().in("pedido_id", seededPedidoIds);
    await sb.from("siso_pedidos").delete().in("id", seededPedidoIds);
  }
  await sb.from("siso_sessoes").delete().eq("id", sessId);
});

describe("GET /api/wms/separacao — discriminador separacao_full", () => {
  it("?full=1 lista só pedidos Full; sem full exclui Full", async () => {
    const fullId = await seedPedido({ separacao_full: true });
    const normalId = await seedPedido({ separacao_full: false });

    const resFull = await getSeparacao("full=1&status_separacao=aguardando_separacao", sessId);
    const jsonFull = await resFull.json();
    const idsFull = (jsonFull.pedidos as Array<{ id: string }>).map((p) => p.id);
    expect(idsFull).toContain(fullId);
    expect(idsFull).not.toContain(normalId);

    const resNormal = await getSeparacao("status_separacao=aguardando_separacao", sessId);
    const jsonNormal = await resNormal.json();
    const idsNormal = (jsonNormal.pedidos as Array<{ id: string }>).map((p) => p.id);
    expect(idsNormal).toContain(normalId);
    expect(idsNormal).not.toContain(fullId);
  });

  it("counts da RPC também respeitam full=1 (não mistura com a fila normal)", async () => {
    await seedPedido({ separacao_full: true, status_separacao: "em_separacao" });

    const resFull = await getSeparacao("full=1", sessId);
    const jsonFull = await resFull.json();
    expect(jsonFull.counts.em_separacao).toBeGreaterThanOrEqual(1);
  });
});
