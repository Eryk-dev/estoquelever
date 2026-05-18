// Smoke tests pras RPCs do fix-pack de realocação cascateável (Tasks 1.2 e 1.3).
// Diferente dos outros testes em src/lib/wms/ (puros), este bate em staging
// (Supabase project ehbxpbeijofxtsbezwxd) — não há como testar RPCs sem o DB real.
//
// UUIDs literais abaixo são de staging (validados via `mcp__supabase__execute_sql`).
// Se a base for trocada, esses ids precisam ser refrescados.

import "dotenv/config";
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { createServiceClient } from "@/lib/supabase-server";

// ─── Safety guard: refuse to run outside staging ────────────────────────
// Este suite muta o DB real (insere siso_pedido_itens + siso_movimentacoes
// de 10 unidades contra produto real). Se NEXT_PUBLIC_SUPABASE_URL não
// apontar pro projeto staging, abortamos antes de tocar em qualquer linha.
const STAGING_PROJECT_REF = "ehbxpbeijofxtsbezwxd";
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes(STAGING_PROJECT_REF)) {
  throw new Error(
    `realoc-fix-pack.test.ts: refusing to run outside staging (${STAGING_PROJECT_REF}). ` +
      `Got URL: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`,
  );
}

const sb = createServiceClient();

// ─── Seed UUIDs (staging-specific) ──────────────────────────────────────
const STAGING = {
  produto_uuid: "161ac7ea-efb6-4e55-951d-1093630981e5", // siso_produtos.id (uuid)
  empresa_uuid: "4473ca97-67e7-44e5-a192-ec756146b691", // NetAir
  galpao_uuid: "14e22fe9-8dae-4950-b1e8-f38cffa60646", // CWB
  loc_uuid: "5b2e833f-34e0-448c-9905-7af3bcc7480a", // CWB / DEFAULT-PICKING
  pedido_id: "91000005", // text PK de siso_pedidos
  usuario_uuid: "d1330e92-699d-4530-a079-6103bb0435bf",
};

// Sentinel pra cleanup defensivo entre runs
const TEST_TAG = `TEST-FIX-PACK-${Date.now()}`;
const TEST_PRODUTO_ID_BIGINT = 999_000_000_000 + Math.floor(Date.now() / 1000) % 999_999_999;

describe("wms_acumular_qty_pega", () => {
  let itemId: number;

  beforeEach(async () => {
    const { data, error } = await sb
      .from("siso_pedido_itens")
      .insert({
        pedido_id: STAGING.pedido_id,
        produto_id: TEST_PRODUTO_ID_BIGINT,
        sku: TEST_TAG,
        descricao: "smoke test fixture",
        quantidade_pedida: 10,
        quantidade_pega: null,
      })
      .select("id")
      .single();
    if (error) throw error;
    itemId = data!.id as number;
  });

  afterEach(async () => {
    if (itemId) {
      await sb.from("siso_pedido_itens").delete().eq("id", itemId);
    }
  });

  it("primeira chamada (null) + delta=3 → quantidade_pega=3", async () => {
    const { data, error } = await sb.rpc("wms_acumular_qty_pega", {
      p_item_id: itemId,
      p_delta: 3,
    });
    expect(error).toBeNull();
    expect(data).toBe(3);
  });

  it("acumula em chamadas sucessivas (2 + 1 = 3)", async () => {
    const { error: e1 } = await sb.rpc("wms_acumular_qty_pega", {
      p_item_id: itemId,
      p_delta: 2,
    });
    expect(e1).toBeNull();

    const { data, error: e2 } = await sb.rpc("wms_acumular_qty_pega", {
      p_item_id: itemId,
      p_delta: 1,
    });
    expect(e2).toBeNull();
    expect(data).toBe(3);
  });

  it("delta negativo abaixo de zero → erro 'negativa'", async () => {
    const { error } = await sb.rpc("wms_acumular_qty_pega", {
      p_item_id: itemId,
      p_delta: -5,
    });
    expect(error?.message).toMatch(/negativa/);
  });
});

