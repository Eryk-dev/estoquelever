import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase-server";
import { aggregateLiveStockBySku } from "@/lib/wms/live-stock";
import type { LiveStockEntry } from "@/lib/wms/live-stock";
import { listarFornecedoresPorSkus } from "@/lib/wms/fornecedores-sku";
import {
  normalizarPar,
  montarEquivalentes,
  montarOndeComprar,
  oemEmComum,
  type CrossPar,
  type CrossStatus,
  type ProdutoMin,
  type EquivalentesDaPeca,
  type FornecedorPoolEntrada,
  type OndeComprarLinha,
} from "./equivalencias-core";

/** Pares do caderno que tocam `sku` (em qualquer dos lados). */
export async function paresDoSku(
  sb: SupabaseClient,
  sku: string,
): Promise<CrossPar[]> {
  const { data } = await sb
    .from("siso_cross_equivalencias")
    .select("id, sku_a, sku_b, relacao, status, fonte")
    .or(`sku_a.eq.${sku},sku_b.eq.${sku}`);
  return (data ?? []) as CrossPar[];
}

/** Status do par (a,b) no caderno, normalizado. null = não existe. */
export async function statusParCross(
  sb: SupabaseClient,
  a: string,
  b: string,
): Promise<CrossStatus | null> {
  const { sku_a, sku_b } = normalizarPar(a, b);
  const { data } = await sb
    .from("siso_cross_equivalencias")
    .select("status")
    .eq("sku_a", sku_a)
    .eq("sku_b", sku_b)
    .maybeSingle();
  return data ? (data.status as CrossStatus) : null;
}

/** Cria um palpite (sugestao). Idempotente: se o par já existe, devolve o existente. */
export async function criarLigacao(
  sb: SupabaseClient,
  args: { a: string; b: string; criadoPor: string | null; fonte?: string },
): Promise<{ id: number; criado: boolean }> {
  const { sku_a, sku_b } = normalizarPar(args.a, args.b);
  const { data, error } = await sb
    .from("siso_cross_equivalencias")
    .insert({ sku_a, sku_b, fonte: args.fonte ?? "manual", criado_por: args.criadoPor })
    .select("id")
    .single();
  if (!error && data) return { id: data.id as number, criado: true };
  // unique_violation → já existe
  const { data: existente } = await sb
    .from("siso_cross_equivalencias")
    .select("id")
    .eq("sku_a", sku_a)
    .eq("sku_b", sku_b)
    .maybeSingle();
  if (existente) return { id: existente.id as number, criado: false };
  throw error;
}

/** Decide o status de uma ligação (confirmar/bloquear/desfazer). */
export async function decidirLigacao(
  sb: SupabaseClient,
  args: { id: number; status: CrossStatus; decididoPor: string; observacao?: string },
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: args.status,
    atualizado_em: new Date().toISOString(),
  };
  if (args.status === "sugestao") {
    patch.decidido_por = null;
    patch.decidido_em = null;
  } else {
    patch.decidido_por = args.decididoPor;
    patch.decidido_em = new Date().toISOString();
    if (args.observacao !== undefined) patch.observacao = args.observacao;
  }
  const { error } = await sb.from("siso_cross_equivalencias").update(patch).eq("id", args.id);
  if (error) throw error;
}

export interface FilaItem {
  id: number;
  sku_a: string;
  sku_b: string;
  fonte: string;
  criado_em: string;
  a: ProdutoMin | null;
  b: ProdutoMin | null;
  /** OEM em comum entre as duas peças — dica de por que viraram palpite. */
  oem_compartilhado: string[];
}

/** Fila de validação: palpites (sugestao) com dados das duas peças. */
export async function listarFila(sb: SupabaseClient): Promise<FilaItem[]> {
  const { data: rows } = await sb
    .from("siso_cross_equivalencias")
    .select("id, sku_a, sku_b, fonte, criado_em")
    .eq("status", "sugestao")
    .order("criado_em", { ascending: true });
  if (!rows || rows.length === 0) return [];
  const skus = [...new Set(rows.flatMap((r) => [r.sku_a as string, r.sku_b as string]))];
  const prod = await carregarProdutos(sb, skus);

  // OEM por sku, pra computar o que as duas peças compartilham.
  const { data: oemRows } = await sb.from("siso_produtos").select("sku, oem").in("sku", skus);
  const oemPorSku = new Map<string, string[] | null>();
  for (const o of (oemRows ?? []) as Array<{ sku: string; oem: string[] | null }>) {
    oemPorSku.set(o.sku, o.oem);
  }

  return rows.map((r) => ({
    id: r.id as number,
    sku_a: r.sku_a as string,
    sku_b: r.sku_b as string,
    fonte: r.fonte as string,
    criado_em: r.criado_em as string,
    a: prod[r.sku_a as string] ?? null,
    b: prod[r.sku_b as string] ?? null,
    oem_compartilhado: oemEmComum(
      oemPorSku.get(r.sku_a as string) ?? null,
      oemPorSku.get(r.sku_b as string) ?? null,
    ),
  }));
}

