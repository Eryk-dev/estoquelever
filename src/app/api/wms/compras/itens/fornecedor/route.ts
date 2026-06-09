import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { registrarEventos } from "@/lib/historico-service";

/**
 * PATCH /api/wms/compras/itens/fornecedor
 * Body: { item_ids: string[], fornecedor_oc: string | null }
 *
 * Troca o fornecedor_oc (string livre) de N linhas siso_pedido_itens de uma vez.
 * Um SKU na aba Comprar agrega várias linhas (uma por pedido); o front manda
 * todos os item_ids do grupo. Null/empty limpa o fornecedor ("Sem fornecedor").
 */
export async function PATCH(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    item_ids?: unknown;
    fornecedor_oc?: unknown;
  };
  const itemIds = Array.isArray(body.item_ids)
    ? body.item_ids.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  if (itemIds.length === 0) {
    return NextResponse.json({ error: "item_ids[] obrigatório" }, { status: 400 });
  }
  // Normaliza: string trimada; vazia → null (limpa o fornecedor).
  const raw = typeof body.fornecedor_oc === "string" ? body.fornecedor_oc.trim() : null;
  const fornecedorOc = raw && raw.length > 0 ? raw : null;

  const supabase = createServiceClient();

  try {
    // Valida que o fornecedor existe (quando não está limpando).
    if (fornecedorOc) {
      const { data: forn } = await supabase
        .from("siso_fornecedores")
        .select("id")
        .eq("nome", fornecedorOc)
        .eq("ativo", true)
        .limit(1);
      if (!forn || forn.length === 0) {
        return NextResponse.json(
          { error: `Fornecedor "${fornecedorOc}" não encontrado` },
          { status: 400 },
        );
      }
    }

    const { data: updated, error } = await supabase
      .from("siso_pedido_itens")
      .update({ fornecedor_oc: fornecedorOc })
      .in("id", itemIds)
      .select("id, pedido_id");
    if (error) throw new Error(`Erro ao atualizar fornecedor: ${error.message}`);

    const rows = updated ?? [];
    // Um evento por pedido distinto afetado (audit trail).
    const pedidoIds = [...new Set(rows.map((r) => String(r.pedido_id)))];
    await registrarEventos(
      pedidoIds.map((pedidoId) => ({
        pedidoId,
        evento: "compra_fornecedor_alterado" as const,
        usuarioId: session.id,
        usuarioNome: session.nome,
        detalhes: { fornecedor_oc: fornecedorOc, item_ids: itemIds },
      })),
    );

    return NextResponse.json({ ok: true, atualizados: rows.length });
  } catch (err) {
    logger.error("compras-trocar-fornecedor", "Erro ao trocar fornecedor", {
      error: err instanceof Error ? err.message : String(err),
      item_ids: itemIds,
    });
    return NextResponse.json(
      { error: "Erro interno ao trocar fornecedor" },
      { status: 500 },
    );
  }
}
