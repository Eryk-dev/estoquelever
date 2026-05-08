import { createServiceClient } from "@/lib/supabase-server";

export interface Fornecedor {
  id: string;
  nome: string;
  cnpj: string | null;
  prefixo_sku: string | null;
  ativo: boolean;
  observacoes: string | null;
}

export interface ProdutoFornecedor {
  id: string;
  produto_id: string;
  fornecedor_id: string;
  lead_time_dias_min: number;
  lead_time_dias_medio: number;
  lead_time_dias_max: number;
  ultima_compra_em: string | null;
  custo_unitario: number | null;
  qty_minima_pedido: number;
  multiplo_compra: number;
  preferencial: boolean;
  ativo: boolean;
}

export async function listarFornecedores(): Promise<Fornecedor[]> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_fornecedores")
    .select("*")
    .eq("ativo", true)
    .order("nome");
  if (error) throw error;
  return (data ?? []) as Fornecedor[];
}

export async function criarFornecedor(input: {
  nome: string;
  cnpj?: string;
  prefixo_sku?: string;
  observacoes?: string;
}): Promise<Fornecedor> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_fornecedores")
    .insert(input)
    .select()
    .single();
  if (error) throw error;
  return data as Fornecedor;
}

export async function listarProdutoFornecedores(
  produtoId: string,
): Promise<ProdutoFornecedor[]> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_produto_fornecedores")
    .select("*")
    .eq("produto_id", produtoId)
    .eq("ativo", true)
    .order("preferencial", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ProdutoFornecedor[];
}

export async function vincularProdutoFornecedor(input: {
  produto_id: string;
  fornecedor_id: string;
  lead_time_dias_min?: number;
  lead_time_dias_medio?: number;
  lead_time_dias_max?: number;
  custo_unitario?: number;
  qty_minima_pedido?: number;
  multiplo_compra?: number;
  preferencial?: boolean;
}): Promise<ProdutoFornecedor> {
  const sb = createServiceClient();
  if (input.preferencial) {
    await sb
      .from("siso_produto_fornecedores")
      .update({ preferencial: false })
      .eq("produto_id", input.produto_id);
  }
  const { data, error } = await sb
    .from("siso_produto_fornecedores")
    .insert(input)
    .select()
    .single();
  if (error) throw error;
  return data as ProdutoFornecedor;
}

export async function getFornecedorPreferencial(
  produtoId: string,
): Promise<{ fornecedor: Fornecedor; pf: ProdutoFornecedor } | null> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_produto_fornecedores")
    .select("*, fornecedor:siso_fornecedores(*)")
    .eq("produto_id", produtoId)
    .eq("ativo", true)
    .eq("preferencial", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    fornecedor: data.fornecedor as unknown as Fornecedor,
    pf: data as unknown as ProdutoFornecedor,
  };
}

/**
 * Auto-cria fornecedores no siso_fornecedores a partir do mapeamento canônico
 * de prefixos SKU → fornecedor (alinhado com src/lib/sku-fornecedor.ts).
 * Idempotente: ignora se nome já existe.
 */
export async function autoCriarFornecedoresDosPrefixosSku(): Promise<{
  criados: number;
  existentes: number;
}> {
  const sb = createServiceClient();
  const PADRAO: Array<{ nome: string; prefixos: string[] }> = [
    { nome: "Diversos", prefixos: ["19"] },
    { nome: "141", prefixos: ["A1"] },
    { nome: "Tiger", prefixos: ["EW", "TG"] },
    { nome: "LDRU", prefixos: ["LD"] },
    { nome: "LEFS", prefixos: ["L0"] },
    { nome: "ACA", prefixos: [] }, // 6-digit numeric, sem prefixo
    { nome: "GAUSS", prefixos: ["GB", "GE", "GS", "GI"] },
    { nome: "MRMK", prefixos: ["MK", "M0", "B0"] },
    { nome: "Delphi", prefixos: ["CAK", "CS"] },
    { nome: "Kintop", prefixos: ["KT"] },
    {
      nome: "Multiqualita",
      prefixos: [
        "MQ", "APX", "WDC", "AT", "FD", "FI", "GM", "HO", "HY", "KI",
        "MAN", "MB", "NI", "PG", "RN", "SC", "TO", "UN", "VO", "VW",
        "AG", "BI", "BA",
      ],
    },
  ];
  let criados = 0;
  let existentes = 0;
  for (const f of PADRAO) {
    const { data: jaExiste } = await sb
      .from("siso_fornecedores")
      .select("id")
      .eq("nome", f.nome)
      .maybeSingle();
    if (jaExiste) {
      existentes++;
      continue;
    }
    const prefixoPrincipal = f.prefixos[0] ?? null;
    const observacoes =
      f.prefixos.length > 1
        ? `prefixos adicionais: ${f.prefixos.slice(1).join(", ")}`
        : f.prefixos.length === 0
          ? "ACA: SKU 6-dígitos numérico (sem prefixo simples)"
          : null;
    const { error } = await sb.from("siso_fornecedores").insert({
      nome: f.nome,
      prefixo_sku: prefixoPrincipal,
      observacoes,
    });
    if (!error) criados++;
  }
  return { criados, existentes };
}