async function carregarProdutos(
  sb: SupabaseClient,
  skus: string[],
): Promise<Record<string, ProdutoMin>> {
  if (skus.length === 0) return {};
  const { data } = await sb
    .from("siso_produtos")
    .select("sku, descricao, imagem_url, imagens, tier_qualidade")
    .in("sku", skus);
  const out: Record<string, ProdutoMin> = {};
  for (const p of data ?? []) {
    out[p.sku as string] = {
      sku: p.sku as string,
      descricao: (p.descricao as string | null) ?? null,
      imagem_url: (p.imagem_url as string | null) ?? null,
      imagens: (p.imagens as string[] | null) ?? null,
      tier_qualidade: (p.tier_qualidade as string | null) ?? null,
    };
  }
  return out;
}

/**
 * Ficha de equivalência de uma peça: equivalentes diretos do caderno +
 * estoque SEMPRE do ledger. Nunca toca o Tiny.
 */
export async function equivalentesDaPeca(
  sku: string,
  opts?: { incluirBloqueado?: boolean },
): Promise<EquivalentesDaPeca> {
  const sb = createServiceClient();
  const pares = await paresDoSku(sb, sku);
  if (pares.length === 0) return { sku, equivalentes: [] };

  const outrosSkus = [...new Set(pares.map((p) => (p.sku_a === sku ? p.sku_b : p.sku_a)))];
  const produtosPorSku = await carregarProdutos(sb, outrosSkus);

  // Estoque do ledger (Map<sku, Map<galpaoNome, LiveStockEntry>>) → Record.
  const estoqueMap = await aggregateLiveStockBySku(sb, outrosSkus);
  const estoquePorSku: Record<string, Record<string, LiveStockEntry>> = {};
  for (const [s, gmap] of estoqueMap.entries()) {
    estoquePorSku[s] = Object.fromEntries(gmap.entries());
  }

  return montarEquivalentes({
    sku,
    pares,
    produtosPorSku,
    estoquePorSku,
    incluirBloqueado: opts?.incluirBloqueado ?? true,
  });
}

/** SKUs dos equivalentes CONFIRMADOS de `sku` (pares diretos, sem corrente). */
export async function skusEquivalentesConfirmados(
  sb: SupabaseClient,
  sku: string,
): Promise<string[]> {
  const pares = await paresDoSku(sb, sku);
  const confirmados = pares
    .filter((p) => p.status === "confirmado")
    .map((p) => (p.sku_a === sku ? p.sku_b : p.sku_a));
  return [...new Set(confirmados)];
}

/**
 * Pool "Onde comprar": fornecedores do próprio SKU + dos equivalentes
 * CONFIRMADOS, numa lista só com proveniência (de qual SKU vem). Reusa o
 * loader de fornecedor (cadastro + fallback prefix). Palpite NÃO entra no pool.
 */
export async function ondeComprarDaPeca(sku: string): Promise<OndeComprarLinha[]> {
  const sb = createServiceClient();
  const confirmados = await skusEquivalentesConfirmados(sb, sku);
  const grupoSkus = [sku, ...confirmados];

  const fornMap = await listarFornecedoresPorSkus(grupoSkus);
  const fornecedoresPorSku: Record<string, FornecedorPoolEntrada[]> = {};
  for (const [s, v] of fornMap.entries()) {
    fornecedoresPorSku[s] = v.opcoes.map((o) => ({
      fornecedorId: o.fornecedorId,
      nome: o.nome,
      codigo_fornecedor: o.codigo_fornecedor,
      custo_unitario: o.custo_unitario,
      galpao_id: o.galpao_id,
      galpao_nome: o.galpao_nome,
      preferencial: o.preferencial,
    }));
  }
  return montarOndeComprar({ selfSku: sku, grupoSkus, fornecedoresPorSku });
}

/**
 * Cria palpites (sugestao, fonte `oem_auto`) entre `sku` e produtos que
 * compartilham algum OEM. Idempotente e respeita par existente (a UNIQUE
 * (sku_a,sku_b) faz o insert falhar → não revive bloqueado nem duplica).
 * Nunca confirma. Best-effort (fire-and-forget no caller).
 */
export async function gerarPalpitesPorOem(
  sku: string,
  oem: string[],
  criadoPor: string | null,
): Promise<number> {
  const codigos = [...new Set(oem.map((o) => o.trim()).filter(Boolean))];
  if (codigos.length === 0) return 0;
  const sb = createServiceClient();
  const { data: candidatos } = await sb
    .from("siso_produtos")
    .select("sku, oem")
    .overlaps("oem", codigos)
    .neq("sku", sku)
    .eq("ativo", true)
    .limit(50);

  let criados = 0;
  for (const c of (candidatos ?? []) as Array<{ sku: string; oem: string[] | null }>) {
    if (oemEmComum(codigos, c.oem).length === 0) continue;
    const { sku_a, sku_b } = normalizarPar(sku, c.sku);
    const { error } = await sb
      .from("siso_cross_equivalencias")
      .insert({ sku_a, sku_b, fonte: "oem_auto", criado_por: criadoPor });
    if (!error) criados++; // unique_violation → par já existe, ignora
  }
  return criados;
}
