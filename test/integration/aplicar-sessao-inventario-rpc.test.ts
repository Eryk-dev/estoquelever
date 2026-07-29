import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { aplicarSessao } from "../../src/lib/wms/inventario";

const sb = createServiceClient();
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let galpaoId: string;
let locId: string;
let userId: string;
const produtoIds: string[] = [];
const sessaoIds: string[] = [];

async function criarProduto(sufixo: string): Promise<string> {
  const { data, error } = await sb
    .from("siso_produtos")
    .insert({
      sku: `TEST-INV-APL-${sufixo}-${runId}`,
      descricao: `fixture inventário ${sufixo}`,
      ativo: true,
    })
    .select("id")
    .single();
  if (error) throw error;
  const id = data!.id as string;
  produtoIds.push(id);
  return id;
}

async function movimentar(
  produtoId: string,
  tipo: "E" | "S",
  quantidade: number,
): Promise<void> {
  const { error } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId,
    p_galpao_id: galpaoId,
    p_localizacao_id: locId,
    p_tipo: tipo,
    p_quantidade: quantidade,
    p_origem_tipo: "ajuste_manual",
    p_origem_detalhes: { fixture: runId },
    p_usuario_id: userId,
    p_motivo: "fixture isolada de inventário",
    p_custo_unitario: tipo === "E" ? 1 : undefined,
  });
  if (error) throw error;
}

