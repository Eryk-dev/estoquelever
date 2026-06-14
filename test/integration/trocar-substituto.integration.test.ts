import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { inserirMovimentacao } from "../../src/lib/wms/ledger";

// Atomicidade de wms_trocar_substituto_atomico (Feature A — trocar substituto
// no modal): libera as R reserva_troca do substituto ANTIGO e cria as do NOVO
// numa única tx. Prova: sem R órfã (reservado do antigo volta a 0; do novo = qty)
// + troca atualizada. Bate no staging real (harness trunca operacional 1x/run).

const sb = createServiceClient();

const PEDIDO_ID = "730000901";
const SKU_VENDIDO = "TSUB-VEND-901";
const SKU_ANTIGO = "TSUB-ANT-901";
const SKU_NOVO = "TSUB-NOV-901";
const LOC_COD = "TSUB-PICK-901";

let galpaoId: string;
let locId: string;
let pVendido: string;
let pAntigo: string;
let pNovo: string;
let pedidoItemId: number;
let trocaId: string;

async function criarProduto(sku: string): Promise<string> {
  const { data } = await sb
    .from("siso_produtos")
    .upsert({ sku, descricao: sku, ativo: true }, { onConflict: "sku" })
    .select("id")
    .single();
  return data!.id as string;
}

beforeAll(async () => {
  // Galpão + loc picking próprios (independentes do seed do harness).
  const { data: g } = await sb
    .from("siso_galpoes")
    .select("id")
    .eq("ativo", true)
    .limit(1)
    .single();
  galpaoId = g!.id as string;

  const { data: loc } = await sb
    .from("siso_localizacoes")
    .upsert(
      { galpao_id: galpaoId, codigo: LOC_COD, tipo: "picking" },
      { onConflict: "galpao_id,codigo" },
    )
    .select("id")
    .single();
  locId = loc!.id as string;

  pVendido = await criarProduto(SKU_VENDIDO);
  pAntigo = await criarProduto(SKU_ANTIGO);
  pNovo = await criarProduto(SKU_NOVO);

  // Limpa execuções anteriores deste arquivo (ordem-independente).
  await sb.from("siso_trocas_equivalencia").delete().eq("pedido_id", PEDIDO_ID);
  await sb.from("siso_pedido_itens").delete().eq("pedido_id", PEDIDO_ID);
  await sb.from("siso_pedidos").delete().eq("id", PEDIDO_ID);

  // Pedido + item (FKs da troca).
  await sb.from("siso_pedidos").insert({
    id: PEDIDO_ID,
    status: "pendente",
    numero: PEDIDO_ID,
    data: "2026-06-14",
    filial_origem: "CWB",
    cliente_nome: "Teste trocar-substituto",
  });
  const { data: item } = await sb
    .from("siso_pedido_itens")
    .insert({
      pedido_id: PEDIDO_ID,
      produto_id: 73000901,
      sku: SKU_VENDIDO,
      quantidade_pedida: 3,
    })
    .select("id")
    .single();
  pedidoItemId = item!.id as number;

  // Saldo dos 2 substitutos (E) — 10 cada na mesma loc.
  for (const pid of [pAntigo, pNovo]) {
    await inserirMovimentacao({
      tripla: { produto_id: pid, galpao_id: galpaoId, localizacao_id: locId },
      tipo: "E",
      qty: 10,
      origem_tipo: "inventario_inicial",
      origem_id: PEDIDO_ID,
      motivo: "seed trocar-substituto",
    });
  }

  // Troca pendente com R reserva_troca no substituto ANTIGO (qty 3).
  const { data: troca } = await sb
    .from("siso_trocas_equivalencia")
    .insert({
      pedido_id: PEDIDO_ID,
      pedido_item_id: pedidoItemId,
      galpao_id: galpaoId,
      produto_vendido_id: pVendido,
      produto_substituto_id: pAntigo,
      sku_vendido: SKU_VENDIDO,
      sku_substituto: SKU_ANTIGO,
      quantidade: 3,
      tipo: "mesmo_nivel",
      origem_solicitacao: "painel",
      status: "pendente",
    })
    .select("id")
    .single();
  trocaId = troca!.id as string;

  const rMov = await inserirMovimentacao({
    tripla: { produto_id: pAntigo, galpao_id: galpaoId, localizacao_id: locId },
    tipo: "R",
    qty: 3,
    origem_tipo: "reserva_troca",
    origem_id: trocaId,
    pedido_id: PEDIDO_ID,
    expira_em: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    motivo: "seed reserva_troca",
  });
  await sb
    .from("siso_trocas_equivalencia")
    .update({ reserva_mov_ids: [rMov.id] })
    .eq("id", trocaId);
});

