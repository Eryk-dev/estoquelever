import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { buscarProdutoPorSku, buscarProdutoPorGtin } from "@/lib/tiny-api";
import { runWithEmpresa } from "@/lib/tiny-queue";

/**
 * POST /api/transferencia/[id]/coletar
 *
 * Scan a product (by SKU or EAN) and add it to the transfer session.
 * Searches in the ORIGIN empresa only (no localizacao field).
 *
 * Body: { codigo: string, quantidade?: number }
 * Returns: { item, total_itens }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessao invalida" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createServiceClient();

  try {
    // Fetch transferencia to validate status and ownership
    const { data: transferencia, error: fetchError } = await supabase
      .from("siso_transferencias")
      .select("id, empresa_origem_id, usuario_id, status")
      .eq("id", id)
      .single();

    if (fetchError || !transferencia) {
      return NextResponse.json(
        { error: "Transferencia nao encontrada" },
        { status: 404 },
      );
    }

    if (transferencia.status !== "em_andamento") {
      return NextResponse.json(
        { error: "Transferencia nao esta em andamento" },
        { status: 400 },
      );
    }

    if (
      transferencia.usuario_id !== session.id &&
      !session.cargos.includes("admin")
    ) {
      return NextResponse.json(
        { error: "Apenas o criador pode coletar itens" },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { codigo, quantidade } = body;

    if (!codigo || !codigo.trim()) {
      return NextResponse.json(
        { error: "Codigo e obrigatorio" },
        { status: 400 },
      );
    }

    // Search product in ORIGIN empresa: SKU first, then GTIN
    const { token } = await getValidTokenByEmpresa(
      transferencia.empresa_origem_id,
    );
    const trimmedCodigo = codigo.trim();

    const produto = await runWithEmpresa(
      transferencia.empresa_origem_id,
      async () => {
        const bySku = await buscarProdutoPorSku(token, trimmedCodigo);
        if (bySku) return { ...bySku, searchedByGtin: false };

        const byGtin = await buscarProdutoPorGtin(token, trimmedCodigo);
        if (byGtin) return { ...byGtin, searchedByGtin: true };

        return null;
      },
    );

    if (!produto) {
      return NextResponse.json(
        { error: "Produto nao encontrado no Tiny" },
        { status: 404 },
      );
    }

    // Insert transfer item
    const qty = quantidade && quantidade > 0 ? quantidade : 1;
    const { data: item, error: insertError } = await supabase
      .from("siso_transferencia_itens")
      .insert({
        transferencia_id: id,
        produto_id_tiny_origem: produto.id,
        sku: produto.codigo,
        nome_produto: produto.descricao,
        ean: produto.searchedByGtin ? trimmedCodigo : null,
        quantidade: qty,
      })
      .select(
        "id, produto_id_tiny_origem, sku, nome_produto, ean, quantidade, status, created_at",
      )
      .single();

    if (insertError) {
      logger.error("transferencia-coletar", "Erro ao inserir item", {
        error: insertError.message,
        transferenciaId: id,
        codigo: trimmedCodigo,
      });
      return NextResponse.json(
        { error: "Erro ao salvar item" },
        { status: 500 },
      );
    }

    // Compute total items
    const { count } = await supabase
      .from("siso_transferencia_itens")
      .select("id", { count: "exact", head: true })
      .eq("transferencia_id", id);

    return NextResponse.json(
      {
        item,
        total_itens: count ?? 0,
      },
      { status: 201 },
    );
  } catch (err) {
    logger.error("transferencia-coletar", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      transferenciaId: id,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
