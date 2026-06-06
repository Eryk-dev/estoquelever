import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { receberItensViaOC } from "../../src/lib/wms/receber-oc";

const sb = createServiceClient();
let galpaoId: string, usuarioId: string, ocId: string, item1: string, item2: string, prod1: string;
const RND = Math.random().toString(36).slice(2, 7);
// tiny_produto_id é coluna numérica (buscarProdutoId faz Number(...)). Item1
// mapeado; item2 usa um tiny id numérico SEM mapeamento → resolverProdutoWms throw.
const tinyP1 = Number(`${Date.now()}`.slice(-9)) + 1;
const tinyNaoMapeado = tinyP1 + 7;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: emp } = await sb.from("siso_empresas").select("id").limit(1).single();
  const { data: p1 } = await sb
    .from("siso_produtos")
    .insert({ sku: `RECOC-1-${RND}`, descricao: "rec1", ativo: true })
    .select("id")
    .single();
  prod1 = p1!.id;
  await sb.from("siso_produto_empresas").insert({ produto_id: prod1, empresa_id: emp!.id, tiny_produto_id: tinyP1 });
  const { data: oc } = await sb
    .from("siso_ordens_compra")
    .insert({ galpao_id: galpaoId, empresa_id: emp!.id, status: "comprado", fornecedor: `Forn X ${RND}` })
    .select("id")
    .single();
  ocId = oc!.id;
  // FK siso_pedido_itens_pedido_id_fkey → siso_pedidos: criar os pedidos antes.
  // siso_pedidos: numero/data/filial_origem/cliente_nome são NOT NULL (legado).
  await sb.from("siso_pedidos").insert([
    { id: `MAN-${RND}-1`, numero: `MAN-${RND}-1`, data: new Date().toISOString(), filial_origem: "CWB", cliente_nome: "Receber OC AON 1", status: "executando" },
    { id: `MAN-${RND}-2`, numero: `MAN-${RND}-2`, data: new Date().toISOString(), filial_origem: "CWB", cliente_nome: "Receber OC AON 2", status: "executando" },
  ]);
  const { data: i1 } = await sb
    .from("siso_pedido_itens")
    .insert({
      pedido_id: `MAN-${RND}-1`,
      sku: `RECOC-1-${RND}`,
      descricao: "rec1",
      produto_id: tinyP1,
      ordem_compra_id: ocId,
      compra_quantidade_solicitada: 5,
      compra_quantidade_recebida: 0,
    })
    .select("id")
    .single();
  const { data: i2 } = await sb
    .from("siso_pedido_itens")
    .insert({
      pedido_id: `MAN-${RND}-2`,
      sku: `RECOC-2-${RND}`,
      descricao: "rec2",
      produto_id: tinyNaoMapeado,
      ordem_compra_id: ocId,
      compra_quantidade_solicitada: 3,
      compra_quantidade_recebida: 0,
    })
    .select("id")
    .single();
  item1 = i1!.id;
  item2 = i2!.id;
});

describe("receberItensViaOC — all-or-nothing [P028]", () => {
  it("item2 com produto sem mapeamento: NENHUM saldo do lote persiste e a chamada lança", async () => {
    await expect(
      receberItensViaOC({
        ocId,
        operadorId: usuarioId,
        operadorNome: "test-runner",
        itens: [
          { item_id: item1, qty_real: 5, custo_unitario: 10 },
          { item_id: item2, qty_real: 3, custo_unitario: 10 },
        ],
      }),
    ).rejects.toThrow();
    const { data: est } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prod1).maybeSingle();
    expect(Number((est as { saldo?: number } | null)?.saldo ?? 0)).toBe(0);
    const { data: it1 } = await sb
      .from("siso_pedido_itens")
      .select("compra_quantidade_recebida")
      .eq("id", item1)
      .single();
    expect(Number((it1 as { compra_quantidade_recebida: number }).compra_quantidade_recebida)).toBe(0);
  });
});
