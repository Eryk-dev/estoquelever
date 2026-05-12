import { createServiceClient } from "@/lib/supabase-server";

export interface Fornecedor {
  id: string;
  nome: string;
  cnpj: string | null;
  prefixo_sku: string | null;
  ativo: boolean;
  observacoes: string | null;
  tiny_fornecedor_id: number | null;
  /** Default mínimo herdado em vínculos novos com produto. */
  lead_time_dias_min: number | null;
  lead_time_dias_medio: number | null;
  lead_time_dias_max: number | null;
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
  /** Código deste produto no catálogo do fornecedor (codigoProdutoNoFornecedor no Tiny). */
  codigo_fornecedor: string | null;
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
  lead_time_dias_min?: number | null;
  lead_time_dias_medio?: number | null;
  lead_time_dias_max?: number | null;
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

export interface ProdutoFornecedorComJoin extends ProdutoFornecedor {
  fornecedor: Fornecedor | null;
}

export async function listarProdutoFornecedores(
  produtoId: string,
): Promise<ProdutoFornecedorComJoin[]> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_produto_fornecedores")
    .select("*, fornecedor:siso_fornecedores(*)")
    .eq("produto_id", produtoId)
    .eq("ativo", true)
    .order("preferencial", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as ProdutoFornecedorComJoin[];
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
  codigo_fornecedor?: string | null;
}): Promise<ProdutoFornecedor> {
  const sb = createServiceClient();
  if (input.preferencial) {
    await sb
      .from("siso_produto_fornecedores")
      .update({ preferencial: false })
      .eq("produto_id", input.produto_id);
  }

  // Herda lead time do fornecedor quando o caller não informa explicitamente.
  // Só busca quando ao menos um campo está vazio, pra não pagar round-trip à toa.
  const precisaHerdar =
    input.lead_time_dias_min === undefined ||
    input.lead_time_dias_medio === undefined ||
    input.lead_time_dias_max === undefined;
  let payload: Record<string, unknown> = { ...input };
  if (precisaHerdar) {
    const { data: forn } = await sb
      .from("siso_fornecedores")
      .select("lead_time_dias_min, lead_time_dias_medio, lead_time_dias_max")
      .eq("id", input.fornecedor_id)
      .single();
    if (forn) {
      const f = forn as {
        lead_time_dias_min: number | null;
        lead_time_dias_medio: number | null;
        lead_time_dias_max: number | null;
      };
      if (input.lead_time_dias_min === undefined && f.lead_time_dias_min !== null) {
        payload.lead_time_dias_min = f.lead_time_dias_min;
      }
      if (input.lead_time_dias_medio === undefined && f.lead_time_dias_medio !== null) {
        payload.lead_time_dias_medio = f.lead_time_dias_medio;
      }
      if (input.lead_time_dias_max === undefined && f.lead_time_dias_max !== null) {
        payload.lead_time_dias_max = f.lead_time_dias_max;
      }
    }
  }

  const { data, error } = await sb
    .from("siso_produto_fornecedores")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data as ProdutoFornecedor;
}

/**
 * Garante a existência de um fornecedor identificado pelo tiny_fornecedor_id.
 * - Se já existir um fornecedor com esse tiny_id, retorna ele.
 * - Senão, tenta casar pelo nome (case-insensitive trim) — se achar, atualiza
 *   o tiny_id pra dedupar futuras chamadas.
 * - Senão, cria.
 *
 * Usado pelo sync do Tiny pra evitar duplicatas quando o mesmo fornecedor
 * aparece em produtos de empresas diferentes.
 */
