import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

interface RouteParams {
  params: Promise<{ sku: string }>;
}

/**
 * GET /api/cross/produtos/:sku/equivalentes-rapidos
 *
 * Retorna todos os SKUs equivalentes via fecho transitivo (cluster do
 * grafo de equivalência: OEM compartilhado + links manuais propagam).
 * Apenas dados do cache local — sem chamada Tiny.
 *
 * Cada equivalente é classificado por origem:
 *   - 'oem'      → compartilha OEM direto com o SKU base
 *   - 'link'     → link manual direto com o SKU base
 *   - 'oem+link' → ambos (OEM + link direto)
 *   - 'cadeia'   → alcançado por transitividade (sem aresta direta)
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

  // 1. Cluster transitivo via SQL function (retorna SETOF text)
  const { data: clusterRows } = await supabase.rpc("siso_cross_cluster_skus", {
    p_sku: sku,
  });

  const clusterSkus: string[] = Array.isArray(clusterRows)
    ? (clusterRows as Array<string | { siso_cross_cluster_skus: string }>).map(
        (r) => (typeof r === "string" ? r : r.siso_cross_cluster_skus),
      )
    : [];

  if (clusterSkus.length === 0) {
    return NextResponse.json({ sku, equivalentes: [] });
  }

  // 2. Carrega base + dados de catálogo dos SKUs do cluster (uma query)
  const [{ data: base }, { data: produtos }] = await Promise.all([
    supabase
      .from("siso_produtos_catalogo")
      .select("sku, oem")
      .eq("sku", sku)
      .maybeSingle(),
    supabase
      .from("siso_produtos_catalogo")
      .select("sku, nome, fornecedor, marca, imagem_url, localizacao, oem")
      .in("sku", clusterSkus),
  ]);

  const baseOems: string[] = base?.oem ?? [];

  // 3. Identifica quais SKUs têm link manual DIRETO com o base
  const skusComLinkDireto = new Set<string>();
  const [{ data: linksA }, { data: linksB }] = await Promise.all([
    supabase.from("siso_produto_links").select("sku_b").eq("sku_a", sku),
    supabase.from("siso_produto_links").select("sku_a").eq("sku_b", sku),
  ]);
  for (const row of linksA ?? []) skusComLinkDireto.add(row.sku_b);
  for (const row of linksB ?? []) skusComLinkDireto.add(row.sku_a);

  // 4. Classifica cada SKU do cluster por origem
  const lista = (produtos ?? []).map((row) => {
    const oemsCompartilhados = (row.oem ?? []).filter((o: string) =>
      baseOems.includes(o),
    );
    const temOemDireto = oemsCompartilhados.length > 0;
    const temLinkDireto = skusComLinkDireto.has(row.sku);

    let origem: "oem" | "link" | "oem+link" | "cadeia";
    if (temOemDireto && temLinkDireto) origem = "oem+link";
    else if (temLinkDireto) origem = "link";
    else if (temOemDireto) origem = "oem";
    else origem = "cadeia";

    return {
      sku: row.sku,
      nome: row.nome,
      fornecedor: row.fornecedor,
      marca: row.marca,
      imagem_url: row.imagem_url,
      localizacao: row.localizacao,
      oems: row.oem ?? [],
      oems_compartilhados: oemsCompartilhados,
      origem,
    };
  });

  // Ordena: links manuais primeiro, depois oem direto, depois cadeia
  lista.sort((a, b) => {
    const score = (origem: string) =>
      origem === "oem+link"
        ? 0
        : origem === "link"
          ? 1
          : origem === "oem"
            ? 2
            : 3; // cadeia
    return score(a.origem) - score(b.origem);
  });

  return NextResponse.json({ sku, equivalentes: lista });
}
