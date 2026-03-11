import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * GET /api/separacao/checklist-items?pedidos=id1,id2,id3
 *
 * Fetch individual items for the given pedido IDs with localizacao
 * from the origin empresa's stock data. Used by the checklist page
 * for wave-picking display and progress tracking.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const pedidosParam = searchParams.get("pedidos");

  if (!pedidosParam) {
    return NextResponse.json(
      { error: "'pedidos' query param é obrigatório" },
      { status: 400 },
    );
  }

  const pedido_ids = pedidosParam.split(",").filter(Boolean);
  if (pedido_ids.length === 0) {
    return NextResponse.json(
      { error: "Nenhum pedido_id válido" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    // 1. Fetch items for the given pedidos
    const { data: items, error: itemsError } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, gtin, descricao, quantidade_pedida, separacao_marcado, separacao_marcado_em, quantidade_bipada, bipado_completo",
      )
      .in("pedido_id", pedido_ids);

    if (itemsError) {
      logger.error("checklist-items", "Failed to fetch items", {
        error: itemsError.message,
      });
      return NextResponse.json(
        { error: itemsError.message },
        { status: 500 },
      );
    }

    // 2. Fetch origin empresa_id per pedido (for localizacao join)
    const { data: pedidos } = await supabase
      .from("siso_pedidos")
      .select("id, empresa_origem_id")
      .in("id", pedido_ids);

    const pedidoEmpresaMap = new Map<string, string>();
    for (const p of pedidos ?? []) {
      if (p.empresa_origem_id) {
        pedidoEmpresaMap.set(p.id, p.empresa_origem_id);
      }
    }

    // 3. Fetch localizacao from siso_pedido_item_estoques
    const { data: estoques } = await supabase
      .from("siso_pedido_item_estoques")
      .select("pedido_id, produto_id, empresa_id, localizacao")
      .in("pedido_id", pedido_ids);

    // Build localizacao map: pedido_id:produto_id -> localizacao (origin empresa only)
    const locMap = new Map<string, string>();
    for (const e of estoques ?? []) {
      const originEmpresa = pedidoEmpresaMap.get(e.pedido_id);
      if (e.empresa_id === originEmpresa && e.localizacao) {
        locMap.set(`${e.pedido_id}:${e.produto_id}`, e.localizacao);
      }
    }

    // 4. Shape response
    const result = (items ?? []).map((item) => ({
      id: item.id,
      pedido_id: item.pedido_id,
      produto_id: item.produto_id,
      sku: item.sku,
      gtin: item.gtin,
      descricao: item.descricao,
      quantidade: item.quantidade_pedida,
      separacao_marcado: item.separacao_marcado ?? false,
      separacao_marcado_em: item.separacao_marcado_em,
      quantidade_bipada: item.quantidade_bipada ?? 0,
      bipado_completo: item.bipado_completo ?? false,
      localizacao:
        locMap.get(`${item.pedido_id}:${item.produto_id}`) ?? null,
    }));

    return NextResponse.json({ items: result });
  } catch (err) {
    logger.error("checklist-items", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
