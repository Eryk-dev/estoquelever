import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import {
  buscarReservaPendentePorProduto,
  trocarReservaLocalizacaoAtomico,
} from "@/lib/wms/reservas-picking";
import { resolverProdutoEfetivoComAutoSync } from "@/lib/wms/sync-tiny";

/**
 * POST /api/wms/separacao/trocar-localizacao
 * Body: { pedido_item_id, localizacao_destino_id }
 *
 * Move a reserva R do pedido pra outra localização do mesmo galpão (atômico).
 * NÃO pica — só troca a posição reservada; o operador pica normal depois
 * (marcar-item acha a R na loc nova). Resolve o produto FÍSICO (substituto pós-
 * troca) e a R viva no servidor — a UI não precisa saber a loc atual da R.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const pedido_item_id = body?.pedido_item_id as number | string | undefined;
  const localizacao_destino_id = body?.localizacao_destino_id as string | undefined;
  if (!pedido_item_id || !localizacao_destino_id) {
    return NextResponse.json(
      { error: "'pedido_item_id' e 'localizacao_destino_id' obrigatórios" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  try {
    const { data: item, error: itemErr } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, produto_id, sku, separacao_parcial, produto_wms_substituto_id")
      .eq("id", pedido_item_id)
      .single();
    if (itemErr || !item) {
      return NextResponse.json({ error: "item não encontrado" }, { status: 404 });
    }
    // v1: só R única. Item em parcial pode ter R cascade em várias locs —
    // mover só a maior perderia as outras; trata-se via marcar-realocacao.
    if (item.separacao_parcial) {
      return NextResponse.json(
        {
          error: "item_em_parcial",
          message:
            "Item em separação parcial — não dá pra trocar a localização (separe ou desfaça o parcial primeiro).",
        },
        { status: 409 },
      );
    }

    const { data: pedido } = await supabase
      .from("siso_pedidos")
      .select("id, numero, empresa_origem_id, separacao_galpao_id, status_separacao")
      .eq("id", item.pedido_id)
      .single();
    if (!pedido) {
      return NextResponse.json({ error: "pedido não encontrado" }, { status: 404 });
    }
    const ALLOWED = [
      "em_separacao",
      "aguardando_separacao",
      "aguardando_compra",
      "pendente_realocacao",
    ];
    if (!ALLOWED.includes(pedido.status_separacao ?? "")) {
      return NextResponse.json(
        { error: `pedido status ${pedido.status_separacao} não permite trocar localização` },
        { status: 400 },
      );
    }

    const empresaOrigemId = pedido.empresa_origem_id as string | null;
    const galpaoId = pedido.separacao_galpao_id as string | null;
    if (!empresaOrigemId || !galpaoId) {
      return NextResponse.json({ error: "pedido sem empresa/galpão" }, { status: 400 });
    }

    // Loc destino tem que pertencer ao galpão do pedido.
    const { data: locChk } = await supabase
      .from("siso_localizacoes")
      .select("id, galpao_id")
      .eq("id", localizacao_destino_id)
      .maybeSingle();
    if (!locChk || (locChk as { galpao_id?: string }).galpao_id !== galpaoId) {
      return NextResponse.json(
        { error: "loc_invalida", message: "Localização não pertence ao galpão do pedido." },
        { status: 422 },
      );
    }

    // Troca de equivalência: resolve o produto FÍSICO (substituto quando aplicado).
    const produtoWmsId = await resolverProdutoEfetivoComAutoSync(empresaOrigemId, item);

    const reserva = await buscarReservaPendentePorProduto({
      pedido_id: String(pedido.id),
      produto_id: produtoWmsId,
      galpao_id: galpaoId,
    });
    if (!reserva) {
      return NextResponse.json(
        {
          error: "sem_reserva_viva",
          message: "Não há reserva pendente pra mover (item já picado ou sem reserva).",
        },
        { status: 409 },
      );
    }
    if (reserva.localizacao_id === localizacao_destino_id) {
      return NextResponse.json({ status: "sem_mudanca", reserva_id: reserva.id });
    }

    try {
      const res = await trocarReservaLocalizacaoAtomico({
        reserva_id: reserva.id,
        destino_localizacao_id: localizacao_destino_id,
        pedido_id: String(pedido.id),
        usuario_id: session.id,
        motivo: `Troca de localização pedido #${pedido.numero}`,
      });
      return NextResponse.json({
        status: "movido",
        reserva_id: res.reserva_nova_id,
        reserva_antiga_id: res.reserva_antiga_id,
        destino_localizacao_id: res.destino_localizacao_id,
        qty: res.qty,
      });
    } catch (rpcErr) {
      const msg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);
      if (msg.includes("RESERVA_JA_CONSUMIDA")) {
        return NextResponse.json(
          { error: "reserva_ja_consumida", message: "Item já foi picado/movido — atualize a tela." },
          { status: 409 },
        );
      }
      if (msg.includes("reserva excede saldo") || msg.includes("DESTINO_SEM_SALDO")) {
        return NextResponse.json(
          {
            error: "destino_sem_saldo",
            message: "A localização escolhida não tem saldo livre suficiente.",
          },
          { status: 409 },
        );
      }
      if (msg.includes("RESERVA_NAO_ENCONTRADA")) {
        return NextResponse.json(
          { error: "reserva_nao_encontrada", message: "Reserva não encontrada." },
          { status: 404 },
        );
      }
      logger.logError({
        error: rpcErr instanceof Error ? rpcErr : new Error(msg),
        source: "separacao-trocar-localizacao",
        message: "Falha ao trocar localização da reserva",
        category: "business_logic",
        requestPath: "/api/wms/separacao/trocar-localizacao",
        requestMethod: "POST",
        metadata: { pedido_item_id, localizacao_destino_id },
      });
      return NextResponse.json({ error: "falha_troca_localizacao", message: msg }, { status: 500 });
    }
  } catch (err) {
    const { id: erro_id, timestamp: erro_em } = logger.logError({
      error: err,
      source: "separacao-trocar-localizacao",
      message: "Erro inesperado",
      category: "unknown",
      requestPath: "/api/wms/separacao/trocar-localizacao",
      requestMethod: "POST",
      metadata: { pedido_item_id, localizacao_destino_id },
    });
    return NextResponse.json({ error: "erro interno", erro_id, erro_em }, { status: 500 });
  }
}
