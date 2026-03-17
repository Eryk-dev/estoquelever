import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { movimentarEstoque, getEstoque } from "@/lib/tiny-api";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { logger } from "@/lib/logger";

/**
 * POST /api/tiny/stock/ajustar
 *
 * Sets stock to an exact value in Tiny ERP (balanço) and updates the local DB.
 *
 * Body: {
 *   pedidoId: string,           // siso_pedidos.id
 *   produtoId: number,           // produto_id from siso_pedido_itens
 *   galpao: string,              // galpão name (e.g. "CWB", "SP")
 *   quantidade: number,          // new saldo (exact value)
 * }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { pedidoId, produtoId, galpao } = body as {
      pedidoId: string;
      produtoId: number;
      galpao: string;
    };
    const quantidade = body.quantidade ?? body.novaQuantidade;

    if (!pedidoId || !produtoId || !galpao || quantidade == null) {
      return NextResponse.json(
        { error: "Campos obrigatórios: pedidoId, produtoId, galpao, quantidade" },
        { status: 400 },
      );
    }
    if (quantidade < 0) {
      return NextResponse.json(
        { error: "Quantidade não pode ser negativa" },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    // 1. Get the pedido to find filial_origem and empresa
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

    // 2. Find the empresa in the target galpão
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

    // 3. Determine which product ID to use in Tiny
    const isOrigemGalpao = pedido.filial_origem === galpao;

    let tinyProdutoId: number | null = null;

    if (isOrigemGalpao) {
      tinyProdutoId = produtoId;
    } else {
      // Look up produto_id_suporte from siso_pedido_itens
      const { data: item } = await supabase
        .from("siso_pedido_itens")
        .select("produto_id_suporte")
        .eq("pedido_id", pedidoId)
        .eq("produto_id", produtoId)
        .single();
      tinyProdutoId = item?.produto_id_suporte ?? null;
    }

    if (!tinyProdutoId) {
      return NextResponse.json(
        { error: `Produto não encontrado no Tiny da empresa ${galpao}. Não é possível ajustar.` },
        { status: 400 },
      );
    }

    // 4. Get deposit ID from normalized stock table
    const { data: estoqueRow } = await supabase
      .from("siso_pedido_item_estoques")
      .select("deposito_id")
      .eq("pedido_id", pedidoId)
      .eq("produto_id", produtoId)
      .eq("empresa_id", empresa.id)
      .maybeSingle();

    const depositoId = estoqueRow?.deposito_id ?? null;

    // 5. Get token for the empresa
    const { token } = await getValidTokenByEmpresa(empresa.id);

    // 6. Call Tiny — balanço (set exact saldo) + re-fetch actual values
    const estoqueAtualizado = await runWithEmpresa(empresa.id, async () => {
      await movimentarEstoque(token, tinyProdutoId!, {
        tipo: "B",
        quantidade,
        ...(depositoId != null && { deposito: { id: depositoId } }),
        observacoes: `Balanço via SISO — pedido ${pedidoId}`,
      });

      logger.info("stock-adjust", "Stock balance set in Tiny", {
        pedidoId, produtoId, galpao,
        empresaId: empresa.id, tinyProdutoId, depositoId,
        novoSaldo: quantidade,
      });

      // 7. Re-fetch stock from Tiny to get actual values
      return getEstoque(token, tinyProdutoId!);
    });

    let novoSaldo = quantidade;
    let novoReservado = 0;
    let novoDisponivel = quantidade;

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

    // 8. Update normalized stock table
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

    // 9. Also update legacy columns (backwards compat — will be removed)
    const qtdPedida = await getQuantidadePedida(supabase, pedidoId, produtoId);
    if (galpao === "CWB" || galpao === "SP") {
      const legacyFields =
        galpao === "CWB"
          ? {
              estoque_cwb_saldo: novoSaldo,
              estoque_cwb_reservado: novoReservado,
              estoque_cwb_disponivel: novoDisponivel,
              cwb_atende: novoDisponivel >= qtdPedida,
            }
          : {
              estoque_sp_saldo: novoSaldo,
              estoque_sp_reservado: novoReservado,
              estoque_sp_disponivel: novoDisponivel,
              sp_atende: novoDisponivel >= qtdPedida,
            };

      await supabase
        .from("siso_pedido_itens")
        .update(legacyFields)
        .eq("pedido_id", pedidoId)
        .eq("produto_id", produtoId);
    }

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
