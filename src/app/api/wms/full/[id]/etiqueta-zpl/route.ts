import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { reordenarZplFullPorLocalizacao } from "@/lib/wms/full-zpl";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "separacao.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  if (!session.galpaoPodeEditar) {
    return NextResponse.json({ error: "Galpão disponível somente para visualização" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (body?.confirmar_mesma_ordem !== true) {
    return NextResponse.json(
      { error: "Confirme explicitamente que a lista e as etiquetas estão na mesma ordem" },
      { status: 400 },
    );
  }
  if (typeof body?.zpl !== "string" || body.zpl.length === 0 || body.zpl.length > 5_000_000) {
    return NextResponse.json({ error: "Arquivo ZPL inválido ou maior que 5 MB" }, { status: 400 });
  }
  try {
    const sb = createServiceClient();
    const { data: pedido, error: pedidoError } = await sb
      .from("siso_pedidos")
      .select("id, separacao_full, separacao_galpao_id")
      .eq("id", id)
      .maybeSingle();
    if (pedidoError) throw pedidoError;
    if (!pedido?.separacao_full) {
      return NextResponse.json({ error: "Envio Full não encontrado" }, { status: 404 });
    }
    if (session.galpaoId && session.galpaoId !== pedido.separacao_galpao_id) {
      return NextResponse.json({ error: "Galpão não autorizado" }, { status: 403 });
    }
    const { data: itens, error: itensError } = await sb
      .from("siso_pedido_itens")
      .select("sku, quantidade_pedida, ordem_full")
      .eq("pedido_id", id)
      .order("ordem_full", { ascending: true });
    if (itensError) throw itensError;
    const skus = [...new Set((itens ?? []).map((item) => item.sku).filter(Boolean))];
    const { data: produtos, error: produtosError } = await sb
      .from("siso_produtos")
      .select("id, sku")
      .in("sku", skus);
    if (produtosError) throw produtosError;
    const produtoPorSku = new Map((produtos ?? []).map((p) => [p.sku, p.id]));
    const produtoIds = [...produtoPorSku.values()];
    const { data: estoques, error: estoquesError } = produtoIds.length
      ? await sb
          .from("siso_estoque")
          .select("produto_id, saldo, localizacao:siso_localizacoes!inner(codigo, tipo)")
          .in("produto_id", produtoIds)
          .eq("galpao_id", pedido.separacao_galpao_id)
      : { data: [], error: null };
    if (estoquesError) throw estoquesError;
    const locPorProduto = new Map<string, string>();
    for (const row of estoques ?? []) {
      const loc = Array.isArray(row.localizacao) ? row.localizacao[0] : row.localizacao;
      const codigo = loc?.codigo;
      if (!codigo) continue;
      const atual = locPorProduto.get(row.produto_id);
      if (!atual || codigo.localeCompare(atual, "pt-BR", { numeric: true }) < 0) {
        locPorProduto.set(row.produto_id, codigo);
      }
    }
    const result = reordenarZplFullPorLocalizacao(body.zpl, (itens ?? []).map((item, index) => {
      const produtoId = produtoPorSku.get(item.sku);
      return {
        sku: item.sku,
        quantidade: Number(item.quantidade_pedida),
        ordem: Number(item.ordem_full ?? index + 1),
        localizacao: produtoId ? locPorProduto.get(produtoId) ?? null : null,
      };
    }));
    const { error: updateError } = await sb
      .from("siso_pedidos")
      .update({
        full_etiqueta_zpl_original: body.zpl,
        full_etiqueta_zpl_ordenada: result.zpl,
        full_etiqueta_total: result.total,
        full_etiqueta_anexada_em: new Date().toISOString(),
        full_etiqueta_anexada_por: session.id,
      })
      .eq("id", id);
    if (updateError) throw updateError;
    return NextResponse.json({ ok: true, total: result.total, zpl: result.zpl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/contém \d+ etiquetas/.test(message)) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return wmsErrorResponse({
      source: "wms.full.etiqueta-zpl",
      error,
      requestPath: `/api/wms/full/${id}/etiqueta-zpl`,
      requestMethod: "POST",
    });
  }
}
