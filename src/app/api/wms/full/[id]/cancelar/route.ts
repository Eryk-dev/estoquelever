/**
 * POST /api/wms/full/[id]/cancelar — cancela um pedido Full (FULL-08, P2).
 *
 * Reusa o caminho de reconciliação do editor: para cada item picado, desmarca
 * (S→E devolve o saldo); libera todas as R vivas; marca o pedido cancelado
 * (status='cancelado', status_separacao=null) gravando origem/motivo/cancelado_em.
 * Os itens FICAM (histórico). Aparece na aba Cancelados da Separação Full.
 *
 * Guard: Full não-fechado (um Full despachado precisa ser reaberto antes).
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { registrarEvento } from "@/lib/historico-service";
import { camposCancelamento } from "@/lib/wms/cancelamento-fields";
import { resolverProdutoWms } from "@/lib/separacao/wms-mapping";
import {
  carregarFullEditavel,
  desmarcarItemFull,
  liberarTodasReservas,
} from "@/lib/wms/full-editor";

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  if (!userCan(user, "separacao.executar")) {
    return NextResponse.json({ error: "sem permissão (separacao.executar)" }, { status: 403 });
  }
  const { id: pedidoId } = await ctx.params;
  const body = await request.json().catch(() => null);
  const motivo: string | null = body?.motivo ?? null;

  const guard = await carregarFullEditavel(pedidoId);
  if (!guard.ok) return NextResponse.json({ error: guard.erro }, { status: guard.status });
  const pedido = guard.pedido;
  if (!pedido.empresa_origem_id || !pedido.separacao_galpao_id) {
    return NextResponse.json({ error: "pedido Full sem empresa/galpão" }, { status: 400 });
  }

  const sb = createServiceClient();
  const { data: itens } = await sb
    .from("siso_pedido_itens")
    .select("id, produto_id, quantidade_pega")
    .eq("pedido_id", pedidoId);

  try {
    for (const item of itens ?? []) {
      const produtoWms = await resolverProdutoWms(pedido.empresa_origem_id, String(item.produto_id));
      if (Number(item.quantidade_pega ?? 0) > 0) {
        await desmarcarItemFull({ itemId: item.id as number, pedidoId, usuarioId: user.id });
      }
      await liberarTodasReservas({
        pedidoId,
        produtoWms,
        galpaoId: pedido.separacao_galpao_id,
        usuarioId: user.id,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `falha ao reconciliar estoque: ${msg}` }, { status: 409 });
  }

  // Zera os picks nos itens (estornados acima) e marca o pedido cancelado.
  await sb
    .from("siso_pedido_itens")
    .update({ separacao_marcado: false, quantidade_pega: null, mov_saida_id: null })
    .eq("pedido_id", pedidoId);

  const { error: updErr } = await sb
    .from("siso_pedidos")
    .update({
      status: "cancelado",
      status_separacao: null,
      ...camposCancelamento("operador", motivo),
    })
    .eq("id", pedidoId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  registrarEvento({
    pedidoId,
    evento: "full_editado",
    usuarioId: user.id,
    usuarioNome: user.nome,
    detalhes: { acao: "cancelar", motivo },
  }).catch(() => {});

  return NextResponse.json({ ok: true, pedido_id: pedidoId, status: "cancelado" });
}
