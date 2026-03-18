import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * GET /api/separacao/checklist-items?pedidos=id1,id2,id3
 *
 * Fetch individual items for the given pedido IDs with localizacao
 * from the separating empresa's stock data. For transfers, this is
 * the empresa in the separacao_galpao (the one that will ship), not
 * the empresa that originally received the order.
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
    // 1. Fetch items for the given pedidos.
    // Compra filtering is applied later based on the pedido status.
    const { data: items, error: itemsError } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, gtin, descricao, quantidade_pedida, separacao_marcado, separacao_marcado_em, quantidade_bipada, bipado_completo, imagem_url, compra_status",
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

    // 2. Fetch empresa_origem_id + separacao_galpao_id per pedido
    const { data: pedidos } = await supabase
      .from("siso_pedidos")
      .select("id, empresa_origem_id, separacao_galpao_id, status_separacao")
      .in("id", pedido_ids);

    const pedidoStatusMap = new Map<string, string | null>();
    for (const pedido of pedidos ?? []) {
      pedidoStatusMap.set(pedido.id, pedido.status_separacao ?? null);
    }

    // 2b. Resolve the "separating empresa" — the empresa in the galpão
    //     that will physically separate/ship the order.
    //     For propria: same galpão as origem. For transferencia: the other galpão.
    const uniqueGalpaoIds = [
      ...new Set(
        (pedidos ?? []).map((p) => p.separacao_galpao_id).filter(Boolean),
      ),
    ];

    // Map galpao_id -> first active empresa_id
    const galpaoToEmpresaMap = new Map<string, string>();
    if (uniqueGalpaoIds.length > 0) {
      const { data: empresasInGalpoes } = await supabase
        .from("siso_empresas")
        .select("id, galpao_id")
        .in("galpao_id", uniqueGalpaoIds)
        .eq("ativo", true);
      for (const emp of empresasInGalpoes ?? []) {
        if (!galpaoToEmpresaMap.has(emp.galpao_id)) {
          galpaoToEmpresaMap.set(emp.galpao_id, emp.id);
        }
      }
    }

    // pedido -> empresa that will separate (used for stock + localizacao)
    const pedidoSepEmpresaMap = new Map<string, string>();
    for (const p of pedidos ?? []) {
      if (p.separacao_galpao_id) {
        const empresaId = galpaoToEmpresaMap.get(p.separacao_galpao_id);
        if (empresaId) {
          pedidoSepEmpresaMap.set(p.id, empresaId);
          continue;
        }
      }
      // Fallback: use empresa_origem if separacao_galpao_id is missing
      if (p.empresa_origem_id) {
        pedidoSepEmpresaMap.set(p.id, p.empresa_origem_id);
      }
    }

    // 3. Fetch localizacao + stock from siso_pedido_item_estoques
    const { data: estoques } = await supabase
      .from("siso_pedido_item_estoques")
      .select("pedido_id, produto_id, empresa_id, localizacao, saldo, disponivel")
      .in("pedido_id", pedido_ids);

    // Build localizacao + stock maps (separating empresa only)
    const locMap = new Map<string, string>();
    const stockMap = new Map<string, { saldo: number; disponivel: number }>();
    for (const e of estoques ?? []) {
      const sepEmpresa = pedidoSepEmpresaMap.get(e.pedido_id);
      if (e.empresa_id === sepEmpresa) {
        const key = `${e.pedido_id}:${e.produto_id}`;
        if (e.localizacao) locMap.set(key, e.localizacao);
        stockMap.set(key, {
          saldo: e.saldo ?? 0,
          disponivel: e.disponivel ?? 0,
        });
      }
    }

    // 3b. Fetch galpao name for separating empresas (needed for stock adjustment calls)
    const uniqueEmpresaIds = Array.from(new Set(pedidoSepEmpresaMap.values()));
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

    // 4. Shape response (empresa_origem_id = separating empresa for location updates)
    const visibleItems = (items ?? []).filter((item) => {
      const pedidoStatus = pedidoStatusMap.get(item.pedido_id);
      if (pedidoStatus === "aguardando_compra") {
        return item.compra_status == null;
      }

      return item.compra_status !== "indisponivel" && item.compra_status !== "cancelado";
    });

    const result = visibleItems.map((item) => {
      const sepEmpresaId = pedidoSepEmpresaMap.get(item.pedido_id) ?? null;
      return {
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
        empresa_origem_id: sepEmpresaId,
        galpao_nome: galpaoMap.get(sepEmpresaId ?? "") ?? null,
      };
    });

    return NextResponse.json({ items: result });
  } catch (err) {
    logger.error("checklist-items", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
