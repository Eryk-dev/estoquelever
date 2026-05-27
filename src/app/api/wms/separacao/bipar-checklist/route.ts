import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { pickMovPicking } from "@/lib/wms/separacao/pick-mov";

/**
 * POST /api/separacao/bipar-checklist
 *
 * Scan a barcode during wave-picking to auto-check matching items
 * across the given pedidos.
 *
 * Body: { sku: string, pedido_ids: string[] }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (
    !body?.sku ||
    typeof body.sku !== "string" ||
    !body?.pedido_ids ||
    !Array.isArray(body.pedido_ids) ||
    body.pedido_ids.length === 0
  ) {
    return NextResponse.json(
      { error: "'sku' (string) e 'pedido_ids' (string[]) sao obrigatorios" },
      { status: 400 },
    );
  }

  const { sku, pedido_ids } = body as {
    sku: string;
    pedido_ids: string[];
  };

  const supabase = createServiceClient();

  try {
    // Find matching items by SKU within the given pedidos, not yet marked
    let { data: items, error: fetchError } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, sku, gtin, compra_status")
      .in("pedido_id", pedido_ids)
      .eq("separacao_marcado", false)
      .eq("sku", sku);

    // If no SKU match, try GTIN match
    if (!fetchError && (!items || items.length === 0)) {
      const gtinResult = await supabase
        .from("siso_pedido_itens")
        .select("id, pedido_id, sku, gtin, compra_status")
        .in("pedido_id", pedido_ids)
        .eq("separacao_marcado", false)
        .eq("gtin", sku);
      items = gtinResult.data;
      fetchError = gtinResult.error;
    }

    if (fetchError) {
      logger.error("separacao-bipar-checklist", "Failed to fetch items", {
        error: fetchError.message,
      });
      return NextResponse.json(
        { error: fetchError.message },
        { status: 500 },
      );
    }

    items = (items ?? []).filter((item) => item.compra_status !== "cancelado");

    if (!items || items.length === 0) {
      return NextResponse.json(
        { error: "Nenhum item encontrado com este SKU/GTIN nos pedidos selecionados" },
        { status: 404 },
      );
    }

    const itemIds = items.map((i) => i.id);
    const now = new Date().toISOString();

    // Carrega contexto adicional dos pedidos (empresa, galpao, numero, status_separacao)
    const pedidoIdsAfetados = [...new Set(items.map((i) => i.pedido_id as string))];
    const { data: pedidosCtx } = await supabase
      .from("siso_pedidos")
      .select("id, numero, empresa_origem_id, separacao_galpao_id, status_separacao")
      .in("id", pedidoIdsAfetados);
    const ctxMap = new Map<string, { numero: string; empresa: string | null; galpao: string | null }>(
      (pedidosCtx ?? []).map((p) => [
        p.id as string,
        {
          numero: (p.numero as string) ?? "",
          empresa: (p.empresa_origem_id as string | null) ?? null,
          galpao: (p.separacao_galpao_id as string | null) ?? null,
        },
      ]),
    );

    // Guard: status do pedido permite marcar?
    // Mirrors marcar-item — pedidos em status terminal (separado/embalado/expedido)
    // não podem receber bipe (dupla baixa pós-cutover).
    const ALLOWED_STATUS = [
      "em_separacao",
      "aguardando_separacao",
      "aguardando_compra",
      "pendente_realocacao",
    ];
    const permitidos = new Set<string>(
      (pedidosCtx ?? [])
        .filter((p) => ALLOWED_STATUS.includes((p.status_separacao as string | null) ?? ""))
        .map((p) => p.id as string),
    );

    // Carrega produto_id (tiny bigint) + quantidade_pedida + mov_saida_id por item pra mov
    const { data: itemsFull } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, quantidade_pedida, quantidade_pega, separacao_parcial, mov_saida_id",
      )
      .in("id", itemIds);

    // Conta itens skipados por status — log warn se houver
    const itensSkipStatus = (itemsFull ?? []).filter(
      (i) => !permitidos.has(i.pedido_id as string),
    ).length;
    if (itensSkipStatus > 0) {
      logger.warn("separacao-bipar-checklist", "itens skipados por status do pedido", {
        count: itensSkipStatus,
        sku,
      });
    }

    // Por item: emite par S+L via pickMovPicking (helper NÃO é idempotente —
    // guard via mov_saida_id no item pra evitar dupla baixa em retry).
    let movsGeradas = 0;
    const movSaidaIds: Record<string, string> = {};
    for (const item of itemsFull ?? []) {
      if (!permitidos.has(item.pedido_id as string)) continue; // status terminal
      if (item.separacao_parcial) continue; // parcial usa fluxo separado
      if (item.mov_saida_id) continue; // já picado anteriormente (retry-safe)
      const ctx = ctxMap.get(item.pedido_id as string);
      if (!ctx) continue;
      const qtyJaPega = Number(item.quantidade_pega ?? 0);
      const qtyADescontar = Number(item.quantidade_pedida ?? 0) - qtyJaPega;
      if (qtyADescontar <= 0) continue;

      try {
        const result = await pickMovPicking({
          empresa_origem_id: ctx.empresa,
          galpao_id: ctx.galpao,
          pedido_id: String(item.pedido_id),
          pedido_numero: ctx.numero,
          item_id: Number(item.id),
          produto_id_tiny: String(item.produto_id),
          sku: String(item.sku),
          qty: qtyADescontar,
          usuario_id: session.id,
          contexto: "checklist",
        });
        if (result) {
          movsGeradas++;
          movSaidaIds[String(item.id)] = result.movSaidaId;
        }
      } catch (wmsErr) {
        logger.warn("separacao-bipar-checklist", "pickMovPicking falhou (continua marcando)", {
          error: wmsErr instanceof Error ? wmsErr.message : String(wmsErr),
          pedido_item_id: item.id,
        });
      }
    }

    // Marca todos os itens (atualiza separacao_marcado, qty_pega, mov_saida_id).
    // Pula itens em pedidos com status terminal e itens em parcial (preserva qty_pega).
    const itensMarcadosIds: Array<string | number> = [];
    for (const item of itemsFull ?? []) {
      if (!permitidos.has(item.pedido_id as string)) continue;
      if (item.separacao_parcial) continue;
      const updates: Record<string, unknown> = {
        separacao_marcado: true,
        separacao_marcado_em: now,
        quantidade_pega: item.quantidade_pedida,
      };
      const movId = movSaidaIds[String(item.id)];
      if (movId) updates.mov_saida_id = movId;
      await supabase.from("siso_pedido_itens").update(updates).eq("id", item.id);
      itensMarcadosIds.push(item.id as string | number);
    }

    const { data: updated } = await supabase
      .from("siso_pedido_itens")
      .select()
      .in("id", itensMarcadosIds.length > 0 ? itensMarcadosIds : itemIds);

    logger.info("separacao-bipar-checklist", "Items marcados via bip", {
      sku,
      pedido_ids,
      items_encontrados: itemIds.length,
      items_marcados: itensMarcadosIds.length,
      items_skipados_status: itensSkipStatus,
      movs_geradas: movsGeradas,
    });

    return NextResponse.json(updated ?? []);
  } catch (err) {
    logger.error("separacao-bipar-checklist", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
