import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { estornarMovimentacao } from "@/lib/wms/ledger";
import { estornarLiberacaoReserva } from "@/lib/wms/reservas-picking";
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

    // Estorna movs via tabela ponte sempre via RPC parcial.
    //
    // Por que SEMPRE usar estorno parcial (mesmo quando só sobrou 1 link)?
    // Quando uma mov S é compartilhada por wave (consolidação multi-item),
    // o primeiro desfazer cria um estorno parcial. No segundo desfazer só
    // sobra 1 link, mas a mov já tem um estorno parcial registrado — chamar
    // `estornarMovimentacao` (full estorno) falharia com "mov X já foi
    // estornada". A RPC `wms_estornar_parcial_movimentacao` valida via
    // `qty_estornada + p_qty > quantidade` (strict `>`), então o exact-fit
    // final (e.g., qty_estornada=5 + qty=5 = quantidade=10 → 10 > 10 = false
    // → permitido) passa naturalmente.
    const { data: links } = await supabase
      .from("siso_pedido_item_mov_links")
      .select("id, mov_id, qty, tipo_link")
      .eq("pedido_item_id", item.id)
      .eq("tipo_link", "saida");

    let totalEstornado = 0;

    for (const link of links ?? []) {
      // P2-SEP-03: capturar o erro da RPC. Antes era ignorado — o link era
      // deletado e qty_pega decrementada mesmo com a S ainda VIVA no ledger,
      // deixando estoque fantasma sem rastro. Em erro: logError + 409 SEM
      // deletar o link nem decrementar — abortar (itens já processados ficam;
      // retry é seguro, a RPC valida o acumulado via qty_estornada+p_qty).
      const { error: estornoErr } = await supabase.rpc(
        "wms_estornar_parcial_movimentacao",
        {
          p_mov_id: link.mov_id,
          p_qty: link.qty,
          p_usuario_id: session.id,
          p_observacoes: "Desfazer parcial — operador",
        },
      );

      if (estornoErr) {
        logger.logError({
          error: estornoErr,
          source: "separacao-desfazer-parcial",
          message: "Falha no estorno parcial — link preservado, qty_pega intacta",
          category: "business_logic",
          errorCode: estornoErr.code,
          requestPath: "/api/wms/separacao/desfazer-parcial",
          requestMethod: "POST",
          metadata: {
            mov_id: link.mov_id,
            qty: link.qty,
            item_id: item.id,
            pedido_id: item.pedido_id,
          },
        });
        return NextResponse.json(
          {
            error: "falha_estorno_parcial",
            message: estornoErr.message,
          },
          { status: 409 },
        );
      }

      await supabase
        .from("siso_pedido_item_mov_links")
        .delete()
        .eq("id", link.id);

      totalEstornado += Number(link.qty);
    }

    // Fallback legacy: item sem links mas com mov_saida_id (criado pré-fix-pack)
    if ((links ?? []).length === 0 && item.mov_saida_id) {
      await estornarMovimentacao({
        mov_id: item.mov_saida_id,
        usuario_id: session.id,
        motivo: "Desfazer parcial — operador (legacy path)",
      });
    }

    // Apaga links de ajuste_loc_zerou (NÃO estorna mov — reflete descoberta física)
    await supabase
      .from("siso_pedido_item_mov_links")
      .delete()
      .eq("pedido_item_id", item.id)
      .eq("tipo_link", "ajuste_loc_zerou");

    // mov_ajuste_loc_zerou_id NUNCA é estornado por design — reflete descoberta física.
    // Espelha cancelar/route.ts:79-80 e a spec original (invariantes).

    // Estorna L's (liberacao_reserva) via estornarLiberacaoReserva — cria R
    // nova com estorno_de=L + origem_tipo='reserva_pedido', reconstitui o
    // reservado original. O `estornarMovimentacao` genérico NÃO funciona aqui:
    // a L de pick carrega estorno_de=R.id por convenção e a guarda do ledger
    // rejeita ("mov já é um estorno"). Helper é idempotente (R existente com
    // estorno_de=L é retornada sem duplicar).
    const { data: linksL } = await supabase
      .from("siso_pedido_item_mov_links")
      .select("id, mov_id")
      .eq("pedido_item_id", item.id)
      .eq("tipo_link", "liberacao_reserva");

    const linksLEstornados: string[] = [];
    for (const link of linksL ?? []) {
      try {
        await estornarLiberacaoReserva({
          liberacao_mov_id: link.mov_id as string,
          pedido_id: String(item.pedido_id),
          usuario_id: session.id,
          motivo: "Desfazer parcial — estorna L (recria reserva)",
        });
        linksLEstornados.push(link.id as string);
      } catch (e) {
        // LOUD: sem a R recriada o item volta a "PEGAR" com reservado=0 —
        // pedido novo pode rotear em cima do saldo (overselling). O desfazer
        // continua (S já estornada), mas registra erro real pro supervisor.
        // Link NÃO é deletado — fica como rastro pra recuperação manual.
        logger.logError({
          error: e,
          source: "separacao-desfazer-parcial",
          message: "Falhou recriar reserva (estorno de L) — item fica sem R",
          category: "business_logic",
          requestPath: "/api/wms/separacao/desfazer-parcial",
          requestMethod: "POST",
          metadata: { mov_id: link.mov_id, pedido_id: item.pedido_id, item_id: item.id },
        });
      }
    }
    if (linksLEstornados.length > 0) {
      await supabase
        .from("siso_pedido_item_mov_links")
        .delete()
        .in("id", linksLEstornados);
    }

    // Estorna R cascade — cria L com estorno_de=R, zera o reservado cascade.
    // Importante: roda antes de cancelar as realocações pendentes (o cancel
    // não estorna ledger; a R só some via estorno explícito aqui).
    const { data: linksRCascade } = await supabase
      .from("siso_pedido_item_mov_links")
      .select("id, mov_id")
      .eq("pedido_item_id", item.id)
      .eq("tipo_link", "reserva_cascade");

    for (const link of linksRCascade ?? []) {
      try {
        await estornarMovimentacao({
          mov_id: link.mov_id as string,
          usuario_id: session.id,
          motivo: "Desfazer parcial — estorna R cascade",
        });
      } catch (e) {
        logger.warn("separacao-desfazer-parcial", "Falhou estornar R cascade (continua)", {
          mov_id: link.mov_id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if ((linksRCascade?.length ?? 0) > 0) {
      await supabase
        .from("siso_pedido_item_mov_links")
        .delete()
        .in(
          "id",
          (linksRCascade ?? []).map((l) => l.id as string),
        );
    }

    // Cancela realocações pendentes
    await supabase
      .from("siso_pedido_item_realocacoes")
      .update({ status: "cancelado" })
      .eq("pedido_item_id", item.id)
      .eq("status", "aguardando_picking");

    // Decrementa quantidade_pega via RPC atômica (pelo total efetivamente estornado).
    // Caminho legacy (sem links) zera direto via UPDATE.
    if (totalEstornado > 0) {
      await supabase.rpc("wms_acumular_qty_pega", {
        p_item_id: item.id,
        p_delta: -totalEstornado,
      });
    }
    if ((links ?? []).length === 0) {
      await supabase
        .from("siso_pedido_itens")
        .update({ quantidade_pega: null })
        .eq("id", item.id);
    }

    // Reseta campos do item (quantidade_pega já tratado acima)
    await supabase
      .from("siso_pedido_itens")
      .update({
        separacao_parcial: false,
        parcial_motivo: null,
        parcial_em: null,
        parcial_por: null,
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
