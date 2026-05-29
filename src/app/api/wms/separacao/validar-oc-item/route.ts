import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";
import { registrarEvento } from "@/lib/historico-service";
import { pickMovPicking } from "@/lib/wms/separacao/pick-mov";
import { estornarMovimentacao, inserirMovimentacao } from "@/lib/wms/ledger";
import { resolverProdutoWms } from "@/lib/separacao/wms-mapping";

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
      // Pre-fetch pedido contexto pra cada item (empresa + galpão + numero).
      // Sem isso, não temos como resolver tripla WMS pra emitir o par S+L.
      const pedidoIds = [...new Set(items.map((i) => i.pedido_id as string))];
      const { data: pedidosCtx } = await supabase
        .from("siso_pedidos")
        .select("id, numero, empresa_origem_id, separacao_galpao_id")
        .in("id", pedidoIds);
      const ctxMap = new Map<
        string,
        { numero: string; empresa: string | null; galpao: string | null }
      >(
        (pedidosCtx ?? []).map((p) => [
          p.id as string,
          {
            numero: (p.numero as string) ?? "",
            empresa: (p.empresa_origem_id as string | null) ?? null,
            galpao: (p.separacao_galpao_id as string | null) ?? null,
          },
        ]),
      );

      // Re-fetch items com produto_id (Tiny bigint) + mov_saida_id (pra
      // short-circuit idempotente em retry — clique duplo do operador).
      const { data: itensFull } = await supabase
        .from("siso_pedido_itens")
        .select("id, pedido_id, produto_id, sku, quantidade_pedida, mov_saida_id")
        .in(
          "id",
          items.map((i) => i.id),
        );

      // Decisão 3 (28/05): se o body trouxer localizacao_id (loc bipada pelo
      // operador via modal "Onde você achou?"), é o caminho "Encontrei sem
      // cadastro" — produto não tem nenhuma loc com saldo no galpão. Geramos
      // par E+S na loc indicada. Alternativamente, se o snapshot já tem loc
      // salva via /separacao/localizacao, usamos essa.
      const locManualBody =
        typeof body?.localizacao_id === "string" ? body.localizacao_id : null;

      for (const item of itensFull ?? []) {
        // Idempotência: item já picado anteriormente — pula pickMovPicking
        // pra evitar dupla baixa em retry. O update abaixo é safe (mesmos
        // campos, sem regredir estado).
        const jaPicado = Boolean(item.mov_saida_id);

        const ctx = ctxMap.get(item.pedido_id as string);
        let movSaidaId: string | null = null;
        if (!jaPicado && ctx && ctx.galpao && ctx.empresa) {
          const qty = Number(item.quantidade_pedida ?? 0);

          // Verifica se produto tem alguma loc com saldo no galpão
          const produtoWmsId = await resolverProdutoWms(
            ctx.empresa,
            String(item.produto_id),
          );
          const { data: locsExistentes } = await supabase
            .from("siso_estoque")
            .select("localizacao_id")
            .eq("produto_id", produtoWmsId)
            .eq("galpao_id", ctx.galpao)
            .gt("saldo", 0)
            .limit(1);
          const semSaldo = !locsExistentes || locsExistentes.length === 0;

          if (semSaldo) {
            // (Fase 1.4) Loc vem do body (modal "bipe"). Sem fallback de snapshot
            // siso_pedido_item_estoques (tabela dropada) — se não veio loc e não há
            // saldo vivo, o operador bipa/escolhe a loc onde achou.
            const locManualId = locManualBody;
            if (!locManualId) {
              return NextResponse.json(
                {
                  error: "produto_sem_cadastro",
                  message:
                    "Produto sem localização cadastrada. Bipe ou escolha a localização onde achou.",
                  item_id: item.id,
                },
                { status: 422 },
              );
            }
            // Confirma que loc existe e pertence ao galpão
            const { data: loc } = await supabase
              .from("siso_localizacoes")
              .select("id, galpao_id")
              .eq("id", locManualId)
              .maybeSingle();
            if (!loc || loc.galpao_id !== ctx.galpao) {
              return NextResponse.json(
                {
                  error: "loc_invalida",
                  message:
                    "Localização não pertence ao galpão do pedido",
                },
                { status: 422 },
              );
            }
            try {
              // Mov E: entrada do que o operador achou
              await inserirMovimentacao({
                tripla: {
                  produto_id: produtoWmsId,
                  galpao_id: ctx.galpao,
                  localizacao_id: locManualId,
                },
                tipo: "E",
                qty,
                origem_tipo: "ajuste_manual",
                origem_id: `encontrei-sem-cadastro-${item.id}`,
                origem_detalhes: {
                  motivo: "encontrei sem cadastro",
                  item_id: item.id,
                  pedido_id: item.pedido_id,
                  sku: item.sku,
                },
                motivo: "Achado em pick — produto sem cadastro",
                motivo_categoria: "achado",
                usuario_id: user.id,
                fornecedor_id: null,
              });
              logger.info(
                "validar-oc-item",
                "encontrei sem cadastro: mov E gerada",
                {
                  item_id: item.id,
                  sku: item.sku,
                  loc_id: locManualId,
                  qty,
                },
              );
            } catch (entErr) {
              logger.logError({
                error: entErr,
                source: "validar-oc-item",
                message: "Falhou gerar mov E em encontrei sem cadastro",
                category: "business_logic",
                metadata: { item_id: item.id, sku: item.sku, loc_id: locManualId },
              });
              return NextResponse.json(
                {
                  error: "falhou_gerar_entrada",
                  message: "Não foi possível registrar a entrada do produto",
                },
                { status: 500 },
              );
            }
          }

          // Caminho normal: pickMovPicking gera mov S (que vai achar a loc
          // com saldo, possivelmente a que acabamos de criar via mov E acima).
          try {
            const result = await pickMovPicking({
              empresa_origem_id: ctx.empresa,
              galpao_id: ctx.galpao,
              pedido_id: String(item.pedido_id),
              pedido_numero: ctx.numero,
              item_id: Number(item.id),
              produto_id_tiny: String(item.produto_id),
              sku: String(item.sku),
              qty,
              usuario_id: user.id,
              contexto: "encontrei_oc",
            });
            movSaidaId = result?.movSaidaId ?? null;
          } catch (movErr) {
            logger.warn("validar-oc-item", "pickMovPicking falhou em encontrei", {
              item_id: item.id,
              error: movErr instanceof Error ? movErr.message : String(movErr),
            });
          }
        }

        const updates: Record<string, unknown> = {
          compra_status: null,
          fornecedor_oc: null,
          compra_quantidade_solicitada: null,
          compra_solicitada_em: null,
          ordem_compra_id: null,
          separacao_marcado: true,
          bipado_completo: true,
          quantidade_bipada: Number(item.quantidade_pedida ?? 0),
          quantidade_pega: Number(item.quantidade_pedida ?? 0),
        };
        if (movSaidaId) updates.mov_saida_id = movSaidaId;

        const { error: updErr } = await supabase
          .from("siso_pedido_itens")
          .update(updates)
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
          detalhes: { sku: item.sku, item_id: item.id, mov_saida_id: movSaidaId },
        });
      }
    } else if (acao === "desfazer_encontrei") {
      // Fix-Final A T15 (#2.6): estorna a mov S do encontrei + limpa
      // mov_saida_id/quantidade_pega/separacao_parcial. Antes desse fix,
      // desfazer_encontrei restaurava o status pra oc_pendente sem reverter
      // a saída do estoque, deixando o saldo permanentemente decrementado.
      for (const item of items) {
        const fornecedorInfo = getFornecedorBySku(item.sku);

        // 1. Estorna a mov S registrada em mov_saida_id (se houver).
        //    Se mov_saida_id é null, significa que o encontrei não chegou a
        //    gerar mov (modo legacy ou WMS_AS_SOURCE off) — só limpa campos.
        const movSaidaId = (item as { mov_saida_id?: string | null }).mov_saida_id;
        if (movSaidaId) {
          try {
            await estornarMovimentacao({
              mov_id: movSaidaId,
              usuario_id: user.id,
              motivo: `desfazer_encontrei OC (item ${item.id})`,
            });
          } catch (e) {
            logger.logError({
              error: e instanceof Error ? e : new Error(String(e)),
              source: "validar-oc-item",
              message: `Falha ao estornar mov_saida ${movSaidaId} em desfazer_encontrei`,
              category: "business_logic",
              metadata: { item_id: item.id, mov_saida_id: movSaidaId },
            });
            continue;
          }
        }

        // 2. Limpa todos os campos de pick + mov_saida_id + quantidade_pega
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
            mov_saida_id: null,
            quantidade_pega: 0,
            separacao_parcial: false,
            parcial_motivo: null,
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
          detalhes: { sku: item.sku, item_id: item.id, mov_estornada: movSaidaId },
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
