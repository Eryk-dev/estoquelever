import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import {
  criarCompraManual,
  receberCompraManual,
} from "../../src/lib/wms/compras-manuais";

const sb = createServiceClient();
const RND = Math.random().toString(36).slice(2, 7);
let galpaoId: string, usuarioId: string, empresaId: string, fornecedorId: string, produtoId: string;

beforeAll(async () => {
  const { data: g } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoId = g!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  usuarioId = u!.id;
  const { data: emp } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = emp!.id;
  const { data: forn } = await sb
    .from("siso_fornecedores")
    .insert({ nome: `Forn Manual ${RND}` })
    .select("id")
    .single();
  fornecedorId = forn!.id;
  // produto novo COM custo informado depois no recebimento (evita guard P108).
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku: `CM-${RND}`, descricao: "compra manual test", ativo: true })
    .select("id")
    .single();
  produtoId = p!.id;
});

describe("compra manual — lifecycle", () => {
  it("criar → receber parcial → receber resto → estoque sobe e status=recebido", async () => {
    const { compra_id } = await criarCompraManual({
      fornecedor_id: fornecedorId,
      empresa_compradora_id: empresaId,
      galpao_id: galpaoId,
      criado_por: usuarioId,
      itens: [{ produto_id: produtoId, qty_comprada: 10 }],
    });

    // recebe 4 (parcial)
    const r1 = await receberCompraManual({
      compra_id,
      usuario_id: usuarioId,
      itens: [{ item_id: await primeiroItemId(compra_id), qty_recebida: 4, custo_unitario: 12 }],
    });
    expect(r1.status).toBe("parcial");

    // recebe 6 (completa)
    const r2 = await receberCompraManual({
      compra_id,
      usuario_id: usuarioId,
      itens: [{ item_id: await primeiroItemId(compra_id), qty_recebida: 6, custo_unitario: 12 }],
    });
    expect(r2.status).toBe("recebido");

    // estoque do produto no galpão = 10
    const { data: est } = await sb
      .from("siso_estoque")
      .select("saldo")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId);
    const total = (est ?? []).reduce((s, e) => s + Number((e as { saldo: number }).saldo), 0);
    expect(total).toBe(10);

    // custo médio = 12: vale 12 só porque TODO recebimento neste arquivo usa
    // custo 12, sobre um produto fresco (sku per-run via RND) sem histórico.
    const { data: cm } = await sb
      .from("siso_custo_medio")
      .select("custo_medio")
      .eq("produto_id", produtoId)
      .maybeSingle();
    expect(Number((cm as { custo_medio: number } | null)?.custo_medio ?? 0)).toBe(12);

    // recebimento deve gerar pendência(s) de put-away (caminho canônico), senão
    // o saldo fica preso na loc RECEBIMENTO (reconciliador-oc só conta picking).
    const { data: pend } = await sb
      .from("siso_wms_pendencias_guarda")
      .select("qty_inicial")
      .eq("produto_id", produtoId)
      .eq("galpao_id", galpaoId);
    const pendRows = (pend ?? []) as { qty_inicial: number }[];
    expect(pendRows.length).toBeGreaterThan(0);
    const totalPend = pendRows.reduce((s, p) => s + Number(p.qty_inicial), 0);
    expect(totalPend).toBe(10);
  });

  it("receber além do faltante lança", async () => {
    const { compra_id } = await criarCompraManual({
      fornecedor_id: fornecedorId,
      empresa_compradora_id: empresaId,
      galpao_id: galpaoId,
      criado_por: usuarioId,
      itens: [{ produto_id: produtoId, qty_comprada: 2 }],
    });
    await expect(
      receberCompraManual({
        compra_id,
        usuario_id: usuarioId,
        itens: [{ item_id: await primeiroItemId(compra_id), qty_recebida: 5, custo_unitario: 12 }],
      }),
    ).rejects.toThrow();
  });

  it("cancela sem recebimento; bloqueia cancelar com recebimento", async () => {
    const { cancelarCompraManual } = await import("../../src/lib/wms/compras-manuais");
    // sem recebimento → ok
    const { compra_id: a } = await criarCompraManual({
      fornecedor_id: fornecedorId,
      empresa_compradora_id: empresaId,
      galpao_id: galpaoId,
      criado_por: usuarioId,
      itens: [{ produto_id: produtoId, qty_comprada: 1 }],
    });
    expect(await cancelarCompraManual(a)).toEqual({ ok: true });
    // com recebimento → bloqueia
    const { compra_id: b } = await criarCompraManual({
      fornecedor_id: fornecedorId,
      empresa_compradora_id: empresaId,
      galpao_id: galpaoId,
      criado_por: usuarioId,
      itens: [{ produto_id: produtoId, qty_comprada: 2 }],
    });
    await receberCompraManual({
      compra_id: b,
      usuario_id: usuarioId,
      itens: [{ item_id: await primeiroItemId(b), qty_recebida: 1, custo_unitario: 12 }],
    });
    expect(await cancelarCompraManual(b)).toEqual({ ok: false, reason: "tem_recebimento" });
  });
});

async function primeiroItemId(compraId: string): Promise<string> {
  const { data } = await sb
    .from("siso_compras_manuais_itens")
    .select("id")
    .eq("compra_id", compraId)
    .limit(1)
    .single();
  return (data as { id: string }).id;
}
