import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { processQueue } from "../../src/lib/execution-worker";

const sb = createServiceClient();
const PEDIDO_ID = `RECLAIM-TEST-${Math.random().toString(36).slice(2, 8)}`;
let empresaId: string;
let staleJobId: string;
let freshJobId: string;

beforeAll(async () => {
  const { data: e } = await sb
    .from("siso_empresas")
    .select("id")
    .eq("ativo", true)
    .order("criado_em", { ascending: true })
    .limit(1)
    .single();
  empresaId = e!.id;

  // Pedido cancelado: o worker pula o job (não toca Tiny), mas o reclaim
  // já deve ter rodado ANTES desse skip. Isolamos só o comportamento de reclaim.
  // siso_pedidos tem NOT NULL em numero/data/filial_origem (colunas legadas) —
  // incluir nos fixtures de teste (o webhook real preenche; o insert direto não).
  await sb.from("siso_pedidos").insert({
    id: PEDIDO_ID,
    numero: PEDIDO_ID,
    data: new Date().toISOString(),
    filial_origem: "TEST",
    status: "cancelado",
    empresa_origem_id: empresaId,
  });

  const seisMinAtras = new Date(Date.now() - 6 * 60_000).toISOString();
  const agora = new Date().toISOString();

  // Job ESTAGNADO: executando há 6min.
  const { data: stale } = await sb
    .from("siso_fila_execucao")
    .insert({
      pedido_id: PEDIDO_ID,
      empresa_id: empresaId,
      tipo: "lancar_estoque",
      decisao: "propria",
      status: "executando",
      tentativas: 0,
      atualizado_em: seisMinAtras,
    })
    .select("id")
    .single();
  staleJobId = stale!.id;

  // Job FRESCO: executando há <5min — NÃO deve ser reclamado.
  const { data: fresh } = await sb
    .from("siso_fila_execucao")
    .insert({
      pedido_id: PEDIDO_ID,
      empresa_id: empresaId,
      tipo: "lancar_estoque",
      decisao: "propria",
      status: "executando",
      tentativas: 0,
      atualizado_em: agora,
    })
    .select("id")
    .single();
  freshJobId = fresh!.id;
});

afterAll(async () => {
  await sb.from("siso_fila_execucao").delete().in("id", [staleJobId, freshJobId]);
  await sb.from("siso_pedidos").delete().eq("id", PEDIDO_ID);
});

describe("processQueue — reclaim de jobs estagnados", () => {
  it("job 'executando' há >5min volta a ser processável (sai de executando)", async () => {
    await processQueue(20);
    const { data: job } = await sb
      .from("siso_fila_execucao")
      .select("status")
      .eq("id", staleJobId)
      .single();
    // Foi reclamado → ou re-selecionado e pulado (pedido cancelado → 'cancelado'),
    // ou voltou a 'pendente'. O essencial: NÃO segue preso em 'executando'.
    expect(job?.status).not.toBe("executando");
  });

  it("job 'executando' há <5min NÃO é reclamado (segue executando)", async () => {
    await processQueue(20);
    const { data: job } = await sb
      .from("siso_fila_execucao")
      .select("status")
      .eq("id", freshJobId)
      .single();
    expect(job?.status).toBe("executando");
  });
});
