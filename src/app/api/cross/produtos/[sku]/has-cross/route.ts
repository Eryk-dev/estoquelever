import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

interface RouteParams {
  params: Promise<{ sku: string }>;
}

/**
 * GET /api/cross/produtos/:sku/has-cross
 *
 * Resposta ultra-leve: { has: boolean, count: number }
 *
 * Conta SKUs que compartilham OEM + SKUs linkados manualmente. Pensado pra
 * o trigger do CrossPopoverButton decidir se renderiza ou não — evita
 * mostrar botão para SKUs sem nenhuma alternativa.
 *
 * Custo: 3 queries indexadas (~5-15ms no total). O índice GIN em oem
 * torna o overlap query rápido mesmo em 34k produtos.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { sku: skuRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();
  if (!sku) {
    return NextResponse.json({ has: false, count: 0 });
  }

  const supabase = createServiceClient();

  // Primeiro pega os OEMs do produto (1 query)
  const { data: produto } = await supabase
    .from("siso_produtos_catalogo")
    .select("oem")
    .eq("sku", sku)
    .maybeSingle();

  const oems: string[] = produto?.oem ?? [];

  const skusEncontrados = new Set<string>();

  // SKUs que compartilham OEM
  if (oems.length > 0) {
    const { data } = await supabase
      .from("siso_produtos_catalogo")
      .select("sku")
      .overlaps("oem", oems)
      .neq("sku", sku);
    for (const row of data ?? []) skusEncontrados.add(row.sku);
  }

  // Links manuais (em ambas direções)
  const [{ data: linksA }, { data: linksB }] = await Promise.all([
    supabase.from("siso_produto_links").select("sku_b").eq("sku_a", sku),
    supabase.from("siso_produto_links").select("sku_a").eq("sku_b", sku),
  ]);
  for (const row of linksA ?? []) skusEncontrados.add(row.sku_b);
  for (const row of linksB ?? []) skusEncontrados.add(row.sku_a);

  return NextResponse.json({
    has: skusEncontrados.size > 0,
    count: skusEncontrados.size,
  });
}
