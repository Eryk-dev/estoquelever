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
import { expandirItensVenda } from "@/lib/wms/kits";

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
  const preservarLinhas = pedido.payload_original?.preservar_linhas === true;

  // Kit desmembra em componentes (kit pai não tem saldo em siso_estoque; kit
  // sem composição mantém a linha — mesmo padrão do criar).
  const linhasAdd = await expandirItensVenda([{ produto_id: produtoWms, quantidade }]);
  const produtoIdsAdd = linhasAdd.map((l) => l.produto_id);

  // Resolve tiny_produto_id (coluna do item é o tiny id — gotcha #1) + display.
  const { data: mapeamentos } = await sb
    .from("siso_produto_empresas")
    .select("produto_id, tiny_produto_id")
    .eq("empresa_id", pedido.empresa_origem_id)
    .in("produto_id", produtoIdsAdd);
  const tinyPorProduto = new Map(
    (mapeamentos ?? []).map((m) => [String(m.produto_id), Number(m.tiny_produto_id)]),
  );
  const { data: prods } = await sb
    .from("siso_produtos")
    .select("id, sku, descricao, imagem_url")
    .in("id", produtoIdsAdd);
  const prodPorId = new Map((prods ?? []).map((p) => [String(p.id), p]));

  for (const l of linhasAdd) {
    if (!prodPorId.get(l.produto_id)) {
      return NextResponse.json({ error: "produto não encontrado no catálogo" }, { status: 400 });
    }
    if (!tinyPorProduto.get(l.produto_id)) {
      const sku = prodPorId.get(l.produto_id)?.sku;
      return NextResponse.json(
        { error: `produto ${sku ?? l.produto_id} não mapeado na conta ML do Full` },
        { status: 400 },
      );
    }
  }

  // Linhas existentes dos mesmos produtos: sem preservar_linhas, duplicata é
  // bloqueada (editar qty é a via); com, o add vira linha nova (linha=max+1).
  const tinyIdsAdd = linhasAdd.map((l) => tinyPorProduto.get(l.produto_id)!);
  const { data: existentes } = await sb
    .from("siso_pedido_itens")
    .select("id, produto_id, linha")
    .eq("pedido_id", pedidoId)
    .in("produto_id", tinyIdsAdd);
  const existentesPorTiny = new Map<number, { id: number; linhaMax: number }>();
  for (const e of existentes ?? []) {
    const tiny = Number(e.produto_id);
    const prev = existentesPorTiny.get(tiny);
    existentesPorTiny.set(tiny, {
      id: prev ? Math.min(prev.id, Number(e.id)) : Number(e.id),
      linhaMax: Math.max(prev?.linhaMax ?? 0, Number(e.linha ?? 1)),
    });
  }
  if (!preservarLinhas) {
    for (const l of linhasAdd) {
      const dup = existentesPorTiny.get(tinyPorProduto.get(l.produto_id)!);
      if (dup) {
        const sku = prodPorId.get(l.produto_id)?.sku;
        return NextResponse.json(
          { error: `produto ${sku ?? ""} já está no pedido — edite a quantidade`, item_id: dup.id },
          { status: 409 },
        );
      }
    }
  }

  // ordem_full no fim (max+1).
  const { data: ordens } = await sb
    .from("siso_pedido_itens")
    .select("ordem_full")
    .eq("pedido_id", pedidoId)
    .order("ordem_full", { ascending: false })
    .limit(1);
  const primeiraOrdem = Number(ordens?.[0]?.ordem_full ?? 0) + 1;

  const linhaPorTiny = new Map<number, number>();
  const rows = linhasAdd.map((l, idx) => {
    const tiny = tinyPorProduto.get(l.produto_id)!;
    const prod = prodPorId.get(l.produto_id)!;
    const linha =
      (linhaPorTiny.get(tiny) ?? existentesPorTiny.get(tiny)?.linhaMax ?? 0) + 1;
    linhaPorTiny.set(tiny, linha);
    return {
      pedido_id: pedidoId,
      produto_id: tiny,
      sku: prod.sku,
      descricao: prod.descricao,
      imagem_url: prod.imagem_url,
      quantidade_pedida: l.quantidade,
      ordem_full: primeiraOrdem + idx,
      linha,
    };
  });

  const { data: novosItens, error: insErr } = await sb
    .from("siso_pedido_itens")
    .insert(rows)
    .select("id");
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  const novosIds = (novosItens ?? []).map((i) => Number(i.id));

  // Reserva parcial por produto (kit expandido = vários; agrega duplicatas).
  // Se falhar, apaga os itens recém-inseridos (rollback da ação).
  let reservado = 0;
  const qtyPorProduto = new Map<string, number>();
  for (const l of linhasAdd) {
    qtyPorProduto.set(l.produto_id, (qtyPorProduto.get(l.produto_id) ?? 0) + l.quantidade);
  }
  try {
    for (const [prodId, qty] of qtyPorProduto) {
      const r = await reservarParcialItem({
        produtoWms: prodId,
        galpaoId: pedido.separacao_galpao_id,
        qty,
        pedidoId,
        usuarioId: user.id,
      });
      reservado += r.reservado;
    }
  } catch (err) {
    await sb.from("siso_pedido_itens").delete().in("id", novosIds);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `falha reservando: ${msg}` }, { status: 409 });
  }

  await reabrirSeSeparado(pedido);

  const qtyTotal = linhasAdd.reduce((s, l) => s + l.quantidade, 0);
  logEditor("item adicionado", {
    pedidoId,
    item_ids: novosIds,
    quantidade: qtyTotal,
    reservado,
    expandido_kit: linhasAdd.length > 1 || linhasAdd[0]?.produto_id !== produtoWms,
  });
  registrarEvento({
    pedidoId,
    evento: "full_editado",
    usuarioId: user.id,
    usuarioNome: user.nome,
    detalhes: { acao: "add_item", produto_id: produtoWms, quantidade, reservado, item_ids: novosIds },
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    item_id: novosIds[0],
    item_ids: novosIds,
    ordem_full: primeiraOrdem,
    quantidade: qtyTotal,
    reservado,
    parcial: reservado < qtyTotal,
    reaberto: pedido.status_separacao === "separado",
  });
}