export async function ensureFornecedorTiny(input: {
  tiny_fornecedor_id: number;
  nome: string;
}): Promise<Fornecedor> {
  const sb = createServiceClient();
  const nomeNorm = input.nome.trim();

  const { data: porTiny } = await sb
    .from("siso_fornecedores")
    .select("*")
    .eq("tiny_fornecedor_id", input.tiny_fornecedor_id)
    .maybeSingle();
  if (porTiny) return porTiny as Fornecedor;

  const { data: porNome } = await sb
    .from("siso_fornecedores")
    .select("*")
    .ilike("nome", nomeNorm)
    .maybeSingle();
  if (porNome) {
    const { data: atualizado, error } = await sb
      .from("siso_fornecedores")
      .update({ tiny_fornecedor_id: input.tiny_fornecedor_id })
      .eq("id", (porNome as Fornecedor).id)
      .select()
      .single();
    if (error) throw error;
    return atualizado as Fornecedor;
  }

  const { data: criado, error } = await sb
    .from("siso_fornecedores")
    .insert({
      nome: nomeNorm,
      tiny_fornecedor_id: input.tiny_fornecedor_id,
      observacoes: "auto-criado via sync Tiny",
    })
    .select()
    .single();

  // Race com outra thread paralela: outra fila criou o mesmo fornecedor
  // entre o nosso SELECT e nosso INSERT. Re-busca e retorna o existente.
  if (error) {
    const isUnique =
      typeof (error as { code?: string }).code === "string" &&
      (error as { code: string }).code === "23505";
    if (isUnique) {
      const { data: retry } = await sb
        .from("siso_fornecedores")
        .select("*")
        .or(
          `tiny_fornecedor_id.eq.${input.tiny_fornecedor_id},nome.ilike.${nomeNorm.replace(/[*%]/g, " ")}`,
        )
        .limit(1)
        .maybeSingle();
      if (retry) return retry as Fornecedor;
    }
    throw error;
  }
  return criado as Fornecedor;
}

/**
 * Upsert de produto-fornecedor por (produto_id, fornecedor_id), atualizando
 * codigo_fornecedor + custo_unitario opcional. Diferente de
 * vincularProdutoFornecedor (INSERT only), esse é safe pra rerunning sync.
 */
export async function upsertProdutoFornecedor(input: {
  produto_id: string;
  fornecedor_id: string;
  codigo_fornecedor?: string | null;
  custo_unitario?: number | null;
  preferencial?: boolean;
}): Promise<void> {
  const sb = createServiceClient();
  if (input.preferencial) {
    await sb
      .from("siso_produto_fornecedores")
      .update({ preferencial: false })
      .eq("produto_id", input.produto_id);
  }

  // Em INSERT (vínculo novo) herda lead time do fornecedor, se configurado.
  // Em UPDATE preserva o lead time existente, então só inclui esses campos
  // no payload quando a linha ainda não existe.
  const { data: existente } = await sb
    .from("siso_produto_fornecedores")
    .select("id")
    .eq("produto_id", input.produto_id)
    .eq("fornecedor_id", input.fornecedor_id)
    .maybeSingle();

  const payload: Record<string, unknown> = {
    produto_id: input.produto_id,
    fornecedor_id: input.fornecedor_id,
    codigo_fornecedor: input.codigo_fornecedor ?? null,
    custo_unitario: input.custo_unitario ?? null,
    preferencial: input.preferencial ?? false,
    atualizado_em: new Date().toISOString(),
  };

  if (!existente) {
    const { data: forn } = await sb
      .from("siso_fornecedores")
      .select("lead_time_dias_min, lead_time_dias_medio, lead_time_dias_max")
      .eq("id", input.fornecedor_id)
      .single();
    if (forn) {
      const f = forn as {
        lead_time_dias_min: number | null;
        lead_time_dias_medio: number | null;
        lead_time_dias_max: number | null;
      };
      if (f.lead_time_dias_min !== null) payload.lead_time_dias_min = f.lead_time_dias_min;
      if (f.lead_time_dias_medio !== null) payload.lead_time_dias_medio = f.lead_time_dias_medio;
      if (f.lead_time_dias_max !== null) payload.lead_time_dias_max = f.lead_time_dias_max;
    }
  }

  const { error } = await sb
    .from("siso_produto_fornecedores")
    .upsert(payload, { onConflict: "produto_id,fornecedor_id" });
  if (error) throw error;
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
