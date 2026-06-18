import { createServiceClient } from "@/lib/supabase-server";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";

export interface FornecedorOpcao {
  /** id de siso_fornecedores; null quando vem do fallback do prefix map. */
  fornecedorId: string | null;
  nome: string;
  custo_unitario: number | null;
  lead_time_dias_medio: number | null;
  qty_minima_pedido: number;
  multiplo_compra: number;
  preferencial: boolean;
}

export interface FornecedoresPorSku {
  /** "cadastro" = veio de siso_produto_fornecedores; "prefixo" = fallback do mapa. */
  origem: "cadastro" | "prefixo";
  opcoes: FornecedorOpcao[];
}

type PfRow = {
  produto_id: string;
  fornecedor_id: string | null;
  custo_unitario: number | null;
  lead_time_dias_medio: number | null;
  qty_minima_pedido: number | null;
  multiplo_compra: number | null;
  preferencial: boolean | null;
  fornecedor: { nome: string } | null;
};

/**
 * Resolve, por SKU, as opções de fornecedor a partir de `siso_produto_fornecedores`
 * (preço/lead/MOQ/múltiplo, preferencial primeiro). Quando o SKU não tem vínculo
 * cadastrado, cai no `getFornecedorBySku` (prefix map) como fallback.
 *
 * Junção: `sku` → `siso_produtos.id` (UNIQUE) → `produto_fornecedores.produto_id`
 * (evita o legado `siso_pedido_itens.produto_id = tiny_produto_id`).
 */
export async function listarFornecedoresPorSkus(
  skus: string[],
): Promise<Map<string, FornecedoresPorSku>> {
  const resultado = new Map<string, FornecedoresPorSku>();
  const skusUnicos = [...new Set(skus.filter(Boolean))];
  if (skusUnicos.length === 0) return resultado;

  const sb = createServiceClient();

  // sku -> produto uuid (siso_produtos.sku é UNIQUE)
  const { data: produtos } = await sb
    .from("siso_produtos")
    .select("id, sku")
    .in("sku", skusUnicos);

  const skuPorProdutoId = new Map<string, string>();
  const produtoIdPorSku = new Map<string, string>();
  for (const p of (produtos ?? []) as { id: string; sku: string }[]) {
    skuPorProdutoId.set(p.id, p.sku);
    produtoIdPorSku.set(p.sku, p.id);
  }

  // vínculos ativos, preferencial primeiro
  const produtoIds = [...produtoIdPorSku.values()];
  const opcoesPorSku = new Map<string, FornecedorOpcao[]>();
  if (produtoIds.length > 0) {
    const { data: pfs } = await sb
      .from("siso_produto_fornecedores")
      .select("*, fornecedor:siso_fornecedores(*)")
      .in("produto_id", produtoIds)
      .eq("ativo", true)
      .order("preferencial", { ascending: false });

    for (const pf of (pfs ?? []) as unknown as PfRow[]) {
      const sku = skuPorProdutoId.get(pf.produto_id);
      if (!sku) continue;
      const lista = opcoesPorSku.get(sku) ?? [];
      lista.push({
        fornecedorId: pf.fornecedor_id ?? null,
        nome: pf.fornecedor?.nome ?? "—",
        custo_unitario: pf.custo_unitario ?? null,
        lead_time_dias_medio: pf.lead_time_dias_medio ?? null,
        qty_minima_pedido: Number(pf.qty_minima_pedido ?? 1),
        multiplo_compra: Number(pf.multiplo_compra ?? 1),
        preferencial: Boolean(pf.preferencial),
      });
      opcoesPorSku.set(sku, lista);
    }
  }

  for (const sku of skusUnicos) {
    const cadastro = opcoesPorSku.get(sku);
    if (cadastro && cadastro.length > 0) {
      resultado.set(sku, { origem: "cadastro", opcoes: cadastro });
      continue;
    }
    // fallback: prefix map
    const { fornecedor } = getFornecedorBySku(sku);
    resultado.set(sku, {
      origem: "prefixo",
      opcoes: [
        {
          fornecedorId: null,
          nome: fornecedor,
          custo_unitario: null,
          lead_time_dias_medio: null,
          qty_minima_pedido: 1,
          multiplo_compra: 1,
          preferencial: true,
        },
      ],
    });
  }

  return resultado;
}
