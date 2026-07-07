/**
 * Editor de item da lane Full (FULL-06) — por item, atômico.
 *
 *  DELETE — remove o item. Se picado, desmarca (S→E devolve saldo) e libera as
 *           R antes de apagar a linha.
 *  PATCH {quantidade} — muda a qty pedida:
 *    · ↑            reserva o delta (parcial) e reabre se estava separado.
 *    · ↓ ≥ picado   libera as R e re-reserva (novaQty − picado); picks intactos.
 *    · ↓ < picado   desmarca tudo (devolve saldo), re-reserva novaQty, reabre.
 *
 * Guard: Full não-fechado. Ver src/lib/wms/full-editor.ts pra as primitivas.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { registrarEvento } from "@/lib/historico-service";
import { resolverProdutoWms } from "@/lib/separacao/wms-mapping";
import {
  carregarFullEditavel,
  reservarParcialItem,
  liberarTodasReservas,
  desmarcarItemFull,
  reabrirSeSeparado,
  alvoReservaProduto,
  logEditor,
  type PedidoFull,
} from "@/lib/wms/full-editor";

interface ItemRow {
  id: number;
  pedido_id: string;
  produto_id: number; // tiny_produto_id
  quantidade_pedida: number;
  quantidade_pega: number | null;
}

async function carregarItem(
  pedidoId: string,
  itemId: string,
): Promise<{ pedido: PedidoFull; item: ItemRow; produtoWms: string } | { erro: string; status: number }> {
  const guard = await carregarFullEditavel(pedidoId);
  if (!guard.ok) return { erro: guard.erro, status: guard.status };
  const pedido = guard.pedido;
  if (!pedido.empresa_origem_id || !pedido.separacao_galpao_id) {
    return { erro: "pedido Full sem empresa/galpão", status: 400 };
  }

  const sb = createServiceClient();
  const { data: item } = await sb
    .from("siso_pedido_itens")
    .select("id, pedido_id, produto_id, quantidade_pedida, quantidade_pega")
    .eq("id", Number(itemId))
    .eq("pedido_id", pedidoId)
    .maybeSingle();
  if (!item) return { erro: "item não encontrado no pedido", status: 404 };

  const produtoWms = await resolverProdutoWms(pedido.empresa_origem_id, String(item.produto_id));
  return { pedido, item: item as ItemRow, produtoWms };
}

// ── DELETE: remove item ──────────────────────────────────────────────────
export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; itemId: string }> },
) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  if (!userCan(user, "separacao.executar")) {
    return NextResponse.json({ error: "sem permissão (separacao.executar)" }, { status: 403 });
  }
  const { id: pedidoId, itemId } = await ctx.params;

  const loaded = await carregarItem(pedidoId, itemId);
  if ("erro" in loaded) return NextResponse.json({ error: loaded.erro }, { status: loaded.status });
  const { pedido, item, produtoWms } = loaded;

  const picado = Number(item.quantidade_pega ?? 0) > 0;

  try {
    // Picado: desmarca (S→E devolve o saldo + recria a R clampada) antes de liberar.
    if (picado) {
      await desmarcarItemFull({ itemId: item.id, pedidoId, usuarioId: user.id });
    }
    // Libera toda R viva (a do add/criar E a recriada pelo desmarcar).
    await liberarTodasReservas({
      pedidoId,
      produtoWms,
      galpaoId: pedido.separacao_galpao_id!,
      usuarioId: user.id,
    });
    // A R é por produto, não por linha (preservar_linhas): se OUTRAS linhas do
    // mesmo produto seguem no pedido, re-reserva o que ainda falta nelas.
    const alvoIrmas = await alvoReservaProduto({
      pedidoId,
      tinyProdutoId: item.produto_id,
      excluirItemId: item.id,
    });
    if (alvoIrmas > 0) {
      await reservarParcialItem({
        produtoWms,
        galpaoId: pedido.separacao_galpao_id!,
        qty: alvoIrmas,
        pedidoId,
        usuarioId: user.id,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `falha ao reconciliar estoque: ${msg}` }, { status: 409 });
  }

  const sb = createServiceClient();
  const { error: delErr } = await sb.from("siso_pedido_itens").delete().eq("id", item.id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  logEditor("item removido", { pedidoId, item_id: item.id, picado });
  registrarEvento({
    pedidoId,
    evento: "full_editado",
    usuarioId: user.id,
    usuarioNome: user.nome,
    detalhes: { acao: "remove_item", item_id: item.id, picado },
  }).catch(() => {});

  return NextResponse.json({ ok: true, item_id: item.id, picado });
}

// ── PATCH: muda a quantidade pedida ──────────────────────────────────────
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; itemId: string }> },
) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  if (!userCan(user, "separacao.executar")) {
    return NextResponse.json({ error: "sem permissão (separacao.executar)" }, { status: 403 });
  }
  const { id: pedidoId, itemId } = await ctx.params;
  const body = await request.json().catch(() => null);
  const novaQty = Number(body?.quantidade);
  if (!Number.isFinite(novaQty) || novaQty <= 0) {
    return NextResponse.json({ error: "quantidade inválida" }, { status: 400 });
  }

  const loaded = await carregarItem(pedidoId, itemId);
  if ("erro" in loaded) return NextResponse.json({ error: loaded.erro }, { status: loaded.status });
  const { pedido, item, produtoWms } = loaded;

  const oldQty = Number(item.quantidade_pedida);
  const picado = Number(item.quantidade_pega ?? 0);
  const galpaoId = pedido.separacao_galpao_id!;
  const sb = createServiceClient();

  if (novaQty === oldQty) {
    return NextResponse.json({ ok: true, quantidade: novaQty, sem_mudanca: true });
  }

  // Parcela das OUTRAS linhas do mesmo produto (preservar_linhas) — a R é por
  // produto, então toda re-reserva soma o que ainda falta nas irmãs.
  const alvoIrmas = await alvoReservaProduto({
    pedidoId,
    tinyProdutoId: item.produto_id,
    excluirItemId: item.id,
  });

  try {
    if (novaQty < picado) {
      // ↓ abaixo do picado: desmarca tudo (S→E devolve saldo, recria R), libera
      // as R e re-reserva novaQty (+ irmãs). Item perde os picks → reabre.
      await desmarcarItemFull({ itemId: item.id, pedidoId, usuarioId: user.id });
      await liberarTodasReservas({ pedidoId, produtoWms, galpaoId, usuarioId: user.id });
      await reservarParcialItem({ produtoWms, galpaoId, qty: novaQty + alvoIrmas, pedidoId, usuarioId: user.id });
      await sb
        .from("siso_pedido_itens")
        .update({
          quantidade_pedida: novaQty,
          quantidade_pega: null,
          separacao_marcado: false,
          mov_saida_id: null,
        })
        .eq("id", item.id);
      await reabrirSeSeparado(pedido);
    } else {
      // novaQty ≥ picado (↑ OU ↓ acima do picado): os picks ficam intactos (S não
      // se toca). A R é all-or-nothing por mov e reservarAtomico é idempotente por
      // tripla, então NÃO dá pra "somar" ao reservado — libera TODAS as R e
      // re-reserva o remanescente (novaQty − picado + irmãs) do zero.
      await liberarTodasReservas({ pedidoId, produtoWms, galpaoId, usuarioId: user.id });
      const alvoReserva = novaQty - picado;
      if (alvoReserva + alvoIrmas > 0) {
        await reservarParcialItem({
          produtoWms,
          galpaoId,
          qty: alvoReserva + alvoIrmas,
          pedidoId,
          usuarioId: user.id,
        });
      }
      await sb
        .from("siso_pedido_itens")
        .update({ quantidade_pedida: novaQty, separacao_marcado: alvoReserva === 0 })
        .eq("id", item.id);
      if (alvoReserva > 0) await reabrirSeSeparado(pedido);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `falha ao reconciliar estoque: ${msg}` }, { status: 409 });
  }

  logEditor("qty alterada", { pedidoId, item_id: item.id, de: oldQty, para: novaQty, picado });
  registrarEvento({
    pedidoId,
    evento: "full_editado",
    usuarioId: user.id,
    usuarioNome: user.nome,
    detalhes: { acao: "set_qty", item_id: item.id, de: oldQty, para: novaQty },
  }).catch(() => {});

  return NextResponse.json({ ok: true, item_id: item.id, quantidade: novaQty });
}
