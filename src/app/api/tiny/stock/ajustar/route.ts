import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { movimentarEstoque, getEstoque } from "@/lib/tiny-api";
import { waitForRateLimit, registerApiCall } from "@/lib/rate-limiter";
import { logger } from "@/lib/logger";

/**
 * POST /api/tiny/stock/ajustar
 *
 * Adjusts stock directly in Tiny ERP (tipo B = balanço) and updates the
 * local DB item with the new values.
 *
 * Body: {
 *   pedidoId: string,       // siso_pedidos.id (Tiny pedido ID)
 *   produtoId: number,       // produto_id from siso_pedido_itens
 *   galpao: "CWB" | "SP",   // which galpão's stock to adjust
 *   novaQuantidade: number,  // new stock balance (saldo)
 * }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { pedidoId, produtoId, galpao, novaQuantidade } = body as {
      pedidoId: string;
      produtoId: number;
      galpao: "CWB" | "SP";
      novaQuantidade: number;
    };

    // Validate input
    if (!pedidoId || !produtoId || !galpao || novaQuantidade == null) {
      return NextResponse.json(
        { error: "Campos obrigatórios: pedidoId, produtoId, galpao, novaQuantidade" },
        { status: 400 },
      );
    }
    if (novaQuantidade < 0) {
      return NextResponse.json(
        { error: "Quantidade não pode ser negativa" },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    // 1. Get the pedido item to find deposit IDs and produto_id_suporte
    const { data: item } = await supabase
      .from("siso_pedido_itens")
      .select("produto_id, produto_id_suporte, estoque_cwb_deposito_id, estoque_sp_deposito_id")
      .eq("pedido_id", pedidoId)
      .eq("produto_id", produtoId)
      .single();

    if (!item) {
      return NextResponse.json(
        { error: "Item não encontrado no pedido" },
        { status: 404 },
      );
    }

    // 2. Get the pedido to find filial_origem
    const { data: pedido } = await supabase
      .from("siso_pedidos")
      .select("filial_origem, empresa_origem_id")
      .eq("id", pedidoId)
      .single();

    if (!pedido) {
      return NextResponse.json(
        { error: "Pedido não encontrado" },
        { status: 404 },
      );
    }

    // 3. Find the empresa in the target galpão
    const { data: empresa } = await supabase
      .from("siso_empresas")
      .select("id, nome, galpao_id, siso_galpoes!inner(nome)")
      .eq("siso_galpoes.nome", galpao)
      .eq("ativo", true)
      .limit(1)
      .single();

    if (!empresa) {
      return NextResponse.json(
        { error: `Nenhuma empresa ativa encontrada no galpão ${galpao}` },
        { status: 404 },
      );
    }

    // 4. Determine which product ID to use in Tiny
    const isOrigemGalpao = pedido.filial_origem === galpao;
    const tinyProdutoId = isOrigemGalpao
      ? item.produto_id
      : item.produto_id_suporte;

    if (!tinyProdutoId) {
      return NextResponse.json(
        { error: `Produto não encontrado no Tiny da empresa ${galpao}. Não é possível ajustar.` },
        { status: 400 },
      );
    }

    // 5. Get deposit ID for this galpão
    const depositoId = galpao === "CWB"
      ? item.estoque_cwb_deposito_id
      : item.estoque_sp_deposito_id;

    // 6. Get token for the empresa
    const { token } = await getValidTokenByEmpresa(empresa.id);

    // 7. Call Tiny to adjust stock (tipo B = balanço)
    await waitForRateLimit(empresa.id);
    await registerApiCall(empresa.id, "POST /estoque/{id} (balanço)");
    await movimentarEstoque(token, tinyProdutoId, {
      tipo: "B",
      quantidade: novaQuantidade,
      ...(depositoId != null && { deposito: { id: depositoId } }),
      observacoes: `Ajuste via SISO — pedido ${pedidoId}`,
    });

    logger.info("stock-adjust", "Stock adjusted in Tiny", {
      pedidoId,
      produtoId,
      galpao,
      empresaId: empresa.id,
      tinyProdutoId,
      depositoId,
      novaQuantidade,
    });

    // 8. Re-fetch stock from Tiny to get the actual updated values
    await waitForRateLimit(empresa.id);
    await registerApiCall(empresa.id, "GET /estoque/{id}");
    const estoqueAtualizado = await getEstoque(token, tinyProdutoId);

    // Pick the right deposit
    let novoSaldo = novaQuantidade;
    let novoReservado = 0;
    let novoDisponivel = novaQuantidade;

    if (estoqueAtualizado.depositos?.length) {
      const dep = depositoId != null
        ? estoqueAtualizado.depositos.find((d) => d.id === depositoId)
        : estoqueAtualizado.depositos[0];
      if (dep) {
        novoSaldo = dep.saldo;
        novoReservado = dep.reservado ?? 0;
        novoDisponivel = Math.max(0, dep.saldo - (dep.reservado ?? 0));
      }
    }

    // 9. Update the DB item with new stock values
    const updateFields =
      galpao === "CWB"
        ? {
            estoque_cwb_saldo: novoSaldo,
            estoque_cwb_reservado: novoReservado,
            estoque_cwb_disponivel: novoDisponivel,
            cwb_atende: novoDisponivel >= (await getQuantidadePedida(supabase, pedidoId, produtoId)),
          }
        : {
            estoque_sp_saldo: novoSaldo,
            estoque_sp_reservado: novoReservado,
            estoque_sp_disponivel: novoDisponivel,
            sp_atende: novoDisponivel >= (await getQuantidadePedida(supabase, pedidoId, produtoId)),
          };

    await supabase
      .from("siso_pedido_itens")
      .update(updateFields)
      .eq("pedido_id", pedidoId)
      .eq("produto_id", produtoId);

    // 10. Also update normalized per-empresa stock table
    await supabase
      .from("siso_pedido_item_estoques")
      .update({
        saldo: novoSaldo,
        reservado: novoReservado,
        disponivel: novoDisponivel,
      })
      .eq("pedido_id", pedidoId)
      .eq("produto_id", produtoId)
      .eq("empresa_id", empresa.id);

    return NextResponse.json({
      ok: true,
      galpao,
      saldo: novoSaldo,
      reservado: novoReservado,
      disponivel: novoDisponivel,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("stock-adjust", "Failed to adjust stock", { error: msg });
    return NextResponse.json(
      { error: `Erro ao ajustar estoque: ${msg}` },
      { status: 500 },
    );
  }
}

// Helper to get quantidade_pedida for atende calculation
async function getQuantidadePedida(
  supabase: ReturnType<typeof createServiceClient>,
  pedidoId: string,
  produtoId: number,
): Promise<number> {
  const { data } = await supabase
    .from("siso_pedido_itens")
    .select("quantidade_pedida")
    .eq("pedido_id", pedidoId)
    .eq("produto_id", produtoId)
    .single();
  return data?.quantidade_pedida ?? 0;
}
