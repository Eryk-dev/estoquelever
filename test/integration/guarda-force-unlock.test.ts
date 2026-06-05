import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { iniciarGuarda } from "../../src/lib/wms/guarda";

const sb = createServiceClient();
let galpaoId: string, produtoId: string, locId: string, movId: string, op1: string, op2: string;

async function novaPendenciaEmGuarda(): Promise<string> {
  // Coluna é qty_inicial (não qty_total); qty_pendente é GENERATED = qty_inicial - qty_guardada.
  // mov_entrada_id (FK NOT NULL) e origem_tipo (NOT NULL) são exigidos pelo schema vivo —
  // reaproveitamos a movimentação E criada no beforeAll.
  const { data: pend, error } = await sb
    .from("siso_wms_pendencias_guarda")
    .insert({
      produto_id: produtoId,
      galpao_id: galpaoId,
      localizacao_origem_id: locId,
      mov_entrada_id: movId,
      origem_tipo: "nf_compra",
      qty_inicial: 5,
      qty_guardada: 2,
      status: "em_guarda",
      iniciada_por: op1,
      iniciada_em: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return pend!.id;
}

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes").select("id").eq("galpao_id", galpaoId).limit(1).single();
  locId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: `TEST-GD-FORCE-${Math.random().toString(36).slice(2, 8)}`, descricao: "force test", ativo: true })
    .select("id").single();
  produtoId = p!.id;
  // Movimentação E real pra satisfazer o FK mov_entrada_id.
  const { data: mov, error: movErr } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId,
    p_galpao_id: galpaoId,
    p_localizacao_id: locId,
    p_tipo: "E",
    p_quantidade: 5,
    p_origem_tipo: "inventario_inicial",
    p_origem_id: null,
    p_custo_unitario: 1,
    p_motivo: "force-unlock test",
  });
  if (movErr) throw movErr;
  movId = mov as unknown as string;
  const { data: us } = await sb.from("siso_usuarios").select("id").limit(2);
  op1 = us![0].id;
  op2 = us![1]?.id ?? us![0].id;
});

describe("iniciarGuarda forcar (Tomar de Fulano)", () => {
  it("op2 SEM forcar continua tomando 409", async () => {
    const pid = await novaPendenciaEmGuarda();
    await expect(
      iniciarGuarda({ pendencia_id: pid, usuario_id: op2 }),
    ).rejects.toMatchObject({ code: "PENDENCIA_OUTRA_GUARDA" });
  });

  it("op2 COM forcar:true assume a pendência preservando qty_pendente", async () => {
    const pid = await novaPendenciaEmGuarda();
    const pend = await iniciarGuarda({ pendencia_id: pid, usuario_id: op2, forcar: true });
    expect(pend.iniciada_por).toBe(op2);
    // qty_inicial=5, qty_guardada=2 → qty_pendente GENERATED = 3, preservado.
    expect(Number(pend.qty_pendente)).toBe(3);
  });
});
