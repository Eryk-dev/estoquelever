import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { inserirMovimentacao, estornarMovimentacao } from "@/lib/wms/ledger";
import {
  buscarReservaPendente,
  liberarReservaPicking,
  estornarLiberacaoReserva,
} from "@/lib/wms/reservas-picking";
import {
  resolverProdutoWms,
  resolverLocalizacaoWms,
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

  const { pedido_item_id, marcado } = body as {
    pedido_item_id: number | string;
    marcado: boolean;
  };

  const supabase = createServiceClient();

  try {
    const { data: item, error: itemErr } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, quantidade_pedida, separacao_parcial, mov_saida_id",
      )
      .eq("id", pedido_item_id)
      .single();
    if (itemErr || !item) {
      return NextResponse.json({ error: "item não encontrado" }, { status: 404 });
    }
    if (item.separacao_parcial) {
      return NextResponse.json(
        { error: "item está em parcial — use /desfazer-parcial antes" },
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
      let movSaidaId: string | null = null;
      let movLiberacaoId: string | null = null;
      let triplaProdutoWmsId: string | null = null;
      let triplaLocId: string | null = null;

      if (empresaOrigemId && galpaoId) {
        try {
          const produtoWmsId = await resolverProdutoWms(
            empresaOrigemId,
            String(item.produto_id),
          );
          const { data: estoque } = await supabase
            .from("siso_pedido_item_estoques")
            .select("localizacao")
            .eq("pedido_id", pedido.id)
            .eq("produto_id", item.produto_id)
            .eq("empresa_id", empresaOrigemId)
            .maybeSingle();
          const snapshotLoc = (estoque?.localizacao as string | null | undefined) ?? null;
          // Fallback live: se o snapshot está vazio (saldo era 0 no
          // webhook, ou loc nunca preenchida), escolhe a loc com maior
          // saldo do produto no galpão atual. Evita cair em DEFAULT-PICKING.
          let locId: string;
          if (snapshotLoc) {
            locId = await resolverLocalizacaoWms(galpaoId, snapshotLoc);
          } else {
            const liveLocId = await buscarLocComMaiorSaldoNoGalpao(galpaoId, produtoWmsId);
            locId = liveLocId ?? (await resolverLocalizacaoWms(galpaoId, null));
          }

          triplaProdutoWmsId = produtoWmsId;
          triplaLocId = locId;

          // R↔L↔S pairing: busca a R criada no aprovar pra essa tripla
          // e libera ela junto com a saída. Sem isso, a reserva fica
          // órfã e o cutover do concluir duplica a baixa.
          const reserva = await buscarReservaPendente({
            pedido_id: String(pedido.id),
            tripla: {
              produto_id: produtoWmsId,
              galpao_id: galpaoId,
              localizacao_id: locId,
            },
          });

          if (reserva) {
            const movL = await liberarReservaPicking({
              reserva,
              qty: item.quantidade_pedida,
              pedido_id: String(pedido.id),
              motivo: `Picking pedido #${pedido.numero} — libera reserva (checkbox)`,
              usuario_id: session.id,
              origem_detalhes: {
                pedido_numero: pedido.numero,
                pedido_item_id: item.id,
                sku: item.sku,
                contexto: "checkbox",
              },
            });
            movLiberacaoId = movL.id;
          } else {
            logger.warn("separacao-marcar-item", "R não encontrada — S sem L par", {
              pedido_item_id,
              pedido_id: pedido.id,
              tripla: { produto_id: produtoWmsId, galpao_id: galpaoId, localizacao_id: locId },
            });
          }

          const mov = await inserirMovimentacao({
            tripla: {
              produto_id: produtoWmsId,
              galpao_id: galpaoId,
              localizacao_id: locId,
            },
            tipo: "S",
            qty: item.quantidade_pedida,
            origem_tipo: "nf_venda",
            origem_detalhes: {
              pedido_id_tiny: pedido.id,
              pedido_numero: pedido.numero,
              pedido_item_id: item.id,
              sku: item.sku,
              contexto: "checkbox",
              reserva_origem: reserva?.id ?? null,
            },
            empresa_vendedora_id: empresaOrigemId,
            motivo: `Picking pedido #${pedido.numero} — checkbox completo`,
            usuario_id: session.id,
          });
          movSaidaId = mov.id;
        } catch (wmsErr) {
          logger.warn("separacao-marcar-item", "Mov WMS skipped", {
            error: wmsErr instanceof Error ? wmsErr.message : String(wmsErr),
            pedido_item_id,
          });
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
            qty: Number(item.quantidade_pedida),
            tipo_link: "liberacao_reserva",
          });
        }
        if (movSaidaId) {
          links.push({
            pedido_item_id: Number(item.id),
            realocacao_id: null,
            mov_id: movSaidaId,
            qty: Number(item.quantidade_pedida),
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

      void triplaProdutoWmsId;
      void triplaLocId;

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

      for (const link of links ?? []) {
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
    logger.logError({
      error: err,
      source: "separacao-marcar-item",
      message: "Erro inesperado",
      category: "unknown",
      requestPath: "/api/wms/separacao/marcar-item",
      requestMethod: "POST",
      metadata: { pedido_item_id, marcado },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
