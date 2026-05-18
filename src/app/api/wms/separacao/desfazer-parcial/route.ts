import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { estornarMovimentacao } from "@/lib/wms/ledger";
import { registrarEvento } from "@/lib/historico-service";

/**
 * POST /api/separacao/desfazer-parcial
 * Body: { pedido_item_id: string }
 *
 * Reverte o estado parcial de um item:
 * - Estorna mov_saida_id e mov_ajuste_loc_zerou_id se existirem
 * - Cancela realocações em aguardando_picking
 * - Reseta campos do item
 * - Se pedido em pendente_realocacao, volta pra em_separacao
 * - Falha se alguma realocação já foi picada
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body?.pedido_item_id) {
    return NextResponse.json(
      { error: "'pedido_item_id' obrigatório" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    const { data: item, error: itemErr } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, sku, separacao_parcial, mov_saida_id, mov_ajuste_loc_zerou_id",
      )
      .eq("id", body.pedido_item_id)
      .single();

    if (itemErr || !item) {
      return NextResponse.json({ error: "item não encontrado" }, { status: 404 });
    }
    if (!item.separacao_parcial) {
      return NextResponse.json(
        { error: "item não está em estado parcial" },
        { status: 409 },
      );
    }

    // Bloqueia se alguma realocação já foi picada
    const { data: realocs } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select("id, status")
      .eq("pedido_item_id", item.id);

    // Bloqueia também 'picado_parcial' — a realocação foi parcialmente pega
    // (mov S já registrada) e teve cascade, então estornar só o item deixa
    // o ledger inconsistente. Operador precisa cancelar a separação inteira
    // pra reverter o cascade.
    const algumaPicada = (realocs ?? []).some(
      (r) => r.status === "picado" || r.status === "picado_parcial",
    );
    if (algumaPicada) {
      return NextResponse.json(
        { error: "não pode desfazer — alguma realocação já foi picada (total ou parcial)" },
        { status: 409 },
      );
    }

    // Estorna movimentações do ledger WMS se existirem
    if (item.mov_saida_id) {
      await estornarMovimentacao({
        mov_id: item.mov_saida_id,
        usuario_id: session.id,
        observacoes: "Desfazer parcial — operador",
      });
    }
    // mov_ajuste_loc_zerou_id NUNCA é estornado por design — reflete descoberta física.
    // Espelha cancelar/route.ts:79-80 e a spec original (invariantes).

    // Cancela realocações pendentes
    await supabase
      .from("siso_pedido_item_realocacoes")
      .update({ status: "cancelado" })
      .eq("pedido_item_id", item.id)
      .eq("status", "aguardando_picking");

    // Reseta campos do item
    await supabase
      .from("siso_pedido_itens")
      .update({
        separacao_parcial: false,
        parcial_motivo: null,
        parcial_em: null,
        parcial_por: null,
        quantidade_pega: null,
        separacao_marcado: false,
        separacao_marcado_em: null,
        mov_saida_id: null,
        mov_ajuste_loc_zerou_id: null,
      })
      .eq("id", item.id);

    // Se pedido em pendente_realocacao, volta pra em_separacao
    await supabase
      .from("siso_pedidos")
      .update({ status_separacao: "em_separacao" })
      .eq("id", item.pedido_id)
      .eq("status_separacao", "pendente_realocacao");

    await registrarEvento({
      pedidoId: item.pedido_id,
      evento: "parcial_desfeito",
      detalhes: { item_id: item.id, sku: item.sku },
      usuarioId: session.id,
    });

    return NextResponse.json({ status: "desfeito" });
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-desfazer-parcial",
      message: "Erro inesperado",
      category: "unknown",
      requestPath: "/api/wms/separacao/desfazer-parcial",
      requestMethod: "POST",
      metadata: { pedido_item_id: body?.pedido_item_id },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
