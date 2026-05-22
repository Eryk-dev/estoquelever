import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();
const SKU = `TEST-INT-RES-${Math.random().toString(36).slice(2, 8)}`;
let produtoId: string, galpaoId: string, locId: string;
let serverUp = false;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: l } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoId)
    .eq("codigo", "A-01-02")
    .single();
  locId = l!.id;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: SKU, descricao: "Reservas test", ativo: true })
    .select("id")
    .single();
  produtoId = p!.id;
  // semeia saldo 10
  await sb.rpc("wms_inserir_movimentacao", {
    p_produto_id: produtoId,
    p_galpao_id: galpaoId,
    p_localizacao_id: locId,
    p_tipo: "E",
    p_quantidade: 10,
    p_origem_tipo: "inventario_inicial",
    p_origem_id: null,
    p_custo_unitario: null,
    p_motivo: "seed",
  });

  // Detecta se o dev server está up (cleanup endpoint depende dele).
  const baseUrl = process.env.TEST_RUNNER_BASE_URL ?? "http://localhost:3001";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1_500);
    const res = await fetch(`${baseUrl}/api/wms/reservas/cleanup`, {
      headers: { "x-worker-secret": "probe" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    // 403 (sem secret) ou 200 com secret → server respondeu.
    serverUp = res.status === 403 || res.ok;
  } catch {
    serverUp = false;
  }
});

describe("wms_reservar_atomico", () => {
  it("reservar dentro do saldo retorna mov_id", async () => {
    const { data, error } = await sb.rpc("wms_reservar_atomico", {
      p_produto_id: produtoId,
      p_galpao_id: galpaoId,
      p_localizacao_id: locId,
      p_quantidade: 3,
      p_ttl_horas: 1,
      p_pedido_id: null,
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
    const { data: est } = await sb
      .from("siso_estoque")
      .select("saldo, reservado, disponivel")
      .eq("produto_id", produtoId)
      .single();
    expect(Number(est?.reservado)).toBe(3);
    expect(Number(est?.disponivel)).toBe(Number(est!.saldo) - Number(est!.reservado));
  });

  it("reservar acima do disponível falha", async () => {
    const { error } = await sb.rpc("wms_reservar_atomico", {
      p_produto_id: produtoId,
      p_galpao_id: galpaoId,
      p_localizacao_id: locId,
      p_quantidade: 99,
      p_ttl_horas: 1,
      p_pedido_id: null,
    });
    expect(error).not.toBeNull();
  });

  it("cleanup endpoint libera reservas expiradas", async () => {
    if (!serverUp) {
      console.warn("[reservas-rpc] dev server em :3001 não detectado — pulando teste de cleanup");
      return;
    }
    // cria reserva com TTL real ínfimo
    await sb.rpc("wms_reservar_atomico", {
      p_produto_id: produtoId,
      p_galpao_id: galpaoId,
      p_localizacao_id: locId,
      p_quantidade: 1,
      p_ttl_horas: 1 / 3600,
      p_pedido_id: null, // ~1s
    });
    await new Promise((r) => setTimeout(r, 2_000));

    const url = `${process.env.TEST_RUNNER_BASE_URL}/api/wms/reservas/cleanup`;
    const res = await fetch(url, {
      headers: { "x-worker-secret": process.env.WORKER_SECRET ?? "test-worker-secret" },
    });
    expect(res.ok).toBe(true);

    const { data: movsL } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("produto_id", produtoId)
      .eq("tipo", "L");
    expect((movsL ?? []).length).toBeGreaterThan(0);
  });
});
