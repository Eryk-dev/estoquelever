import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import {
  buscarProdutoPorSku,
  buscarProdutoPorGtin,
} from "@/lib/tiny-api";
import { runWithEmpresa } from "@/lib/tiny-queue";

/**
 * POST /api/inventario/[id]/coletar
 *
 * Scan a product (by SKU or EAN) and add it to the inventory session.
 * Searches Tiny ERP by codigo first, then by gtin as fallback.
 *
 * Body: { codigo: string, localizacao: string, quantidade?: number }
 * Returns: { item, ja_escaneado, localizacoes_anteriores, total_itens }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createServiceClient();

  try {
    // Fetch inventario to validate status and ownership
    const { data: inventario, error: fetchError } = await supabase
      .from("siso_inventarios")
      .select("id, empresa_id, usuario_id, status")
      .eq("id", id)
      .single();

    if (fetchError || !inventario) {
      return NextResponse.json(
        { error: "Inventário não encontrado" },
        { status: 404 },
      );
    }

    if (inventario.status !== "em_andamento") {
      return NextResponse.json(
        { error: "Inventário não está em andamento" },
        { status: 400 },
      );
    }

    // Only creator can scan
    if (inventario.usuario_id !== session.id && !session.cargos.includes("admin")) {
      return NextResponse.json(
        { error: "Apenas o criador pode coletar itens" },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { codigo, localizacao, quantidade } = body;

    if (!localizacao || !localizacao.trim()) {
      return NextResponse.json(
        { error: "Localização é obrigatória" },
        { status: 400 },
      );
    }

    if (!codigo || !codigo.trim()) {
      return NextResponse.json(
        { error: "Código é obrigatório" },
        { status: 400 },
      );
    }

    // Search product in Tiny: SKU first, then GTIN
    const { token } = await getValidTokenByEmpresa(inventario.empresa_id);
    const trimmedCodigo = codigo.trim();

    const produto = await runWithEmpresa(inventario.empresa_id, async () => {
      const bySku = await buscarProdutoPorSku(token, trimmedCodigo);
      if (bySku) return { ...bySku, searchedByGtin: false };

      const byGtin = await buscarProdutoPorGtin(token, trimmedCodigo);
      if (byGtin) return { ...byGtin, searchedByGtin: true };

      return null;
    });

    if (!produto) {
      return NextResponse.json(
        { error: "Produto não encontrado no Tiny" },
        { status: 404 },
      );
    }

    // Insert inventory item
    const qty = quantidade && quantidade > 0 ? quantidade : 1;
    const { data: item, error: insertError } = await supabase
      .from("siso_inventario_itens")
      .insert({
        inventario_id: id,
        produto_id_tiny: produto.id,
        sku: produto.codigo,
        nome_produto: produto.descricao,
        ean: produto.searchedByGtin ? trimmedCodigo : null,
        localizacao: localizacao.trim(),
        quantidade: qty,
      })
      .select("id, produto_id_tiny, sku, nome_produto, ean, localizacao, quantidade, status, created_at")
      .single();

    if (insertError) {
      logger.error("inventario-coletar", "Erro ao inserir item", {
        error: insertError.message,
        inventarioId: id,
        codigo: trimmedCodigo,
      });
      return NextResponse.json(
        { error: "Erro ao salvar item" },
        { status: 500 },
      );
    }

    // Check for duplicate SKU in this inventory (same SKU, different row)
    const { data: duplicates } = await supabase
      .from("siso_inventario_itens")
      .select("id, localizacao, quantidade")
      .eq("inventario_id", id)
      .ilike("sku", produto.codigo)
      .neq("id", item.id);

    const ja_escaneado = duplicates && duplicates.length > 0;
    const localizacoes_anteriores = ja_escaneado
      ? duplicates.map(
          (d) => `${d.localizacao} (×${d.quantidade})`,
        )
      : [];

    // Compute total items
    const { count } = await supabase
      .from("siso_inventario_itens")
      .select("id", { count: "exact", head: true })
      .eq("inventario_id", id);

    return NextResponse.json(
      {
        item,
        ja_escaneado,
        localizacoes_anteriores,
        total_itens: count ?? 0,
      },
      { status: 201 },
    );
  } catch (err) {
    logger.error("inventario-coletar", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      inventarioId: id,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