describe("wms_estornar_parcial_movimentacao", () => {
  let movId: string;
  // Origem_id único por execução pra dedup/limpeza defensiva
  const movTag = `${TEST_TAG}-MOV`;

  beforeEach(async () => {
    // Cria mov de entrada de 10 unidades via RPC oficial
    const { data, error } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto: STAGING.produto_uuid,
      p_dona: STAGING.empresa_uuid,
      p_galpao: STAGING.galpao_uuid,
      p_localizacao: STAGING.loc_uuid,
      p_tipo: "E",
      p_qty: 10,
      p_origem_tipo: "ajuste_manual",
      p_origem_id: movTag,
      p_origem_detalhes: { test: true, tag: TEST_TAG },
      p_emprestimo_devedora: null,
      p_expira_em: null,
      p_nota_fiscal_id: null,
      p_custo_unitario: null,
      p_usuario: STAGING.usuario_uuid,
      p_observacoes: `fixture ${TEST_TAG}`,
      p_estorno_de: null,
    });
    if (error) throw error;
    // RPC retorna a row de siso_movimentacoes
    movId = (data as { id: string }).id;
  });

  afterEach(async () => {
    // Cleanup: prefere paper-trail (estorno) ao invés de delete bruto, pra não
    // bagunçar o cache de siso_estoque. Se o teste falhou no meio, ainda assim
    // tentamos zerar o saldo via estorno do restante.
    if (!movId) return;

    // 1) Quanto sobra pra estornar?
    const { data: src } = await sb
      .from("siso_movimentacoes")
      .select("quantidade, qty_estornada")
      .eq("id", movId)
      .single();

    if (src) {
      const restante = Number(src.quantidade) - Number(src.qty_estornada);
      if (restante > 0) {
        // Estorno o saldo remanescente — mantém cache coerente
        await sb.rpc("wms_estornar_parcial_movimentacao", {
          p_mov_id: movId,
          p_qty: restante,
          p_usuario_id: STAGING.usuario_uuid,
          p_observacoes: `cleanup ${TEST_TAG}`,
        });
      }
    }
  });

  it("estorno parcial qty=1 atualiza qty_estornada na mov origem", async () => {
    const { data, error } = await sb.rpc(
      "wms_estornar_parcial_movimentacao",
      {
        p_mov_id: movId,
        p_qty: 1,
        p_usuario_id: STAGING.usuario_uuid,
        p_observacoes: `smoke test ${TEST_TAG}`,
      },
    );
    expect(error).toBeNull();
    expect(data).toBeTruthy();
    const estorno = data as { id: string; tipo: string; quantidade: number };
    expect(estorno.tipo).toBe("S"); // inverso de "E"
    expect(Number(estorno.quantidade)).toBe(1);

    // Verifica qty_estornada da mov source
    const { data: src, error: errSrc } = await sb
      .from("siso_movimentacoes")
      .select("qty_estornada")
      .eq("id", movId)
      .single();
    expect(errSrc).toBeNull();
    expect(Number(src!.qty_estornada)).toBe(1);
  });

  it("estorno excede saldo (qty=999 vs total=10) → erro 'excede saldo'", async () => {
    const { error } = await sb.rpc(
      "wms_estornar_parcial_movimentacao",
      {
        p_mov_id: movId,
        p_qty: 999,
        p_usuario_id: STAGING.usuario_uuid,
        p_observacoes: "should fail",
      },
    );
    expect(error?.message).toMatch(/excede saldo/);
  });
});

// Limpeza defensiva caso runs anteriores tenham deixado lixo identificado pelo
// padrão TEST-FIX-PACK-* — roda 1x no fim, idempotente.
afterAll(async () => {
  await sb.from("siso_pedido_itens").delete().like("sku", "TEST-FIX-PACK-%");
});
