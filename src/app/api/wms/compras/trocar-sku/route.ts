import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";
import { userCan } from "@/lib/permissions";
import { buscarProdutoPorSku, getEstoque, getProdutoDetalhe } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { getEmpresasDoGrupo } from "@/lib/grupo-resolver";

/**
 * POST /api/compras/trocar-sku
 *
 * Swaps the SKU of a pedido item to an equivalent product.
 * Looks up the new product in Tiny across all group empresas,
 * updates description, image, stock, and supplier.
 * Does NOT auto-release the pedido — the operator decides.
 *
 * Body: {
 *   item_ids: string[],   // siso_pedido_itens IDs to update
 *   novo_sku: string,      // new SKU code
 * }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const body = await request.json();
  const itemIds = body.item_ids as string[] | undefined;
  const novoSku = body.novo_sku as string | undefined;

  if (!itemIds?.length || !novoSku?.trim()) {
    return NextResponse.json(
      { error: "Envie { item_ids: string[], novo_sku: string }" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    // Get items and their pedidos
    const { data: items, error: fetchErr } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, produto_id, sku, quantidade_pedida, siso_pedidos(empresa_origem_id)")
      .in("id", itemIds);

    if (fetchErr || !items?.length) {
      return NextResponse.json(
        { error: "Itens não encontrados" },
        { status: 404 },
      );
    }

    const novoFornecedor = getFornecedorBySku(novoSku);

    const firstItem = items[0] as unknown as {
      id: string;
      pedido_id: string;
      produto_id: number;
      quantidade_pedida: number;
      siso_pedidos: { empresa_origem_id: string } | null;
    };
    const empresaOrigemId = firstItem.siso_pedidos?.empresa_origem_id;

    if (!empresaOrigemId) {
      return NextResponse.json(
        { error: "Pedido sem empresa de origem" },
        { status: 400 },
      );
    }

    // Get empresa's group
    const { data: grupoRel } = await supabase
      .from("siso_grupo_empresas")
      .select("grupo_id")
      .eq("empresa_id", empresaOrigemId)
      .single();

    const empresasDoGrupo = grupoRel
      ? await getEmpresasDoGrupo(grupoRel.grupo_id)
      : [];

    // Get deposito IDs for each empresa
    const { data: connections } = await supabase
      .from("siso_tiny_connections")
      .select("empresa_id, deposito_id")
      .eq("ativo", true);
    const depositoMap = new Map<string, number | null>();
    for (const c of connections ?? []) {
      depositoMap.set(c.empresa_id, c.deposito_id);
    }

    // Look up the new product in each empresa
    let novaDescricao: string | null = null;
    let novaImagem: string | null = null;
    let novoProdutoId: number | null = null;
    const novosEstoques: Array<{
      pedido_id: string;
      produto_id: number;
      empresa_id: string;
      deposito_id: number | null;
      deposito_nome: string | null;
      saldo: number;
      reservado: number;
      disponivel: number;
      localizacao: string | null;
      produto_id_na_empresa: number | null;
    }> = [];

    const empresasParaConsultar = empresasDoGrupo.length > 0
      ? empresasDoGrupo
      : [{ empresaId: empresaOrigemId, galpaoId: "", galpaoNome: "", empresaNome: "", tier: 1 }];

    for (const emp of empresasParaConsultar) {
      try {
        const { token } = await getValidTokenByEmpresa(emp.empresaId);
        const produto = await runWithEmpresa(emp.empresaId, () =>
          buscarProdutoPorSku(token, novoSku),
        );

        if (!produto) continue;

        // Get image from first empresa that has the product
        if (!novaDescricao) {
          novaDescricao = produto.descricao ?? null;
          novoProdutoId = produto.id;
          try {
            const detalhe = await runWithEmpresa(emp.empresaId, () =>
              getProdutoDetalhe(token, produto.id),
            );
            novaImagem = detalhe.imagemUrl;
          } catch {
            // Image fetch failed, not critical
          }
        }

        const estoque = await runWithEmpresa(emp.empresaId, () =>
          getEstoque(token, produto.id),
        );

        const depositoId = depositoMap.get(emp.empresaId) ?? null;
        const depositos = estoque.depositos ?? [];
        const dep = depositoId != null
          ? depositos.find((d) => d.id === depositoId) ?? null
          : depositos[0] ?? null;

        const saldo = dep?.saldo ?? 0;
        const reservado = dep?.reservado ?? 0;

        // Add stock row for each pedido_id that has this item
        for (const item of items) {
          novosEstoques.push({
            pedido_id: item.pedido_id as string,
            produto_id: produto.id,
            empresa_id: emp.empresaId,
            deposito_id: dep?.id ?? null,
            deposito_nome: dep?.nome ?? null,
            saldo,
            reservado,
            disponivel: saldo - reservado,
            localizacao: estoque.localizacao ?? null,
            produto_id_na_empresa: produto.id,
          });
        }
      } catch {
        continue;
      }
    }

    if (!novoProdutoId) {
      return NextResponse.json(
        { error: `SKU "${novoSku}" não encontrado em nenhuma empresa do grupo` },
        { status: 404 },
      );
    }

    // Update siso_pedido_itens with new SKU, description, image
    const { error: updateErr } = await supabase
      .from("siso_pedido_itens")
      .update({
        sku: novoSku,
        descricao: novaDescricao,
        imagem_url: novaImagem,
        produto_id: novoProdutoId,
        fornecedor_oc: novoFornecedor.fornecedor,
      })
      .in("id", itemIds);

    if (updateErr) {
      throw new Error(`Erro ao atualizar itens: ${updateErr.message}`);
    }

    // Delete old stock rows and insert new ones
    const pedidoIds = [...new Set(items.map((i) => i.pedido_id as string))];
    const oldProdutoId = firstItem.produto_id;

    for (const pedidoId of pedidoIds) {
      await supabase
        .from("siso_pedido_item_estoques")
        .delete()
        .eq("pedido_id", pedidoId)
        .eq("produto_id", oldProdutoId);
    }

    if (novosEstoques.length > 0) {
      const { error: estErr } = await supabase
        .from("siso_pedido_item_estoques")
        .upsert(novosEstoques, {
          onConflict: "pedido_id,produto_id,empresa_id",
        });
      if (estErr) {
        logger.error("compras-trocar-sku", "Erro ao inserir estoques", {
          error: estErr.message,
        });
      }
    }

    logger.info("compras-trocar-sku", "SKU trocado com sucesso", {
      itemIds,
      novoSku,
      novoProdutoId,
      novoFornecedor: novoFornecedor.fornecedor,
      estoques: novosEstoques.length,
    });

    return NextResponse.json({
      ok: true,
      novo_sku: novoSku,
      novo_fornecedor: novoFornecedor.fornecedor,
      descricao: novaDescricao,
    });
  } catch (err) {
    logger.error("compras-trocar-sku", "Erro ao trocar SKU", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Erro interno ao trocar SKU" },
      { status: 500 },
    );
  }
}
