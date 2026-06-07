import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { estornarMovimentacao } from "@/lib/wms/ledger";
import {
  estornarLiberacaoReserva,
  buscarReservaPendentePorProduto,
  pickItemAtomico,
} from "@/lib/wms/reservas-picking";
import {
  resolverProdutoWms,
  buscarLocComMaiorSaldoNoGalpao,
} from "@/lib/separacao/wms-mapping";

/**
 * POST /api/separacao/marcar-item
 * Body: { pedido_item_id, marcado: boolean }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body?.pedido_item_id || typeof body.marcado !== "boolean") {
    return NextResponse.json(
      { error: "'pedido_item_id' e 'marcado' obrigatórios" },
      { status: 400 },
    );
  }

  const { pedido_item_id, marcado, idempotency_key } = body as {
    pedido_item_id: number | string;
    marcado: boolean;
    idempotency_key?: string;
  };

  const supabase = createServiceClient();

  try {
    const { data: item, error: itemErr } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, quantidade_pedida, quantidade_pega, separacao_parcial, mov_saida_id",
      )
      .eq("id", pedido_item_id)
      .single();
    if (itemErr || !item) {
      return NextResponse.json({ error: "item não encontrado" }, { status: 404 });
    }
    if (item.separacao_parcial) {
      return NextResponse.json(
        {
          error:
            "item está em parcial — cancele a separação inteira (checklist) ou peça pro supervisor desfazer o parcial",
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
    const ALLOWED = ["em_separacao", "aguardando_separacao", "aguardando_compra", "pendente_realocacao"];
    if (!ALLOWED.includes(pedido.status_separacao ?? "")) {
      return NextResponse.json(
        { error: `pedido status ${pedido.status_separacao} não permite marcar` },
        { status: 400 },
      );
    }

    const empresaOrigemId = pedido.empresa_origem_id as string | null;
    const galpaoId = pedido.separacao_galpao_id as string | null;
    const nowIso = new Date().toISOString();

    if (marcado) {
      // Item "em progresso" — já teve parcial sem loc_zerou anteriormente.
      // quantidade_pega tem o qty já pego. Completar via checkbox só desconta
      // o RESTANTE (qty_pedida - qty_pega). Se qty_pega === qty_pedida, item já
      // está 100% pego — checkbox só marca como complete sem nova mov.
      const qtyJaPega = Number(item.quantidade_pega ?? 0);
      const qtyADescontar = Number(item.quantidade_pedida) - qtyJaPega;

      let movSaidaId: string | null = null;
      let movLiberacaoId: string | null = null;

      if (qtyADescontar > 0) {
        // Sem empresa/galpão não há como dar baixa — fail-loud, NÃO marca.
        // (antes: pulava silenciosamente e marcava sem baixa → overselling).
        if (!empresaOrigemId || !galpaoId) {
          return NextResponse.json(
            { error: "pedido sem empresa/galpão — não é possível dar baixa no estoque" },
            { status: 400 },
          );
        }

        const produtoWmsId = await resolverProdutoWms(
          empresaOrigemId,
          String(item.produto_id),
        );

        // Loc do pick vem da R VIVA do pedido (posição reservada por aprovar),
        // não de snapshot/heurística — a R é a fonte de verdade da loc.
        const reserva = await buscarReservaPendentePorProduto({
          pedido_id: String(pedido.id),
          produto_id: produtoWmsId,
          galpao_id: galpaoId,
        });

        let locId: string;
        let reservaId: string | null;
        if (reserva) {
          locId = reserva.localizacao_id;
          reservaId = reserva.id;
        } else {
          // Sem R viva (ex.: completar parcial-em-progresso cuja R já foi
          // liberada, ou item OC). Baixa na loc com saldo disponível vivo.
          const liveLocId = await buscarLocComMaiorSaldoNoGalpao(galpaoId, produtoWmsId);
          if (!liveLocId) {
            return NextResponse.json(
              {
                error: "sem_saldo_para_baixa",
                message: "Sem saldo disponível pra dar baixa neste produto no galpão.",
              },
              { status: 409 },
            );
          }
          locId = liveLocId;
          reservaId = null;
        }

        // Baixa ATÔMICA (L+S numa transação via RPC). Se falhar → NÃO marca o
        // item: o operador vê o erro em vez de seguir com saldo fantasma.
        try {
          const pick = await pickItemAtomico({
            reserva_id: reservaId,
            tripla: {
              produto_id: produtoWmsId,
              galpao_id: galpaoId,
              localizacao_id: locId,
            },
            qty: qtyADescontar,
            pedido_id: String(pedido.id),
            empresa_vendedora_id: empresaOrigemId,
            usuario_id: session.id,
            // ÚNICA linha nova (P072): token só no ramo sem-reserva.
            idempotency_key: reservaId ? undefined : idempotency_key,
            origem_detalhes: {
              pedido_id_tiny: pedido.id,
              pedido_numero: pedido.numero,
              pedido_item_id: item.id,
              sku: item.sku,
              contexto: qtyJaPega > 0 ? "checkbox_completa_parcial" : "checkbox",
              qty_ja_pega: qtyJaPega,
            },
            motivo:
              qtyJaPega > 0
                ? `Picking pedido #${pedido.numero} — completa parcial (${qtyADescontar}+${qtyJaPega})`
                : `Picking pedido #${pedido.numero} — checkbox completo`,
          });
          movSaidaId = pick.mov_s_id;
          movLiberacaoId = pick.mov_l_id;
        } catch (pickErr) {
          const msg = pickErr instanceof Error ? pickErr.message : String(pickErr);
          logger.warn("separacao-marcar-item", "Baixa atômica falhou — item NÃO marcado", {
            error: msg,
            pedido_item_id,
            pedido_id: pedido.id,
            reserva_id: reservaId,
          });
          return NextResponse.json(
            { error: "falha_baixa_estoque", message: msg },
            { status: 409 },
          );
        }
      }

      // Tabela ponte: registra L (liberacao_reserva) + S (saida) pareados.
      // desfazer-parcial / cancelar usam essas linhas pra estornar tudo.
      if (movSaidaId || movLiberacaoId) {
        const links: Array<{
          pedido_item_id: number;
          realocacao_id: null;
          mov_id: string;
          qty: number;
          tipo_link: "saida" | "liberacao_reserva";
        }> = [];
        if (movLiberacaoId) {
          links.push({
            pedido_item_id: Number(item.id),
            realocacao_id: null,
            mov_id: movLiberacaoId,
            qty: qtyADescontar,
            tipo_link: "liberacao_reserva",
          });
        }
        if (movSaidaId) {
          links.push({
            pedido_item_id: Number(item.id),
            realocacao_id: null,
            mov_id: movSaidaId,
            qty: qtyADescontar,
            tipo_link: "saida",
          });
        }
        const { error: linkErr } = await supabase
          .from("siso_pedido_item_mov_links")
          .insert(links);
        if (linkErr) {
          logger.warn("separacao-marcar-item", "Falhou criar links (continua)", {
            error: linkErr.message,
            pedido_item_id,
          });
        }
      }

      const { data: updated, error: updErr } = await supabase
        .from("siso_pedido_itens")
        .update({
          separacao_marcado: true,
          separacao_marcado_em: nowIso,
          quantidade_pega: item.quantidade_pedida,
          mov_saida_id: movSaidaId,
        })
        .eq("id", item.id)
        .select()
        .single();
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 500 });
      }
      return NextResponse.json(updated);
    } else {
      // Desmarcar: estorna S e L pareados via tabela ponte.
      // - Estornar S cria E counter → saldo volta
      // - Estornar L cria R nova → reservado volta
      const { data: links } = await supabase
        .from("siso_pedido_item_mov_links")
        .select("id, mov_id, tipo_link")
        .eq("pedido_item_id", item.id)
        .in("tipo_link", ["saida", "liberacao_reserva"]);

      // P3 #2.7 — estorna S (saida) ANTES de L (liberacao_reserva).
      // Estornar S cria E → saldo += qty; estornar L cria R → reservado += qty.
      // Estado pós-picking: saldo=N-q, reservado=N-q.
      // Se L é estornado primeiro: reservado sobe pra N antes do saldo, mid-state
      // viola invariante I2 (reservado > saldo). Estornar S primeiro recupera o
      // saldo, depois L recupera o reservado — invariante preservado a cada passo.
      const sortedLinks = [...(links ?? [])].sort((a, b) => {
        if (a.tipo_link === "saida" && b.tipo_link !== "saida") return -1;
        if (a.tipo_link !== "saida" && b.tipo_link === "saida") return 1;
        return 0;
      });

      for (const link of sortedLinks) {
        try {
          if (link.tipo_link === "liberacao_reserva") {
            // L de liberação não pode ir pelo estornarMovimentacao genérico —
            // a guarda confunde com estorno contábil. Helper específico cria
            // uma R nova com origem_tipo='reserva_pedido' pra re-marcação
            // subsequente conseguir encontrar via buscarReservaPendente.
            await estornarLiberacaoReserva({
              liberacao_mov_id: link.mov_id as string,
              pedido_id: String(pedido.id),
              usuario_id: session.id,
              motivo: `Desmarcar checkbox — ressuscita reserva pedido #${pedido.numero}`,
            });
          } else {
            await estornarMovimentacao({
              mov_id: link.mov_id as string,
              usuario_id: session.id,
              motivo: `Desmarcar checkbox (${link.tipo_link})`,
            });
          }
        } catch (estornoErr) {
          // PostgrestError não estende Error — vira "[object Object]" em String().
          // Extraímos .message do objeto pra ter erro real no log.
          const errMsg =
            estornoErr instanceof Error
              ? estornoErr.message
              : typeof estornoErr === "object" && estornoErr !== null && "message" in estornoErr
                ? String((estornoErr as { message: unknown }).message)
                : String(estornoErr);
          logger.warn("separacao-marcar-item", "Estorno WMS falhou", {
            error: errMsg,
            mov_id: link.mov_id,
            tipo_link: link.tipo_link,
          });
        }
      }
      if ((links?.length ?? 0) > 0) {
        await supabase
          .from("siso_pedido_item_mov_links")
          .delete()
          .in(
            "id",
            (links ?? []).map((l) => l.id as string),
          );
      } else if (item.mov_saida_id) {
        // Legacy fallback: items pré-fix sem entrada na tabela ponte
        try {
          await estornarMovimentacao({
            mov_id: item.mov_saida_id,
            usuario_id: session.id,
            motivo: "Desmarcar checkbox (legacy path)",
          });
        } catch (estornoErr) {
          logger.warn("separacao-marcar-item", "Estorno legacy falhou", {
            error: estornoErr instanceof Error ? estornoErr.message : String(estornoErr),
            mov_id: item.mov_saida_id,
          });
        }
      }
      const { data: updated, error: updErr } = await supabase
        .from("siso_pedido_itens")
        .update({
          separacao_marcado: false,
          separacao_marcado_em: null,
          quantidade_pega: null,
          mov_saida_id: null,
        })
        .eq("id", item.id)
        .select()
        .single();
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 500 });
      }
      return NextResponse.json(updated);
    }
  } catch (err) {
    const { id: erro_id, timestamp: erro_em } = logger.logError({
      error: err,
      source: "separacao-marcar-item",
      message: "Erro inesperado",
      category: "unknown",
      requestPath: "/api/wms/separacao/marcar-item",
      requestMethod: "POST",
      metadata: { pedido_item_id, marcado },
    });
    return NextResponse.json({ error: "erro interno", erro_id, erro_em }, { status: 500 });
  }
}
