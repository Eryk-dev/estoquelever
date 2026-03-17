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
    // 1. Fetch items for the given pedidos (exclude items moved to compra flow)
    const { data: items, error: itemsError } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, gtin, descricao, quantidade_pedida, separacao_marcado, separacao_marcado_em, quantidade_bipada, bipado_completo, imagem_url, compra_status",
      )
      .in("pedido_id", pedido_ids)
      .is("compra_status", null);

    if (itemsError) {
      logger.error("checklist-items", "Failed to fetch items", {
        error: itemsError.message,
      });
      return NextResponse.json(
        { error: itemsError.message },
        { status: 500 },
      );
    }

    // 2. Fetch origin empresa_id per pedido (for localizacao join + location updates)
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

    // 3. Fetch localizacao + stock from siso_pedido_item_estoques
    const { data: estoques } = await supabase
      .from("siso_pedido_item_estoques")
      .select("pedido_id, produto_id, empresa_id, localizacao, saldo, disponivel")
      .in("pedido_id", pedido_ids);

    // Build localizacao + stock maps (origin empresa only)
    const locMap = new Map<string, string>();
    const stockMap = new Map<string, { saldo: number; disponivel: number }>();
    for (const e of estoques ?? []) {
      const originEmpresa = pedidoEmpresaMap.get(e.pedido_id);
      if (e.empresa_id === originEmpresa) {
        const key = `${e.pedido_id}:${e.produto_id}`;
        if (e.localizacao) locMap.set(key, e.localizacao);
        stockMap.set(key, {
          saldo: e.saldo ?? 0,
          disponivel: e.disponivel ?? 0,
        });
      }
    }

    // 3b. Fetch galpao name for origin empresas (needed for stock adjustment calls)
    const uniqueEmpresaIds = Array.from(new Set(pedidoEmpresaMap.values()));
    const galpaoMap = new Map<string, string>();
    if (uniqueEmpresaIds.length > 0) {
      const { data: empresas } = await supabase
        .from("siso_empresas")
        .select("id, siso_galpoes(nome)")
        .in("id", uniqueEmpresaIds);
      for (const emp of empresas ?? []) {
        const g = emp.siso_galpoes as unknown as { nome: string } | null;
        if (g?.nome) galpaoMap.set(emp.id, g.nome);
      }
    }

    // 4. Shape response (include empresa_origem_id for location updates)
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
      imagem_url: item.imagem_url ?? null,
      localizacao:
        locMap.get(`${item.pedido_id}:${item.produto_id}`) ?? null,
      saldo: stockMap.get(`${item.pedido_id}:${item.produto_id}`)?.saldo ?? 0,
      disponivel: stockMap.get(`${item.pedido_id}:${item.produto_id}`)?.disponivel ?? 0,
      empresa_origem_id: pedidoEmpresaMap.get(item.pedido_id) ?? null,
      galpao_nome: galpaoMap.get(pedidoEmpresaMap.get(item.pedido_id) ?? "") ?? null,
    }));

    return NextResponse.json({ items: result });
  } catch (err) {
    logger.error("checklist-items", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
