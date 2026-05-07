import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

interface RouteParams {
  params: Promise<{ sku: string }>;
}

/**
 * GET /api/cross/produtos/:sku/equivalentes-rapidos
 *
 * Versão "rápida" da lista de equivalentes — apenas dados do cache local
 * (`siso_produtos_catalogo` + `siso_produto_links`). Sem chamada Tiny, sem
 * estoque por galpão.
 *
 * Combina 2 fontes:
 *  - SKUs que compartilham >=1 OEM (descoberta automática)
 *  - SKUs linkados manualmente em siso_produto_links (operador disse que são
 *    equivalentes mesmo sem OEM em comum)
 *
 * Pensado pra rendering inline na tela de busca.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { sku: skuRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();
  if (!sku) {
    return NextResponse.json({ error: "SKU obrigatório" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Busca o produto base (precisamos do array oem)
  const { data: base } = await supabase
    .from("siso_produtos_catalogo")
    .select("sku, oem")
    .eq("sku", sku)
    .maybeSingle();

  if (!base) {
    return NextResponse.json({ sku, equivalentes: [] });
  }

  const baseOems: string[] = base.oem ?? [];

  // 1. Busca SKUs com OEM compartilhado
  const skusPorOem = new Set<string>();
  if (baseOems.length > 0) {
    const { data } = await supabase
      .from("siso_produtos_catalogo")
      .select("sku")
      .overlaps("oem", baseOems)
      .neq("sku", sku);
    for (const row of data ?? []) skusPorOem.add(row.sku);
  }

  // 2. Busca SKUs linkados manualmente (em ambos os lados do par)
  const skusPorLink = new Set<string>();
  const { data: linksA } = await supabase
    .from("siso_produto_links")
    .select("sku_b")
    .eq("sku_a", sku);
  for (const row of linksA ?? []) skusPorLink.add(row.sku_b);

  const { data: linksB } = await supabase
    .from("siso_produto_links")
    .select("sku_a")
    .eq("sku_b", sku);
  for (const row of linksB ?? []) skusPorLink.add(row.sku_a);

  // 3. União dos SKUs candidatos
  const todosOsSkus = Array.from(new Set([...skusPorOem, ...skusPorLink]));
  if (todosOsSkus.length === 0) {
    return NextResponse.json({ sku, equivalentes: [] });
  }

  // 4. Busca dados de catálogo dos SKUs encontrados
  const { data: produtos } = await supabase
    .from("siso_produtos_catalogo")
    .select("sku, nome, fornecedor, marca, imagem_url, oem")
    .in("sku", todosOsSkus)
    .limit(50);

  const lista = (produtos ?? []).map((row) => {
    const oemsCompartilhados = (row.oem ?? []).filter((o: string) =>
      baseOems.includes(o),
    );
    const temOem = oemsCompartilhados.length > 0;
    const temLink = skusPorLink.has(row.sku);
    const origem: "oem" | "link" | "oem+link" =
      temOem && temLink ? "oem+link" : temLink ? "link" : "oem";
    return {
      sku: row.sku,
      nome: row.nome,
      fornecedor: row.fornecedor,
      marca: row.marca,
      imagem_url: row.imagem_url,
      oems: row.oem ?? [],
      oems_compartilhados: oemsCompartilhados,
      origem,
    };
  });

  // Ordena: links manuais primeiro (mais "intencionais"), depois por OEM
  lista.sort((a, b) => {
    const score = (origem: string) =>
      origem === "oem+link" ? 0 : origem === "link" ? 1 : 2;
    return score(a.origem) - score(b.origem);
  });

  return NextResponse.json({ sku, equivalentes: lista });
}
