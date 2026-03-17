import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { movimentarEstoque } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { checkAndReleasePedidos } from "@/lib/compras-release";

const ALLOWED_CARGOS = ["admin", "comprador"];

interface ConferirItemInput {
  item_id: string;
  quantidade_recebida: number;
}

interface ConferirBody {
  ordem_compra_id?: string;
  usuario_id?: string;
  cargo?: string;
  itens?: ConferirItemInput[];
}

interface RawItem {
  id: string;
  sku: string;
  descricao: string;
  quantidade_pedida: number;
  compra_quantidade_recebida: number;
  produto_id_tiny: number | null;
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
  let body: ConferirBody;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { ordem_compra_id, usuario_id, cargo, itens } = body;

  // Auth check
  if (cargo && !ALLOWED_CARGOS.includes(cargo)) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  // Validate required fields
  if (!ordem_compra_id || !usuario_id || !itens || !Array.isArray(itens)) {
    return NextResponse.json(
      { error: "ordem_compra_id, usuario_id e itens são obrigatórios" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    // Fetch the OC
    const { data: oc, error: ocError } = await supabase
      .from("siso_ordens_compra")
      .select("id, empresa_id, status, fornecedor")
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

    // Get deposito_id from siso_tiny_connections for this empresa
    const { data: conn } = await supabase
      .from("siso_tiny_connections")
      .select("deposito_id")
      .eq("empresa_id", oc.empresa_id)
      .eq("ativo", true)
      .single();

    const depositoId = conn?.deposito_id ?? null;

    // Get valid token for this empresa
    const { token } = await getValidTokenByEmpresa(oc.empresa_id);

    // Filter items with quantidade_recebida > 0
    const itensParaProcessar = itens.filter((i) => i.quantidade_recebida > 0);

    let processados = 0;
    let erros = 0;
    const errosDetalhe: string[] = [];
    let itensSemProdutoId = 0;
    const processedItemIds: string[] = [];

    for (let idx = 0; idx < itensParaProcessar.length; idx++) {
      const input = itensParaProcessar[idx];

      // Fetch the item from DB
      const { data: dbItem, error: itemError } = await supabase
        .from("siso_pedido_itens")
        .select("id, sku, descricao, quantidade_pedida, compra_quantidade_recebida, produto_id_tiny, compra_status, pedido_id")
        .eq("id", input.item_id)
        .eq("ordem_compra_id", ordem_compra_id)
        .single();

      if (itemError || !dbItem) {
        erros++;
        errosDetalhe.push(`Item ${input.item_id} não encontrado na OC`);
        continue;
      }

      const item = dbItem as unknown as RawItem;

      // Call Tiny movimentarEstoque if produto_id_tiny exists
      if (item.produto_id_tiny) {
        try {
          await runWithEmpresa(oc.empresa_id, () => movimentarEstoque(token, item.produto_id_tiny!, {
            tipo: "E",
            quantidade: input.quantidade_recebida,
            deposito: depositoId ? { id: depositoId } : undefined,
            observacoes: `Entrada OC via SISO — ${item.sku}`,
          }));

          logger.info("compras-conferir", `Entrada estoque Tiny: ${item.sku} x${input.quantidade_recebida}`, {
            ordemCompraId: ordem_compra_id,
            produtoIdTiny: item.produto_id_tiny,
            sku: item.sku,
            quantidade: input.quantidade_recebida,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          erros++;
          errosDetalhe.push(`${item.sku}: ${msg}`);
          logger.error("compras-conferir", `Falha entrada estoque Tiny: ${item.sku}`, {
            ordemCompraId: ordem_compra_id,
            sku: item.sku,
            error: msg,
          });
          // Continue with remaining items — don't abort
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

      // Update quantity in DB (even if Tiny call was skipped)
      const novaQuantidadeRecebida = item.compra_quantidade_recebida + input.quantidade_recebida;
      const totalmenteRecebido = novaQuantidadeRecebida >= item.quantidade_pedida;

      const updateFields: Record<string, unknown> = {
        compra_quantidade_recebida: novaQuantidadeRecebida,
      };

      if (totalmenteRecebido) {
        updateFields.compra_status = "recebido";
        updateFields.recebido_em = new Date().toISOString();
        updateFields.recebido_por = usuario_id;
      }

      await supabase
        .from("siso_pedido_itens")
        .update(updateFields)
        .eq("id", item.id);

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
      .select("compra_status")
      .eq("ordem_compra_id", ordem_compra_id);

    if (allOcItems && allOcItems.length > 0) {
      const todosRecebidos = allOcItems.every((i) => i.compra_status === "recebido");
      const algumRecebido = allOcItems.some((i) => i.compra_status === "recebido");

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
