/**
 * POST /api/wms/full/[id]/itens — adiciona um item a um Full em separação.
 *
 * Insere o item com ordem_full no fim, reserva parcial (o que der) e, se o
 * pedido já estava `separado`, reabre pra `em_separacao` (agora há pendência).
 * Guard: Full não-fechado (senão 400). Ver src/lib/wms/full-editor.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { registrarEvento } from "@/lib/historico-service";
import {
  carregarFullEditavel,
  reservarParcialItem,
  reabrirSeSeparado,
  logEditor,
} from "@/lib/wms/full-editor";

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  if (!userCan(user, "separacao.executar")) {
    return NextResponse.json({ error: "sem permissão (separacao.executar)" }, { status: 403 });
  }

  const { id: pedidoId } = await ctx.params;
  const body = await request.json().catch(() => null);
  const produtoWms: string | undefined = body?.produto_id;
  const quantidade = Number(body?.quantidade);

  if (!produtoWms) return NextResponse.json({ error: "produto_id (uuid WMS) é obrigatório" }, { status: 400 });
  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    return NextResponse.json({ error: "quantidade inválida" }, { status: 400 });
  }

  const guard = await carregarFullEditavel(pedidoId);
  if (!guard.ok) return NextResponse.json({ error: guard.erro }, { status: guard.status });
  const pedido = guard.pedido;
  if (!pedido.empresa_origem_id || !pedido.separacao_galpao_id) {
    return NextResponse.json({ error: "pedido Full sem empresa/galpão" }, { status: 400 });
  }

  const sb = createServiceClient();

  // Resolve tiny_produto_id (coluna do item é o tiny id — gotcha #1) + display.
  const { data: mapeamento } = await sb
    .from("siso_produto_empresas")
    .select("tiny_produto_id")
    .eq("empresa_id", pedido.empresa_origem_id)
    .eq("produto_id", produtoWms)
    .maybeSingle();
  if (!mapeamento) {
    return NextResponse.json({ error: "produto não mapeado na conta ML do Full" }, { status: 400 });
  }
  const { data: prod } = await sb
    .from("siso_produtos")
    .select("sku, descricao, imagem_url")
    .eq("id", produtoWms)
    .maybeSingle();
  if (!prod) return NextResponse.json({ error: "produto não encontrado no catálogo" }, { status: 400 });

  // Bloqueia SKU duplicado (índice único pedido_id+produto_id; editar qty é a via).
  const { data: existente } = await sb
    .from("siso_pedido_itens")
    .select("id")
    .eq("pedido_id", pedidoId)
    .eq("produto_id", mapeamento.tiny_produto_id)
    .maybeSingle();
  if (existente) {
    return NextResponse.json(
      { error: "produto já está no pedido — edite a quantidade", item_id: existente.id },
      { status: 409 },
    );
  }

  // ordem_full no fim (max+1).
  const { data: ordens } = await sb
    .from("siso_pedido_itens")
    .select("ordem_full")
    .eq("pedido_id", pedidoId)
    .order("ordem_full", { ascending: false })
    .limit(1);
  const proximaOrdem = Number(ordens?.[0]?.ordem_full ?? 0) + 1;

  const { data: novoItem, error: insErr } = await sb
    .from("siso_pedido_itens")
    .insert({
      pedido_id: pedidoId,
      produto_id: mapeamento.tiny_produto_id,
      sku: prod.sku,
      descricao: prod.descricao,
      imagem_url: prod.imagem_url,
      quantidade_pedida: quantidade,
      ordem_full: proximaOrdem,
    })
    .select("id")
    .single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  // Reserva parcial. Se falhar, apaga o item recém-inserido (rollback da ação).
  let reservado = 0;
  try {
    const r = await reservarParcialItem({
      produtoWms,
      galpaoId: pedido.separacao_galpao_id,
      qty: quantidade,
      pedidoId,
      usuarioId: user.id,
    });
    reservado = r.reservado;
  } catch (err) {
    await sb.from("siso_pedido_itens").delete().eq("id", novoItem.id);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `falha reservando: ${msg}` }, { status: 409 });
  }

  await reabrirSeSeparado(pedido);

  logEditor("item adicionado", { pedidoId, item_id: novoItem.id, quantidade, reservado });
  registrarEvento({
    pedidoId,
    evento: "full_editado",
    usuarioId: user.id,
    usuarioNome: user.nome,
    detalhes: { acao: "add_item", produto_id: produtoWms, quantidade, reservado },
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    item_id: novoItem.id,
    ordem_full: proximaOrdem,
    quantidade,
    reservado,
    parcial: reservado < quantidade,
    reaberto: pedido.status_separacao === "separado",
  });
}
