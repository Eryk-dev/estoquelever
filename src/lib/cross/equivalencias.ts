import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase-server";
import { aggregateLiveStockBySku } from "@/lib/wms/live-stock";
import type { LiveStockEntry } from "@/lib/wms/live-stock";
import {
  normalizarPar,
  montarEquivalentes,
  type CrossPar,
  type CrossStatus,
  type ProdutoMin,
  type EquivalentesDaPeca,
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
  return rows.map((r) => ({
    id: r.id as number,
    sku_a: r.sku_a as string,
    sku_b: r.sku_b as string,
    fonte: r.fonte as string,
    criado_em: r.criado_em as string,
    a: prod[r.sku_a as string] ?? null,
    b: prod[r.sku_b as string] ?? null,
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