afterAll(async () => {
  await sb.from("siso_trocas_equivalencia").delete().eq("pedido_id", PEDIDO_ID);
  await sb.from("siso_pedido_itens").delete().eq("pedido_id", PEDIDO_ID);
  await sb.from("siso_pedidos").delete().eq("id", PEDIDO_ID);
});

async function reservadoDe(produtoId: string): Promise<number> {
  const { data } = await sb
    .from("siso_estoque")
    .select("reservado")
    .eq("produto_id", produtoId)
    .eq("galpao_id", galpaoId)
    .eq("localizacao_id", locId)
    .maybeSingle();
  return Number((data as { reservado?: number } | null)?.reservado ?? 0);
}

describe("wms_trocar_substituto_atomico", () => {
  it("move a R reserva_troca do substituto antigo pro novo (atômico)", async () => {
    // Antes: antigo reservado=3, novo reservado=0.
    expect(await reservadoDe(pAntigo)).toBe(3);
    expect(await reservadoDe(pNovo)).toBe(0);

    const { error } = await sb.rpc("wms_trocar_substituto_atomico", {
      p_troca_id: trocaId,
      p_usuario_id: null,
      p_novo_produto_id: pNovo,
      p_novo_sku: SKU_NOVO,
      p_novo_tipo: "mesmo_nivel",
      p_novo_tier: null,
      p_reservas: [{ localizacao_id: locId, qty: 3 }],
    });
    expect(error).toBeNull();

    // Depois: antigo liberado (0), novo reservado (3) — sem R órfã (I4/I2).
    expect(await reservadoDe(pAntigo)).toBe(0);
    expect(await reservadoDe(pNovo)).toBe(3);

    // Troca aponta o novo substituto, segue pendente, R nova viva.
    const { data: t } = await sb
      .from("siso_trocas_equivalencia")
      .select("status, sku_substituto, produto_substituto_id, reserva_mov_ids")
      .eq("id", trocaId)
      .single();
    const troca = t as {
      status: string;
      sku_substituto: string;
      produto_substituto_id: string;
      reserva_mov_ids: string[];
    };
    expect(troca.status).toBe("pendente");
    expect(troca.sku_substituto).toBe(SKU_NOVO);
    expect(troca.produto_substituto_id).toBe(pNovo);
    expect(troca.reserva_mov_ids.length).toBe(1);

    // A R nova referenciada está VIVA (sem L apontando).
    const { data: ls } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("tipo", "L")
      .eq("estorno_de", troca.reserva_mov_ids[0]);
    expect((ls ?? []).length).toBe(0);
  });

  it("troca já decidida → erro TROCA_NAO_PENDENTE (idempotência de estado)", async () => {
    await sb
      .from("siso_trocas_equivalencia")
      .update({ status: "aprovada" })
      .eq("id", trocaId);
    const { error } = await sb.rpc("wms_trocar_substituto_atomico", {
      p_troca_id: trocaId,
      p_usuario_id: null,
      p_novo_produto_id: pAntigo,
      p_novo_sku: SKU_ANTIGO,
      p_novo_tipo: "mesmo_nivel",
      p_novo_tier: null,
      p_reservas: [{ localizacao_id: locId, qty: 3 }],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("TROCA_NAO_PENDENTE");
  });
});
