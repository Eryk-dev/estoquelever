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

    if (!pedidoId || produtoId == null || !galpao || quantidade == null) {
      return NextResponse.json(
        { error: "Campos obrigatórios: pedidoId, produtoId, galpao, quantidade" },
        { status: 400 },
      );
    }
    if (produtoId === 0) {
      return NextResponse.json(
        { error: "Produto sem ID no Tiny — não é possível ajustar estoque" },
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
      .select("id, nome, galpao_id, siso_galpoes!siso_empresas_galpao_id_fkey!inner(nome)")
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

    // 4. (Fase 1.4) deposito_id vem da conexão Tiny da empresa (era lido do
    //    snapshot siso_pedido_item_estoques, agora dropado).
    const { data: conn } = await supabase
      .from("siso_tiny_connections")
      .select("deposito_id")
      .eq("empresa_id", empresa.id)
      .eq("ativo", true)
      .maybeSingle();

    const depositoId = conn?.deposito_id ?? null;

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

    // 8. (Fase 1.4) REMOVIDO: update do snapshot siso_pedido_item_estoques
    //    (saldo/reservado/disponivel). Tabela dropada — saldo vive em siso_estoque.

    // 9. Also update legacy columns (backwards compat — will be removed)
    const qtdPedida = await getQuantidadePedida(supabase, pedidoId, produtoId);
    if (galpao === "CWB" || galpao === "SP") {
      // [Fix-D T10] cwb_atende/sp_atende removidos (zero readers)
      const legacyFields =
        galpao === "CWB"
          ? {
              estoque_cwb_saldo: novoSaldo,
              estoque_cwb_reservado: novoReservado,
              estoque_cwb_disponivel: novoDisponivel,
            }
          : {
              estoque_sp_saldo: novoSaldo,
              estoque_sp_reservado: novoReservado,
              estoque_sp_disponivel: novoDisponivel,
            };
      void qtdPedida; // var era usada só nos campos removidos


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
