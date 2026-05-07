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
 * (`siso_produtos_catalogo`). Sem chamada Tiny, sem estoque por galpão.
 *
 * Pensado pra rendering inline na tela de busca, onde a velocidade importa
 * mais que a precisão do estoque. Se quiser estoque, abre o detalhe completo.
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

  // Busca os OEMs do produto base
  const { data: base } = await supabase
    .from("siso_produtos_catalogo")
    .select("sku, oem")
    .eq("sku", sku)
    .maybeSingle();

  if (!base || !base.oem || base.oem.length === 0) {
    return NextResponse.json({ sku, equivalentes: [] });
  }

  // Busca outros SKUs que compartilham pelo menos um OEM
  const { data: equivalentes } = await supabase
    .from("siso_produtos_catalogo")
    .select("sku, nome, fornecedor, marca, imagem_url, oem")
    .overlaps("oem", base.oem)
    .neq("sku", sku)
    .limit(20);

  const lista = (equivalentes ?? []).map((row) => ({
    sku: row.sku,
    nome: row.nome,
    fornecedor: row.fornecedor,
    marca: row.marca,
    imagem_url: row.imagem_url,
    oems: row.oem ?? [],
    oems_compartilhados: (row.oem ?? []).filter((o: string) => base.oem.includes(o)),
  }));

  return NextResponse.json({ sku, equivalentes: lista });
}
