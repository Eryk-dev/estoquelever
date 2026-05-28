import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

export interface CrossDockSplit {
  qty_cross_dock: number;
  qty_guarda_normal: number;
  /** IDs (text) dos pedidos que o batch cross-dock fecha 100% (FIFO por aging). */
  pedidos_vinculados: string[];
  /** Loc PACKING desse galpão (destino sugerido pra pendência cross-dock). */
  loc_packing_id: string | null;
}

/**
 * Decisão 7 (28/05): cross-dock prioriza demanda viva por SKU+OC.
 *
 * Detecta pedidos com itens dessa OC ainda esperando entrega (`compra_status
 * IN ('aguardando_compra','comprado')`), aloca FIFO sem fragmentar (pedido
 * só conta se a qty recebida cobre 100% do que ele esperava), e retorna o
 * split entre qty_cross_dock (vai pra PACKING) e qty_guarda_normal (resto).
 *
 * Em galpões sem loc PACKING (raro), retorna qty_cross_dock=0 — fallback
 * pra 1 pendência normal só. Loga warning.
 */
export async function detectarCrossDock(args: {
  produto_id: string;
  galpao_id: string;
  qty_recebida: number;
  ordem_compra_id: string;
}): Promise<CrossDockSplit> {
  const supabase = createServiceClient();

  // Items dessa OC ainda esperando entrega (incluindo o que acabou de chegar
  // — o compra_quantidade_recebida já foi atualizado, mas itens com
  // compra_status='comprado' continuam aguardando até serem encaminhados pra
  // separação. Filtramos pelos não-completos via qty_recebida < qty_solicitada).
  const { data: itens } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, pedido_id, sku, produto_id, quantidade_pedida, compra_quantidade_solicitada, compra_quantidade_recebida, compra_status, ordem_compra_id",
    )
    .eq("ordem_compra_id", args.ordem_compra_id)
    .in("compra_status", ["comprado", "aguardando_compra"]);

  // Resolve tiny_produto_id pra match com siso_pedido_itens.produto_id (bigint)
  const { data: mapping } = await supabase
    .from("siso_produto_empresas")
    .select("tiny_produto_id")
    .eq("produto_id", args.produto_id);
  const tinyIds = new Set(
    (mapping ?? []).map((m) => String(m.tiny_produto_id)),
  );

  const candidatos = (itens ?? []).filter((it) =>
    tinyIds.has(String(it.produto_id)),
  );

  // Loc PACKING desse galpão
  const { data: locPacking } = await supabase
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", args.galpao_id)
    .eq("tipo", "packing")
    .eq("ativo", true)
    .maybeSingle();

  if (!locPacking) {
    logger.warn("crossdock-detector", "sem loc PACKING no galpão — pula cross-dock", {
      galpao_id: args.galpao_id,
    });
    return {
      qty_cross_dock: 0,
      qty_guarda_normal: args.qty_recebida,
      pedidos_vinculados: [],
      loc_packing_id: null,
    };
  }

  // FIFO por aging (pedido mais antigo primeiro — uuid sort não é cronológico,
  // mas pedido_id em texto começa com timestamp Tiny / é estritamente crescente
  // pra venda manual). Boa aproximação sem precisar JOIN com created_at.
  const ordenados = candidatos.sort((a, b) =>
    String(a.pedido_id).localeCompare(String(b.pedido_id)),
  );

  let qtyRestante = args.qty_recebida;
  const pedidosVinculados: string[] = [];
  for (const it of ordenados) {
    if (qtyRestante <= 0) break;
    const qtyItem = Math.max(
      0,
      Number(it.compra_quantidade_solicitada ?? it.quantidade_pedida ?? 0) -
        Number(it.compra_quantidade_recebida ?? 0),
    );
    if (qtyItem <= 0) continue;
    if (qtyItem > qtyRestante) {
      // Pedido só vai se 100% completo — não fragmenta
      continue;
    }
    qtyRestante -= qtyItem;
    const pedId = String(it.pedido_id);
    if (!pedidosVinculados.includes(pedId)) {
      pedidosVinculados.push(pedId);
    }
  }

  const qtyCross = args.qty_recebida - qtyRestante;
  const qtyNormal = qtyRestante;

  return {
    qty_cross_dock: qtyCross,
    qty_guarda_normal: qtyNormal,
    pedidos_vinculados: pedidosVinculados,
    loc_packing_id: locPacking.id as string,
  };
}
