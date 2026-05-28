import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";

interface Body {
  pedido_ids?: string[];
  item_ids?: string[];
}

/**
 * POST /api/wms/separacao/mandar-pra-compras
 *
 * Decisão (28/05): aciona transição itens com cascade sem cobertura →
 * aguardando_compra. Substitui o caminho legado pendente_realocacao →
 * Encaminhar → re-aprovação OC (que causava loop infinito).
 *
 * Body: { pedido_ids: string[], item_ids: string[] }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  if (!userCan(session, "separacao.executar")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { pedido_ids, item_ids } = body;
  if (
    !Array.isArray(pedido_ids) ||
    !Array.isArray(item_ids) ||
    item_ids.length === 0
  ) {
    return NextResponse.json(
      { error: "pedido_ids e item_ids são obrigatórios" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const { data: items, error: fetchErr } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, pedido_id, sku, quantidade_pedida, quantidade_pega, fornecedor_oc",
    )
    .in("id", item_ids);

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }
  if (!items || items.length === 0) {
    return NextResponse.json({ error: "itens não encontrados" }, { status: 404 });
  }

  for (const item of items) {
    const qtyResidual = Math.max(
      0,
      Number(item.quantidade_pedida ?? 0) - Number(item.quantidade_pega ?? 0),
    );
    const fornecedor =
      item.fornecedor_oc || getFornecedorBySku(item.sku ?? "").fornecedor;

    const { error: updErr } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: "aguardando_compra",
        compra_quantidade_solicitada: qtyResidual,
        compra_solicitada_em: now,
        fornecedor_oc: fornecedor,
      })
      .eq("id", item.id);

    if (updErr) {
      logger.warn("mandar-pra-compras", "falhou update item", {
        item_id: item.id,
        err: updErr.message,
      });
      continue;
    }

    registrarEvento({
      pedidoId: item.pedido_id,
      evento: "mandado_pra_compras_via_cascade",
      usuarioId: session.id,
      usuarioNome: session.nome,
      detalhes: {
        item_id: item.id,
        sku: item.sku,
        qty_residual: qtyResidual,
        fornecedor,
      },
    }).catch(() => {});
  }

  // Pedidos voltam pra aguardando_compra (Compras passa a controlá-los)
  await supabase
    .from("siso_pedidos")
    .update({
      status_separacao: "aguardando_compra",
      separacao_operador_id: null,
      separacao_iniciada_em: null,
    })
    .in("id", pedido_ids);

  logger.info(
    "mandar-pra-compras",
    "itens mandados pra compras via cascade esgotado",
    {
      pedido_ids,
      item_ids,
      operador: session.nome,
    },
  );

  return NextResponse.json({
    ok: true,
    pedidos_atualizados: pedido_ids.length,
    itens_atualizados: items.length,
  });
}
