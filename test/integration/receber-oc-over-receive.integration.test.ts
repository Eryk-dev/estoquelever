import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { receberItensViaOC } from "../../src/lib/wms/receber-oc";

const sb = createServiceClient();
let galpaoId: string, usuarioId: string, ocId: string, itemId: string, prodId: string;
const RND = Math.random().toString(36).slice(2, 7);
// tiny_produto_id é coluna numérica (buscarProdutoId faz Number(...)).
const tinyP = Number(`${Date.now()}`.slice(-9)) + 1;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: emp } = await sb.from("siso_empresas").select("id").limit(1).single();
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: `OVREC-${RND}`, descricao: "over receive", ativo: true })
    .select("id")
    .single();
  prodId = p!.id;
  await sb.from("siso_produto_empresas").insert({ produto_id: prodId, empresa_id: emp!.id, tiny_produto_id: tinyP });
  const { data: oc } = await sb
    .from("siso_ordens_compra")
    .insert({ galpao_id: galpaoId, empresa_id: emp!.id, status: "comprado", fornecedor: `Forn Over ${RND}` })
    .select("id")
    .single();
  ocId = oc!.id;
  // FK siso_pedido_itens_pedido_id_fkey → siso_pedidos: criar o pedido antes.
  // siso_pedidos: numero/data/filial_origem/cliente_nome são NOT NULL (legado).
  await sb.from("siso_pedidos").insert({
    id: `MAN-OVER-${RND}`,
    numero: `MAN-OVER-${RND}`,
    data: new Date().toISOString(),
    filial_origem: "CWB",
    cliente_nome: "Receber OC Over",
    status: "executando",
  });
  const { data: it } = await sb
    .from("siso_pedido_itens")
    .insert({
      pedido_id: `MAN-OVER-${RND}`,
      sku: `OVREC-${RND}`,
      descricao: "over receive",
      produto_id: tinyP,
      ordem_compra_id: ocId,
      compra_quantidade_solicitada: 10,
      compra_quantidade_recebida: 0,
    })
    .select("id")
    .single();
  itemId = it!.id;
});

describe("receberItensViaOC — over-receive split [P033]", () => {
  it("solicitado 10, qty_real 12: 1 mov nf_compra qty 10 + 1 mov ajuste_manual achado qty 2; saldo 12", async () => {
    await receberItensViaOC({
      ocId,
      operadorId: usuarioId,
      operadorNome: "test-runner",
      itens: [{ item_id: itemId, qty_real: 12, custo_unitario: 7 }],
    });
    const { data: movs } = await sb
      .from("siso_movimentacoes")
      .select("origem_tipo, quantidade, motivo_categoria")
      .eq("produto_id", prodId)
      .eq("tipo", "E");
    const nf = (movs ?? []).filter((m) => (m as { origem_tipo: string }).origem_tipo === "nf_compra");
    const achado = (movs ?? []).filter((m) => (m as { origem_tipo: string }).origem_tipo === "ajuste_manual");
    expect(nf.length).toBe(1);
    expect(Number((nf[0] as { quantidade: number }).quantidade)).toBe(10);
    expect(achado.length).toBe(1);
    expect(Number((achado[0] as { quantidade: number }).quantidade)).toBe(2);
    expect((achado[0] as { motivo_categoria: string | null }).motivo_categoria).toBe("achado");
    const { data: est } = await sb.from("siso_estoque").select("saldo").eq("produto_id", prodId).single();
    expect(Number(est?.saldo)).toBe(12);
  });
});
