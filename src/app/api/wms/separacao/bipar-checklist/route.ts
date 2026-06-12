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
        "id, pedido_id, produto_id, sku, quantidade_pedida, quantidade_pega, separacao_parcial, mov_saida_id, produto_wms_substituto_id",
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
    // ⚠ Race de double-tap permanece: o guard lê mov_saida_id ANTES do pick;
    // dois requests simultâneos pro mesmo item podem emitir 2 pares L+S.
    let movsGeradas = 0;
    const movSaidaIds: Record<string, string> = {};
    // Fail-loud (SEP-02): item cujo pick falhou/não rolou NÃO é marcado como
    // pego — senão a peça sai fisicamente sem S no ledger (overselling).
    const pickFalhas = new Map<string, string>(); // item.id → motivo
    for (const item of itemsFull ?? []) {
      if (!permitidos.has(item.pedido_id as string)) continue; // status terminal
      if (item.separacao_parcial) continue; // parcial usa fluxo separado
      if (item.mov_saida_id) continue; // já picado anteriormente (retry-safe)
      const qtyJaPega = Number(item.quantidade_pega ?? 0);
      const qtyADescontar = Number(item.quantidade_pedida ?? 0) - qtyJaPega;
      if (qtyADescontar <= 0) continue; // já 100% pego — marca sem nova mov
      const ctx = ctxMap.get(item.pedido_id as string);
      if (!ctx || !ctx.empresa || !ctx.galpao) {
        logger.error("separacao-bipar-checklist", "pedido sem empresa/galpão — item NÃO marcado", {
          pedido_item_id: item.id,
          pedido_id: item.pedido_id,
          sku,
        });
        pickFalhas.set(
          String(item.id),
          "pedido sem empresa/galpão — não é possível dar baixa no estoque",
        );
        continue;
      }

      try {
        const result = await pickMovPicking({
          empresa_origem_id: ctx.empresa,
          galpao_id: ctx.galpao,
          pedido_id: String(item.pedido_id),
          pedido_numero: ctx.numero,
          item_id: Number(item.id),
          produto_id_tiny: String(item.produto_id),
          produto_wms_substituto_id: item.produto_wms_substituto_id ?? null,
          sku: String(item.sku),
          qty: qtyADescontar,
          usuario_id: session.id,
          contexto: "checklist",
        });
        if (result) {
          movsGeradas++;
          movSaidaIds[String(item.id)] = result.movSaidaId;
        } else {
          // null silencioso do helper (contexto incompleto) — sem S, não marca.
          logger.error("separacao-bipar-checklist", "pickMovPicking retornou null — item NÃO marcado", {
            pedido_item_id: item.id,
            pedido_id: item.pedido_id,
            sku,
          });
          pickFalhas.set(
            String(item.id),
            "baixa de estoque não confirmada (pick não gerou movimentação)",
          );
        }
      } catch (wmsErr) {
        const msg = wmsErr instanceof Error ? wmsErr.message : String(wmsErr);
        logger.logError({
          error: wmsErr instanceof Error ? wmsErr : new Error(msg),
          source: "separacao-bipar-checklist",
          message: "pickMovPicking falhou — item NÃO marcado",
          category: "business_logic",
          metadata: { pedido_item_id: item.id, pedido_id: item.pedido_id, sku },
        });
        pickFalhas.set(String(item.id), msg);
      }
    }

    // Marca os itens com baixa confirmada (atualiza separacao_marcado, qty_pega,
    // mov_saida_id). Pula itens em pedidos com status terminal, itens em parcial
    // (preserva qty_pega) e itens cujo pick falhou (fail-loud — ficam pendentes
    // pro operador re-bipar após resolver o erro).
    const itensMarcadosIds: Array<string | number> = [];
    for (const item of itemsFull ?? []) {
      if (!permitidos.has(item.pedido_id as string)) continue;
      if (item.separacao_parcial) continue;
      if (pickFalhas.has(String(item.id))) continue;
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

    logger.info("separacao-bipar-checklist", "Items marcados via bip", {
      sku,
      pedido_ids,
      items_encontrados: itemIds.length,
      items_marcados: itensMarcadosIds.length,
      items_skipados_status: itensSkipStatus,
      items_nao_bipados: pickFalhas.size,
      movs_geradas: movsGeradas,
    });

    // Fail-loud: algum pick falhou → 422 com o motivo por item. Os itens que
    // tiveram baixa OK JÁ foram marcados acima; os falhos seguem pendentes no
    // checklist pro operador re-bipar. A UI surfaça `error` no scanFeedback.
    if (pickFalhas.size > 0) {
      const naoBipados = [...pickFalhas.entries()].map(([itemId, motivo]) => {
        const it = (itemsFull ?? []).find((i) => String(i.id) === itemId);
        return {
          item_id: itemId,
          pedido_id: (it?.pedido_id as string | undefined) ?? null,
          sku: (it?.sku as string | undefined) ?? null,
          motivo,
        };
      });
      const head =
        itensMarcadosIds.length > 0
          ? `${itensMarcadosIds.length} item(ns) bipado(s); ${naoBipados.length} sem baixa de estoque`
          : "Falha ao dar baixa no estoque — nenhum item bipado";
      return NextResponse.json(
        {
          error: `${head}: ${naoBipados[0].motivo}`,
          nao_bipados: naoBipados,
          itens_marcados: itensMarcadosIds.length,
        },
        { status: 422 },
      );
    }

    const { data: updated } = await supabase
      .from("siso_pedido_itens")
      .select()
      .in("id", itensMarcadosIds.length > 0 ? itensMarcadosIds : itemIds);

    return NextResponse.json(updated ?? []);
  } catch (err) {
    logger.error("separacao-bipar-checklist", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
