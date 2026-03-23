import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { movimentarEstoque } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { checkAndReleasePedidos } from "@/lib/compras-release";
import { getCompraQuantidadeRestante, getCompraQuantidadeSolicitada, hasComprasAccess } from "@/lib/compras-utils";

interface ConferirItemInput {
  item_id: string;
  quantidade_recebida: number;
}

interface ConferirBody {
  ordem_compra_id?: string;
  itens?: ConferirItemInput[];
}

interface RawItem {
  id: string;
  sku: string;
  descricao: string;
  quantidade_pedida: number;
  compra_quantidade_solicitada: number;
  compra_quantidade_recebida: number;
  produto_id_tiny: number | null;
  produto_id: number | null;
  compra_status: string | null;
  pedido_id: string;
}

/**
 * POST /api/compras/conferir
 *
 * Processes receiving confirmation: updates quantities in DB and calls
 * Tiny movimentarEstoque type E for each item with produto_id_tiny.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!hasComprasAccess(session.cargos)) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });

  let body: ConferirBody;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { ordem_compra_id, itens } = body;
  const usuario_id = session.id;

  // Validate required fields
  if (!ordem_compra_id || !itens || !Array.isArray(itens)) {
    return NextResponse.json(
      { error: "ordem_compra_id e itens são obrigatórios" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    // Fetch the OC (with galpao_id)
    const { data: oc, error: ocError } = await supabase
      .from("siso_ordens_compra")
      .select("id, empresa_id, galpao_id, status, fornecedor")
      .eq("id", ordem_compra_id)
      .single();

    if (ocError || !oc) {
      if (ocError?.code === "PGRST116") {
        return NextResponse.json(
          { error: "Ordem de compra não encontrada" },
          { status: 404 },
        );
      }
      throw new Error(`Erro ao buscar OC: ${ocError?.message ?? "not found"}`);
    }

    // Resolve the receiving empresa from the OC's galpão (or fallback to empresa_id)
    // Use deterministic ordering to always pick the same empresa
    let empresaRecebimentoId = oc.empresa_id;
    if (oc.galpao_id) {
      const { data: empresaGalpao } = await supabase
        .from("siso_empresas")
        .select("id")
        .eq("galpao_id", oc.galpao_id)
        .eq("ativo", true)
        .order("criado_em", { ascending: true })
        .limit(1)
        .single();
      if (empresaGalpao) {
        empresaRecebimentoId = empresaGalpao.id;
      }
    }

    if (!empresaRecebimentoId) {
      return NextResponse.json(
        { error: "Nenhuma empresa ativa encontrada no galpão da OC" },
        { status: 400 },
      );
    }

    // Get deposito_id from siso_tiny_connections for the receiving empresa
    const { data: conn } = await supabase
      .from("siso_tiny_connections")
      .select("deposito_id")
      .eq("empresa_id", empresaRecebimentoId)
      .eq("ativo", true)
      .single();

    const depositoId = conn?.deposito_id ?? null;

    // Get valid token for the receiving empresa
    const { token } = await getValidTokenByEmpresa(empresaRecebimentoId);

    // Filter items with quantidade_recebida > 0
    const itensParaProcessar = itens.filter((i) => i.quantidade_recebida > 0);

    let processados = 0;
    let erros = 0;
    const errosDetalhe: string[] = [];
    let itensSemProdutoId = 0;
    const processedItemIds: string[] = [];

    for (let idx = 0; idx < itensParaProcessar.length; idx++) {
      const input = itensParaProcessar[idx];

      // Fetch the item from DB (include produto_id for stock snapshot)
      const { data: dbItem, error: itemError } = await supabase
        .from("siso_pedido_itens")
        .select("id, sku, descricao, quantidade_pedida, compra_quantidade_solicitada, compra_quantidade_recebida, produto_id_tiny, produto_id, compra_status, pedido_id")
        .eq("id", input.item_id)
        .eq("ordem_compra_id", ordem_compra_id)
        .single();

      if (itemError || !dbItem) {
        erros++;
        errosDetalhe.push(`Item ${input.item_id} não encontrado na OC`);
        continue;
      }

      const item = dbItem as unknown as RawItem;
      const quantidadeEsperada = getCompraQuantidadeSolicitada(item);
      const quantidadeRestante = getCompraQuantidadeRestante(item);

      if (quantidadeRestante <= 0) {
        erros++;
        errosDetalhe.push(`${item.sku}: item já está totalmente recebido`);
        continue;
      }

      // Cap at remaining quantity to prevent over-receiving
      const quantidadeAReceber = Math.min(input.quantidade_recebida, quantidadeRestante);

      // 1. DB update FIRST with optimistic lock — prevents race conditions
      //    and ensures we don't call Tiny if a concurrent update already changed the value.
      const novaQuantidadeRecebida = item.compra_quantidade_recebida + quantidadeAReceber;
      const totalmenteRecebido = novaQuantidadeRecebida >= quantidadeEsperada;

      const updateFields: Record<string, unknown> = {
        compra_quantidade_recebida: novaQuantidadeRecebida,
      };

      if (totalmenteRecebido) {
        updateFields.compra_status = "recebido";
        updateFields.recebido_em = new Date().toISOString();
        updateFields.recebido_por = usuario_id;
      }

      const { data: updatedItem, error: updateItemError } = await supabase
        .from("siso_pedido_itens")
        .update(updateFields)
        .eq("id", item.id)
        .eq("compra_quantidade_recebida", item.compra_quantidade_recebida)
        .select("id")
        .maybeSingle();

      if (!updatedItem && !updateItemError) {
        erros++;
        errosDetalhe.push(`${item.sku}: atualização concorrente detectada, tente novamente`);
        logger.warn("compras-conferir", "Optimistic lock conflict", {
          ordemCompraId: ordem_compra_id,
          itemId: item.id,
          sku: item.sku,
        });
        continue;
      }

      if (updateItemError) {
        erros++;
        errosDetalhe.push(`${item.sku}: falha ao atualizar DB`);
        logger.warn("compras-conferir", "Falha ao atualizar item no DB", {
          ordemCompraId: ordem_compra_id,
          itemId: item.id,
          sku: item.sku,
          error: updateItemError.message,
        });
        continue;
      }

      // 2. Call Tiny movimentarEstoque AFTER DB success
      //    If Tiny fails, rollback the DB update.
      if (item.produto_id_tiny) {
        try {
          await runWithEmpresa(empresaRecebimentoId, () => movimentarEstoque(token, item.produto_id_tiny!, {
            tipo: "E",
            quantidade: quantidadeAReceber,
            deposito: depositoId ? { id: depositoId } : undefined,
            observacoes: `Entrada OC via SISO — ${item.sku}`,
          }));

          logger.info("compras-conferir", `Entrada estoque Tiny: ${item.sku} x${quantidadeAReceber}`, {
            ordemCompraId: ordem_compra_id,
            produtoIdTiny: item.produto_id_tiny,
            sku: item.sku,
            quantidade: quantidadeAReceber,
          });
        } catch (err) {
          // Rollback DB update since Tiny call failed
          await supabase
            .from("siso_pedido_itens")
            .update({
              compra_quantidade_recebida: item.compra_quantidade_recebida,
              ...(totalmenteRecebido ? { compra_status: "comprado", recebido_em: null, recebido_por: null } : {}),
            })
            .eq("id", item.id);

          const msg = err instanceof Error ? err.message : String(err);
          erros++;
          errosDetalhe.push(`${item.sku}: ${msg}`);
          logger.error("compras-conferir", `Falha entrada estoque Tiny (DB rolled back): ${item.sku}`, {
            ordemCompraId: ordem_compra_id,
            sku: item.sku,
            error: msg,
          });
          continue;
        }
      } else {
        itensSemProdutoId++;
        logger.warn("compras-conferir", "SKU não encontrado no Tiny — entrada pulada", {
          ordemCompraId: ordem_compra_id,
          sku: item.sku,
          itemId: item.id,
        });
      }

      // Update stock snapshot so the transferencia worker finds stock at the receiving empresa
      // Use cumulative novaQuantidadeRecebida (not just this batch) to handle partial receives
      if (item.produto_id) {
        const { error: estError } = await supabase.from("siso_pedido_item_estoques").upsert(
          {
            pedido_id: item.pedido_id,
            produto_id: item.produto_id,
            empresa_id: empresaRecebimentoId,
            saldo: novaQuantidadeRecebida,
            disponivel: novaQuantidadeRecebida,
            reservado: 0,
          },
          { onConflict: "pedido_id,produto_id,empresa_id" },
        );
        if (estError) {
          logger.warn("compras-conferir", "Falha ao atualizar snapshot de estoque", {
            ordemCompraId: ordem_compra_id,
            pedidoId: item.pedido_id,
            produtoId: item.produto_id,
            error: estError.message,
          });
        }
      }

      processados++;
      processedItemIds.push(item.id);

      // Sleep 500ms between Tiny API calls
      if (idx < itensParaProcessar.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // Update OC status based on items
    const { data: allOcItems } = await supabase
      .from("siso_pedido_itens")
      .select("compra_status, quantidade_pedida, compra_quantidade_solicitada, compra_quantidade_recebida")
      .eq("ordem_compra_id", ordem_compra_id);

    if (allOcItems && allOcItems.length > 0) {
      const todosRecebidos = allOcItems.every((item) =>
        getCompraQuantidadeRestante(item) === 0,
      );
      const algumRecebido = allOcItems.some((item) =>
        Number(item.compra_quantidade_recebida ?? 0) > 0,
      );

      let novoStatus: string;
      if (todosRecebidos) {
        novoStatus = "recebido";
      } else if (algumRecebido) {
        novoStatus = "parcialmente_recebido";
      } else {
        novoStatus = oc.status; // keep current
      }

      if (novoStatus !== oc.status) {
        await supabase
          .from("siso_ordens_compra")
          .update({ status: novoStatus })
          .eq("id", ordem_compra_id);
      }
    }

    // Check if any pedidos can be released after receiving
    const releasedPedidos = await checkAndReleasePedidos(processedItemIds);

    logger.info("compras-conferir", "Conferência processada", {
      ordemCompraId: ordem_compra_id,
      processados,
      erros,
      itensSemProdutoId,
      pedidosLiberados: releasedPedidos.length,
    });

    return NextResponse.json({
      processados,
      erros,
      erros_detalhe: errosDetalhe,
      itens_sem_produto_id: itensSemProdutoId,
      pedidos_liberados: releasedPedidos,
    });
  } catch (err) {
    logger.error("compras-conferir", "Erro ao processar conferência", {
      error: err instanceof Error ? err.message : String(err),
      ordemCompraId: ordem_compra_id,
    });
    return NextResponse.json(
      { error: "Erro interno ao processar conferência" },
      { status: 500 },
    );
  }
}