async function criarSessaoComDivergencia(input: {
  produtoId: string;
  saldoSnapshot: number;
  qtyContada: number;
}): Promise<{ sessaoId: string; divergenciaId: string }> {
  const { data: sessao, error: sessaoError } = await sb
    .from("siso_inventario_sessoes")
    .insert({
      galpao_id: galpaoId,
      tipo: "cycle_count",
      modo_contagem: "blind",
      status: "aprovada",
      tamanho_pool: 1,
      criada_por: userId,
      aprovada_por: userId,
      nome: `TEST aplicar saldo live ${runId}`,
    })
    .select("id")
    .single();
  if (sessaoError) throw sessaoError;
  const sessaoId = sessao!.id as string;
  sessaoIds.push(sessaoId);

  const { data: divergencia, error: divergenciaError } = await sb
    .from("siso_inventario_divergencias")
    .insert({
      sessao_id: sessaoId,
      produto_id: input.produtoId,
      localizacao_id: locId,
      saldo_sistema: input.saldoSnapshot,
      qty_contada_final: input.qtyContada,
      status: "aprovada",
      resolucao_por: userId,
      resolucao_em: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (divergenciaError) throw divergenciaError;

  return {
    sessaoId,
    divergenciaId: divergencia!.id as string,
  };
}

beforeAll(async () => {
  const { data: galpao, error: galpaoError } = await sb
    .from("siso_galpoes")
    .select("id")
    .eq("nome", "CWB")
    .single();
  if (galpaoError) throw galpaoError;
  galpaoId = galpao!.id as string;

  const { data: usuario, error: usuarioError } = await sb
    .from("siso_usuarios")
    .select("id")
    .eq("nome", "test-runner")
    .single();
  if (usuarioError) throw usuarioError;
  userId = usuario!.id as string;

  const { data: loc, error: locError } = await sb
    .from("siso_localizacoes")
    .insert({
      galpao_id: galpaoId,
      codigo: `TEST-INV-APL-${runId}`,
      descricao: "fixture isolada aplicar inventário",
      tipo: "picking",
      ativo: true,
    })
    .select("id")
    .single();
  if (locError) throw locError;
  locId = loc!.id as string;
});

afterAll(async () => {
  if (sessaoIds.length > 0) {
    await sb.from("siso_inventario_sessoes").delete().in("id", sessaoIds);
  }
  if (produtoIds.length > 0) {
    await sb.from("siso_custo_medio").delete().in("produto_id", produtoIds);
    await sb.from("siso_movimentacoes").delete().in("produto_id", produtoIds);
    await sb.from("siso_estoque").delete().in("produto_id", produtoIds);
    await sb.from("siso_produtos").delete().in("id", produtoIds);
  }
  if (locId) {
    await sb.from("siso_localizacoes").delete().eq("id", locId);
  }
});

describe("wms_aplicar_sessao_inventario — inventário como balanço físico", () => {
  it("não repete a perda do snapshot quando o saldo vivo já é igual à contagem", async () => {
    const produtoId = await criarProduto("NOOP");
    await movimentar(produtoId, "E", 1);
    const { sessaoId, divergenciaId } = await criarSessaoComDivergencia({
      produtoId,
      saldoSnapshot: 1,
      qtyContada: 0,
    });

    // Movimento posterior ao snapshot já levou 1 → 0. O bug tentava aplicar
    // novamente o delta snapshot -1 e abortava com "perda maior que saldo".
    await movimentar(produtoId, "S", 1);

    const { data, error } = await sb.rpc("wms_aplicar_sessao_inventario", {
      p_sessao: sessaoId,
      p_usuario: userId,
    });

    expect(error).toBeNull();
    expect((data as { movs_geradas: number }).movs_geradas).toBe(0);
    expect(
      (data as { divergencias_sem_movimento: number })
        .divergencias_sem_movimento,
    ).toBe(1);

    const { data: estoque } = await sb
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locId)
      .single();
    expect(Number(estoque!.saldo)).toBe(0);

    const { data: divergencia } = await sb
      .from("siso_inventario_divergencias")
      .select("status, mov_aplicada_id")
      .eq("id", divergenciaId)
      .single();
    expect(divergencia).toMatchObject({
      status: "aplicada",
      mov_aplicada_id: null,
    });
  });

  it("reconcilia do saldo vivo até a quantidade contada e preserva o snapshot na auditoria", async () => {
    const produtoId = await criarProduto("LIVE");
    await movimentar(produtoId, "E", 2);
    const { sessaoId, divergenciaId } = await criarSessaoComDivergencia({
      produtoId,
      saldoSnapshot: 10,
      qtyContada: 4,
    });

    const primeira = await sb.rpc("wms_aplicar_sessao_inventario", {
      p_sessao: sessaoId,
      p_usuario: userId,
    });
    expect(primeira.error).toBeNull();
    expect((primeira.data as { movs_geradas: number }).movs_geradas).toBe(1);

    const { data: estoque } = await sb
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locId)
      .single();
    expect(Number(estoque!.saldo)).toBe(4);

    const { data: movs } = await sb
      .from("siso_movimentacoes")
      .select("tipo, quantidade, origem_detalhes")
      .eq("origem_id", sessaoId)
      .eq("origem_tipo", "inventario_ganho");
    expect(movs).toHaveLength(1);
    expect(movs![0]).toMatchObject({ tipo: "E", quantidade: 2 });
    expect(movs![0].origem_detalhes).toMatchObject({
      divergencia_id: divergenciaId,
      saldo_snapshot: 10,
      delta_snapshot: -6,
      qty_contada: 4,
      saldo_aplicacao: 2,
      delta_aplicado: 2,
    });

    const segunda = await sb.rpc("wms_aplicar_sessao_inventario", {
      p_sessao: sessaoId,
      p_usuario: userId,
    });
    expect(segunda.error).toBeNull();
    expect((segunda.data as { idempotente: boolean }).idempotente).toBe(true);
    const { count } = await sb
      .from("siso_movimentacoes")
      .select("id", { count: "exact", head: true })
      .eq("origem_id", sessaoId)
      .in("origem_tipo", ["inventario_ganho", "inventario_perda"]);
    expect(count).toBe(1);
  });

  it("o wrapper TS usa a mesma reconciliação live", async () => {
    const produtoId = await criarProduto("WRAPPER");
    await movimentar(produtoId, "E", 3);
    const { sessaoId } = await criarSessaoComDivergencia({
      produtoId,
      saldoSnapshot: 0,
      qtyContada: 5,
    });

    await expect(aplicarSessao(sessaoId, userId)).resolves.toEqual({
      movsGeradas: 1,
    });
    const { data: estoque } = await sb
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locId)
      .single();
    expect(Number(estoque!.saldo)).toBe(5);
  });

  it("estorno reabre também divergência aplicada sem movimentação", async () => {
    const produtoId = await criarProduto("ESTORNO-NOOP");
    const { sessaoId, divergenciaId } = await criarSessaoComDivergencia({
      produtoId,
      saldoSnapshot: 1,
      qtyContada: 0,
    });

    const aplicada = await sb.rpc("wms_aplicar_sessao_inventario", {
      p_sessao: sessaoId,
      p_usuario: userId,
    });
    expect(aplicada.error).toBeNull();

    const estornada = await sb.rpc("wms_estornar_sessao_inventario", {
      p_sessao: sessaoId,
      p_usuario: userId,
      p_motivo: "teste de reabertura sem movimento",
    });
    expect(estornada.error).toBeNull();
    expect(
      (estornada.data as {
        divergencias_sem_movimento_resetadas: number;
      }).divergencias_sem_movimento_resetadas,
    ).toBe(1);

    const { data: divergencia } = await sb
      .from("siso_inventario_divergencias")
      .select("status, mov_aplicada_id")
      .eq("id", divergenciaId)
      .single();
    expect(divergencia).toMatchObject({
      status: "pendente",
      mov_aplicada_id: null,
    });
  });
});
