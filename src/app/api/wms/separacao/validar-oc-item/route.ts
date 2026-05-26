import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";
import { registrarEvento } from "@/lib/historico-service";

/**
 * POST /api/separacao/validar-oc-item
 *
 * Handles OC item validation during the validacao_oc phase.
 * Two actions:
 *   - "encontrei": item was found physically → clear compra fields + mark as picked
 *   - "esgotado": item confirmed missing → send to compras (aguardando_compra)
 *
 * After processing, auto-transitions pedidos when all OC items are resolved:
 *   - FR-9: all found → decisao propria, status aguardando_separacao
 *   - FR-8: all esgotado + 100% OC → status aguardando_compra
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const itemIds: unknown = body?.item_ids;
  const acao: unknown = body?.acao;

  if (
    !Array.isArray(itemIds) ||
    itemIds.length === 0 ||
    !itemIds.every((id) => typeof id === "string" || typeof id === "number")
  ) {
    return NextResponse.json(
      { error: "item_ids deve ser um array de strings não vazio" },
      { status: 400 },
    );
  }

  // Normalize to strings (Supabase returns integer PKs as numbers)
  const normalizedIds = itemIds.map((id) => String(id));

  if (acao !== "encontrei" && acao !== "esgotado" && acao !== "desfazer_encontrei") {
    return NextResponse.json(
      { error: "acao deve ser 'encontrei', 'esgotado' ou 'desfazer_encontrei'" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    // Fetch the target items with necessary fields
    const { data: items, error: fetchErr } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, sku, quantidade_pedida, quantidade_pega, compra_status, fornecedor_oc",
      )
      .in("id", normalizedIds);

    if (fetchErr) {
      logger.logError({
        error: fetchErr,
        source: "validar-oc-item",
        message: "Erro ao buscar itens",
        category: "database",
      });
      return NextResponse.json(
        { error: "Erro ao buscar itens" },
        { status: 500 },
      );
    }

    if (!items || items.length === 0) {
      return NextResponse.json(
        { error: "Nenhum item encontrado" },
        { status: 404 },
      );
    }

    const now = new Date().toISOString();
    let itensAtualizados = 0;

    // ─── Process each item ──────────────────────────────────────
    if (acao === "encontrei") {
      for (const item of items) {
        const { error: updErr } = await supabase
          .from("siso_pedido_itens")
          .update({
            compra_status: null,
            fornecedor_oc: null,
            compra_quantidade_solicitada: null,
            compra_solicitada_em: null,
            ordem_compra_id: null,
            separacao_marcado: true,
            bipado_completo: true,
            quantidade_bipada: Number(item.quantidade_pedida ?? 0),
          })
          .eq("id", item.id);

        if (updErr) {
          logger.logError({
            error: updErr,
            source: "validar-oc-item",
            message: `Erro ao atualizar item ${item.id} (encontrei)`,
            category: "database",
          });
          continue;
        }
        itensAtualizados++;

        // Fire-and-forget history
        registrarEvento({
          pedidoId: item.pedido_id,
          evento: "oc_item_encontrado",
          usuarioId: user.id,
          usuarioNome: user.nome,
          detalhes: { sku: item.sku, item_id: item.id },
        });
      }
    } else if (acao === "desfazer_encontrei") {
      // Undo "encontrei" — restore item to oc_pendente
      for (const item of items) {
        const fornecedorInfo = getFornecedorBySku(item.sku);

        const { error: updErr } = await supabase
          .from("siso_pedido_itens")
          .update({
            compra_status: "oc_pendente",
            fornecedor_oc: fornecedorInfo.fornecedor,
            compra_quantidade_solicitada: null,
            compra_solicitada_em: null,
            ordem_compra_id: null,
            separacao_marcado: false,
            bipado_completo: false,
            quantidade_bipada: 0,
          })
          .eq("id", item.id);

        if (updErr) {
          logger.logError({
            error: updErr,
            source: "validar-oc-item",
            message: `Erro ao atualizar item ${item.id} (desfazer_encontrei)`,
            category: "database",
          });
          continue;
        }
        itensAtualizados++;

        registrarEvento({
          pedidoId: item.pedido_id,
          evento: "oc_item_desfazer_encontrado",
          usuarioId: user.id,
          usuarioNome: user.nome,
          detalhes: { sku: item.sku, item_id: item.id },
        });
      }
    } else {
      // acao === "esgotado"
      for (const item of items) {
        const fornecedorInfo = getFornecedorBySku(item.sku);

        // Qty efetiva = pedida - já pegada (parcial) - picadas em realocações.
        // Sem essa dedução, marcar "esgotado" pediria pra OC qty que já foi
        // separada fisicamente, gerando overstock no recebimento.
        const qtyJaPega = Number(item.quantidade_pega ?? 0);
        const { data: realocs } = await supabase
          .from("siso_pedido_item_realocacoes")
          .select("qty_picada")
          .eq("pedido_item_id", item.id)
          .eq("status", "picado");
        const qtyRealocsPicadas = (realocs ?? []).reduce(
          (acc, r) => acc + Number(r.qty_picada ?? 0),
          0,
        );
        const qtyEfetiva = Math.max(
          0,
          Number(item.quantidade_pedida ?? 0) - qtyJaPega - qtyRealocsPicadas,
        );

        if (qtyEfetiva === 0) {
          // Item totalmente coberto — não dá pra marcar esgotado
          return NextResponse.json(
            {
              error:
                "item já totalmente coberto — não pode ser marcado esgotado",
              item_id: item.id,
              sku: item.sku,
              qty_pedida: Number(item.quantidade_pedida ?? 0),
              qty_ja_pega: qtyJaPega,
              qty_realocs_picadas: qtyRealocsPicadas,
            },
            { status: 409 },
          );
        }

        // Update item to aguardando_compra — usando qty efetiva
        const { error: updErr } = await supabase
          .from("siso_pedido_itens")
          .update({
            compra_status: "aguardando_compra",
            compra_quantidade_solicitada: qtyEfetiva,
            compra_solicitada_em: now,
            fornecedor_oc: item.fornecedor_oc || fornecedorInfo.fornecedor,
          })
          .eq("id", item.id);

        if (updErr) {
          logger.logError({
            error: updErr,
            source: "validar-oc-item",
            message: `Erro ao atualizar item ${item.id} (esgotado)`,
            category: "database",
          });
          continue;
        }

        // Find or create OC for this item
        const fornecedor = item.fornecedor_oc || fornecedorInfo.fornecedor;
        await linkItemToOC(supabase, item, fornecedor);

        itensAtualizados++;

        registrarEvento({
          pedidoId: item.pedido_id,
          evento: "oc_item_confirmado",
          usuarioId: user.id,
          usuarioNome: user.nome,
          detalhes: {
            sku: item.sku,
            item_id: item.id,
            fornecedor,
            qty_pedida: Number(item.quantidade_pedida ?? 0),
            qty_ja_pega: qtyJaPega,
            qty_realocs_picadas: qtyRealocsPicadas,
            qty_efetiva: qtyEfetiva,
          },
        });
      }
    }

    // ─── Auto-transitions per pedido ────────────────────────────
    const affectedPedidoIds = [...new Set(items.map((i) => i.pedido_id as string))];
    const transicoes: Array<{ pedido_id: string; novo_status: string }> = [];

    for (const pedidoId of affectedPedidoIds) {
      // Fetch ALL items for this pedido to evaluate transitions
      const { data: allItems } = await supabase
        .from("siso_pedido_itens")
        .select("id, compra_status")
        .eq("pedido_id", pedidoId);

      if (!allItems) continue;

      const hasOcPendente = allItems.some((i) => i.compra_status === "oc_pendente");

      // Fetch current pedido status
      const { data: pedido } = await supabase
        .from("siso_pedidos")
        .select("id, status_separacao, decisao_final")
        .eq("id", pedidoId)
        .single();

      if (!pedido) continue;

      if (acao === "desfazer_encontrei" && hasOcPendente) {
        // Revert decisao_final back to "oc" if it was flipped to "propria"
        if (pedido.decisao_final === "propria") {
          await supabase
            .from("siso_pedidos")
            .update({ decisao_final: "oc" })
            .eq("id", pedidoId);
        }
        continue;
      }

      if (hasOcPendente) continue; // Still has unresolved OC items — no transition

      const compraItems = allItems.filter(
        (i) => i.compra_status === "aguardando_compra" || i.compra_status === "comprado",
      );
      const normalItems = allItems.filter((i) => i.compra_status === null);

      if (compraItems.length === 0) {
        // FR-9: All OC items found → flip decisao to propria
        const updates: Record<string, unknown> = {
          decisao_final: "propria",
        };
        if (pedido.status_separacao === "validacao_oc") {
          updates.status_separacao = "aguardando_separacao";
        }
        // If em_separacao, keep as is

        await supabase
          .from("siso_pedidos")
          .update(updates)
          .eq("id", pedidoId);

        if (updates.status_separacao) {
          transicoes.push({
            pedido_id: pedidoId,
            novo_status: updates.status_separacao as string,
          });
        }
      } else if (normalItems.length === 0) {
        // FR-8: 100% OC pedido, all now aguardando_compra → transition
        await supabase
          .from("siso_pedidos")
          .update({
            status_separacao: "aguardando_compra",
            separacao_operador_id: null,
            separacao_iniciada_em: null,
          })
          .eq("id", pedidoId);

        transicoes.push({
          pedido_id: pedidoId,
          novo_status: "aguardando_compra",
        });
      }
      // Mixed (some compra, some normal) — no auto-transition here,
      // concluir/route.ts handles this when operator finishes picking normal items
    }

    logger.info("validar-oc-item", `${acao}: ${itensAtualizados} itens atualizados`, {
      acao,
      item_ids: normalizedIds,
      transicoes,
      operador: user.nome,
    });

    return NextResponse.json({
      itens_atualizados: itensAtualizados,
      transicoes,
    });
  } catch (err) {
    logger.logError({
      error: err,
      source: "validar-oc-item",
      message: "Erro inesperado",
      category: "business_logic",
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

// ─── Helper: find or create OC and link item ────────────────────────────────

async function linkItemToOC(
  supabase: ReturnType<typeof createServiceClient>,
  item: { id: string; pedido_id: string; sku: string | null },
  fornecedor: string,
) {
  try {
    // Get empresa from pedido
    const { data: pedido } = await supabase
      .from("siso_pedidos")
      .select("empresa_origem_id")
      .eq("id", item.pedido_id)
      .single();

    const empresaId = pedido?.empresa_origem_id;
    if (!empresaId) {
      logger.warn("validar-oc-item", "Pedido sem empresa_origem_id — OC não vinculada", {
        pedidoId: item.pedido_id,
        itemId: item.id,
      });
      return;
    }

    // Resolve galpao_id from empresa
    const { data: empresa } = await supabase
      .from("siso_empresas")
      .select("galpao_id")
      .eq("id", empresaId)
      .single();

    const galpaoId = empresa?.galpao_id ?? null;

    // Look for existing draft OC by fornecedor + galpao
    let existingOCQuery = supabase
      .from("siso_ordens_compra")
      .select("id")
      .eq("fornecedor", fornecedor)
      .eq("status", "aguardando_compra")
      .limit(1);

    if (galpaoId) {
      existingOCQuery = existingOCQuery.eq("galpao_id", galpaoId);
    } else {
      existingOCQuery = existingOCQuery.eq("empresa_id", empresaId);
    }

    const { data: existingOC } = await existingOCQuery.maybeSingle();

    let ordemCompraId: string | null = null;

    if (existingOC) {
      ordemCompraId = existingOC.id;
    } else {
      const { data: newOC, error: ocError } = await supabase
        .from("siso_ordens_compra")
        .insert({
          fornecedor,
          galpao_id: galpaoId,
          empresa_id: empresaId,
          status: "aguardando_compra",
          observacao: `Criada automaticamente — validação OC SKU ${item.sku}`,
        })
        .select("id")
        .single();

      if (ocError) {
        logger.warn("validar-oc-item", "Erro ao criar OC automática", {
          error: ocError.message,
          fornecedor,
          empresaId,
        });
        return;
      }
      ordemCompraId = newOC.id;
    }

    if (ordemCompraId) {
      await supabase
        .from("siso_pedido_itens")
        .update({ ordem_compra_id: ordemCompraId })
        .eq("id", item.id);
    }
  } catch (err) {
    logger.warn("validar-oc-item", "Erro ao vincular item a OC (não-crítico)", {
      error: err instanceof Error ? err.message : String(err),
      itemId: item.id,
    });
  }
}
