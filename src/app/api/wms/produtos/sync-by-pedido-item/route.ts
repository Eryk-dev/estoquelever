import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { resolverProdutoEfetivoComAutoSync } from "@/lib/wms/sync-tiny";

/**
 * POST /api/wms/produtos/sync-by-pedido-item
 * Body: { pedido_item_id }
 *
 * Cria/recupera o vínculo Tiny↔WMS de um item de pedido cujo produto NÃO foi
 * auto-provisionado no webhook (ex.: Tiny intermitente no momento do pedido).
 * Resolve sku + empresa + tiny_produto_id a partir do item/pedido e chama
 * `ensureProdutoFromTiny` (cria siso_produtos + bridge + sincroniza tudo do
 * Tiny). É o backstop manual do auto-sync do pick — botão "Sincronizar do
 * Tiny" no modal de separação.
 */
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const pedidoItemId = body?.pedido_item_id;
  if (pedidoItemId == null) {
    return NextResponse.json(
      { error: "pedido_item_id obrigatório" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  try {
    const { data: item, error: itemErr } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, produto_id, sku, produto_wms_substituto_id")
      .eq("id", pedidoItemId)
      .single();
    if (itemErr || !item) {
      return NextResponse.json({ error: "item não encontrado" }, { status: 404 });
    }

    // SKU-first: resolve pelo SKU do catálogo (1:1) e, faltando, auto-provisiona
    // do Tiny (por tiny_id se houver, senão busca por SKU). Item sem SKU E sem
    // produto Tiny (produto_id=0) é o caso de resolução humana (definir-sku).
    const tinyId = Number(item.produto_id);
    const sku = item.sku ? String(item.sku).trim() : "";
    const temTiny = Number.isInteger(tinyId) && tinyId > 0;
    if (!sku && !temTiny) {
      return NextResponse.json(
        { error: "item sem SKU e sem produto Tiny — exige resolução manual na aba Pedidos" },
        { status: 422 },
      );
    }

    const { data: pedido } = await supabase
      .from("siso_pedidos")
      .select("empresa_origem_id")
      .eq("id", item.pedido_id)
      .single();
    const empresaId = (pedido?.empresa_origem_id as string | null) ?? null;
    if (!empresaId) {
      return NextResponse.json(
        { error: "pedido sem empresa de origem" },
        { status: 422 },
      );
    }

    try {
      const produtoId = await resolverProdutoEfetivoComAutoSync(empresaId, item);
      return NextResponse.json({ ok: true, produto_id: produtoId, sku: sku || null });
    } catch (resolveErr) {
      // Resolver não achou (ex.: produto_id=0 fora do catálogo e SKU ausente no
      // Tiny da empresa) → 422 acionável em vez de 500 mascarado.
      const msg = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
      if (/não mapeado|resolvível|manual/i.test(msg)) {
        return NextResponse.json(
          {
            error:
              "produto não encontrado no catálogo nem no Tiny da empresa — confira o SKU ou resolva na aba Pedidos",
            detalhe: msg,
          },
          { status: 422 },
        );
      }
      throw resolveErr; // erro real → wmsErrorResponse abaixo
    }
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.produtos.sync-by-pedido-item",
      error: e,
      category: "external_api",
      requestPath: "/api/wms/produtos/sync-by-pedido-item",
      requestMethod: "POST",
      metadata: { pedido_item_id: pedidoItemId },
    });
  }
}
