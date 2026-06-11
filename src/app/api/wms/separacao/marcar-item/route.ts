import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import {
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
      const { data: links } = await supabase
        .from("siso_pedido_item_mov_links")
        .select("id, mov_id, tipo_link, qty")
        .eq("pedido_item_id", item.id)
        .in("tipo_link", ["saida", "liberacao_reserva"]);

      // P0-01: a S pode ser CONSOLIDADA de wave (1 mov S pra N itens; rateio
      // por item em link.qty). Estornar a mov inteira devolveria também a
      // fração dos outros itens (estoque fantasma). Passamos p_qty_link pra
      // RPC estornar SÓ a fração (acumula qty_estornada — mesmo padrão do
      // desfazer-parcial), idempotente por (mov S, pedido_item_id). Loop cobre
      // item com mais de uma S (parcial em progresso completada via checkbox);
      // L pareada por posição (ordem de criação dos links).
      const movsS = (links ?? [])
        .filter((l) => l.tipo_link === "saida")
        .sort((a, b) => Number(a.id) - Number(b.id));
      const movsL = (links ?? [])
        .filter((l) => l.tipo_link === "liberacao_reserva")
        .sort((a, b) => Number(a.id) - Number(b.id));

      if (movsS.length > 0) {
        for (let i = 0; i < movsS.length; i++) {
          const { error: rpcErr } = await supabase.rpc("wms_desmarcar_item_atomico", {
            p_mov_s_id: movsS[i].mov_id,
            p_mov_l_id: movsL[i]?.mov_id ?? null,
            p_pedido_id: String(pedido.id),
            p_usuario_id: session.id,
            p_motivo: `Desmarcar checkbox pedido #${pedido.numero}`,
            p_qty_link: Number(movsS[i].qty),
            p_pedido_item_id: Number(item.id),
          });
          if (rpcErr) {
            // Tudo-ou-nada por mov: a RPC rolou back. Estornos já feitos no
            // loop são idempotentes no retry (marker por item). Item permanece
            // marcado intacto.
            logger.warn("separacao-marcar-item", "Desmarcar atômico falhou — item NÃO desmarcado", {
              error: rpcErr.message, pedido_item_id, pedido_id: pedido.id, mov_s_id: movsS[i].mov_id,
            });
            return NextResponse.json(
              { error: "falha_desmarcar", message: rpcErr.message },
              { status: 409 },
            );
          }
        }
        await supabase
          .from("siso_pedido_item_mov_links")
          .delete()
          .in("id", (links ?? []).map((l) => l.id as string));
      } else if (item.mov_saida_id) {
        // Legacy fallback (item sem entrada na tabela ponte)
        const { error: rpcErr } = await supabase.rpc("wms_desmarcar_item_atomico", {
          p_mov_s_id: item.mov_saida_id, p_mov_l_id: null,
          p_pedido_id: String(pedido.id), p_usuario_id: session.id,
          p_motivo: "Desmarcar checkbox (legacy path)",
        });
        if (rpcErr) {
          return NextResponse.json({ error: "falha_desmarcar", message: rpcErr.message }, { status: 409 });
        }
      }

      const { data: updated, error: updErr } = await supabase
        .from("siso_pedido_itens")
        .update({ separacao_marcado: false, separacao_marcado_em: null, quantidade_pega: null, mov_saida_id: null })
        .eq("id", item.id).select().single();
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
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
