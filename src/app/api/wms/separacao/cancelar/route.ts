import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { estornarMovimentacao } from "@/lib/wms/ledger";

/**
 * POST /api/separacao/cancelar
 *
 * Cancel an in-progress separation: resets all item checkmarks
 * and moves pedidos back to their correct status.
 * Pedidos with pending compra items return to 'aguardando_compra'.
 * All others return to 'aguardando_separacao'.
 *
 * Also:
 * - Estorna mov_saida_id para cada item (NÃO estorna mov_ajuste_loc_zerou_id — reflete descoberta física)
 * - Estorna movs de realocações já picadas
 * - Cancela realocações em qualquer status (exceto já cancelado)
 * - Reseta campos novos: separacao_parcial, parcial_*, quantidade_pega, mov_saida_id, mov_ajuste_loc_zerou_id
 *
 * Body: { pedido_ids: string[] }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (
    !body?.pedido_ids ||
    !Array.isArray(body.pedido_ids) ||
    body.pedido_ids.length === 0 ||
    !body.pedido_ids.every((id: unknown) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "'pedido_ids' (string[]) é obrigatório" },
      { status: 400 },
    );
  }

  const { pedido_ids } = body as { pedido_ids: string[] };
  const supabase = createServiceClient();

  try {
    // 1. Carrega itens com movs para estornar
    const { data: itensComMovs } = await supabase
      .from("siso_pedido_itens")
      .select("id, mov_saida_id, mov_ajuste_loc_zerou_id, separacao_parcial")
      .in("pedido_id", pedido_ids);

    const itemIds = (itensComMovs ?? []).map((i) => i.id);

    // Estorna mov_saida via tabela ponte (dedupe por mov_id pra evitar double-estorno
    // quando a mesma mov foi rateada entre N items do mesmo pedido).
    // mov_ajuste_loc_zerou NÃO é estornado por design (reflete descoberta física).
    const { data: links } = itemIds.length > 0
      ? await supabase
          .from("siso_pedido_item_mov_links")
          .select("mov_id, tipo_link, qty, pedido_item_id")
          .in("pedido_item_id", itemIds)
      : { data: [] };

    const movsSaidaSet = new Set<string>();
    for (const l of links ?? []) {
      if (l.tipo_link === "saida") movsSaidaSet.add(l.mov_id as string);
    }
    // Fallback legacy: items sem links mas com mov_saida_id (criados pré-fix-pack)
    for (const it of itensComMovs ?? []) {
      if (it.mov_saida_id) movsSaidaSet.add(it.mov_saida_id as string);
    }

    for (const movId of movsSaidaSet) {
      try {
        await estornarMovimentacao({
          mov_id: movId,
          usuario_id: session.id,
          observacoes: "Cancelar separação — estorno automático",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("ja foi estornada")) {
          logger.warn("separacao-cancelar", "Estorno mov_saida falhou", {
            mov_id: movId,
            error: msg,
          });
        }
      }
    }

    // Apaga links do(s) item(s) (estornados acima + ajuste_loc_zerou)
    if (itemIds.length > 0) {
      await supabase
        .from("siso_pedido_item_mov_links")
        .delete()
        .in("pedido_item_id", itemIds);
    }

    // Realocações: estorna picadas, cancela aguardando_picking e demais
    const { data: realocs } = itemIds.length > 0
      ? await supabase
          .from("siso_pedido_item_realocacoes")
          .select("id, status, mov_saida_id, pedido_item_id")
          .in("pedido_item_id", itemIds)
      : { data: [] };

    // Estorna mov_saida_id de realocações 'picado' E 'picado_parcial' que NÃO
    // foram estornadas via tabela ponte acima (fallback legacy pra realocs antigos).
    // mov_ajuste_loc_zerou_id da realoc NÃO é estornada (mesmo design do item: reflete descoberta física).
    for (const r of realocs ?? []) {
      const precisaEstornar = r.status === "picado" || r.status === "picado_parcial";
      if (precisaEstornar && r.mov_saida_id && !movsSaidaSet.has(r.mov_saida_id)) {
        try {
          await estornarMovimentacao({
            mov_id: r.mov_saida_id,
            usuario_id: session.id,
            observacoes: `Cancelar separação — estorno realocação ${r.status}`,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("ja foi estornada")) {
            logger.warn("separacao-cancelar", "Estorno realocação falhou", {
              realocacao_id: r.id,
              status: r.status,
              error: msg,
            });
          }
        }
      }
    }

    if (itemIds.length > 0) {
      await supabase
        .from("siso_pedido_item_realocacoes")
        .update({ status: "cancelado" })
        .in("pedido_item_id", itemIds)
        .neq("status", "cancelado");
    }

    // 2. Reset all item checkmarks + parcial fields for the given pedidos
    const { error: itemsError } = await supabase
      .from("siso_pedido_itens")
      .update({
        separacao_marcado: false,
        separacao_marcado_em: null,
        separacao_parcial: false,
        parcial_motivo: null,
        parcial_em: null,
        parcial_por: null,
        quantidade_pega: null,
        mov_saida_id: null,
        mov_ajuste_loc_zerou_id: null,
      })
      .in("pedido_id", pedido_ids);

    if (itemsError) {
      logger.error("separacao-cancelar", "Failed to reset items", {
        error: itemsError.message,
      });
      return NextResponse.json(
        { error: itemsError.message },
        { status: 500 },
      );
    }

    // 3. Find pedidos with compra items to decide return status
    const { data: compraRows } = await supabase
      .from("siso_pedido_itens")
      .select("pedido_id, compra_status")
      .in("pedido_id", pedido_ids)
      .not("compra_status", "is", null)
      .neq("compra_status", "recebido");

    // Group compra_status values by pedido_id
    const pedidoCompraMap = new Map<string, Set<string>>();
    for (const row of compraRows ?? []) {
      if (!pedidoCompraMap.has(row.pedido_id)) {
        pedidoCompraMap.set(row.pedido_id, new Set());
      }
      pedidoCompraMap.get(row.pedido_id)!.add(row.compra_status);
    }

    // Classify: oc_pendente takes priority → validacao_oc; other compra → aguardando_compra; else → aguardando_separacao
    const ocPendenteIds: string[] = [];
    const compraIds: string[] = [];
    const nonCompraIds: string[] = [];

    for (const id of pedido_ids) {
      const statuses = pedidoCompraMap.get(id);
      if (statuses?.has("oc_pendente")) {
        ocPendenteIds.push(id);
      } else if (statuses && statuses.size > 0) {
        compraIds.push(id);
      } else {
        nonCompraIds.push(id);
      }
    }

    const resetFields = {
      separacao_operador_id: null,
      separacao_iniciada_em: null,
    };

    // Reset pedidos with oc_pendente items back to validacao_oc
    if (ocPendenteIds.length > 0) {
      const { error: ocError } = await supabase
        .from("siso_pedidos")
        .update({ ...resetFields, status_separacao: "validacao_oc" })
        .in("id", ocPendenteIds);

      if (ocError) {
        logger.error("separacao-cancelar", "Failed to reset oc_pendente pedidos", {
          error: ocError.message,
        });
        return NextResponse.json({ error: ocError.message }, { status: 500 });
      }
    }

    // Reset pedidos with confirmed compra items back to aguardando_compra
    if (compraIds.length > 0) {
      const { error: compraError } = await supabase
        .from("siso_pedidos")
        .update({ ...resetFields, status_separacao: "aguardando_compra" })
        .in("id", compraIds);

      if (compraError) {
        logger.error("separacao-cancelar", "Failed to reset compra pedidos", {
          error: compraError.message,
        });
        return NextResponse.json({ error: compraError.message }, { status: 500 });
      }
    }

    // Reset remaining pedidos back to aguardando_separacao
    const { error: pedidosError } = nonCompraIds.length > 0
      ? await supabase
          .from("siso_pedidos")
          .update({ ...resetFields, status_separacao: "aguardando_separacao" })
          .in("id", nonCompraIds)
      : { error: null };

    if (pedidosError) {
      logger.error("separacao-cancelar", "Failed to reset pedidos", {
        error: pedidosError.message,
      });
      return NextResponse.json(
        { error: pedidosError.message },
        { status: 500 },
      );
    }

    logger.info("separacao-cancelar", "Separação cancelada", {
      pedido_ids,
      validacao_oc: ocPendenteIds,
      aguardando_compra: compraIds,
      aguardando_separacao: nonCompraIds,
    });

    return NextResponse.json({ ok: true, pedido_ids });
  } catch (err) {
    logger.error("separacao-cancelar", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
