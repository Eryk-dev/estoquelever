import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ sku: string; skuAlvo: string }>;
}

/**
 * DELETE /api/cross/produtos/:sku/links/:skuAlvo
 *
 * Remove o link entre 2 SKUs. Permissão:
 *  - admin pode remover qualquer link
 *  - demais cargos só removem o que cadastraram
 *
 * Como o par é armazenado ordenado, normaliza antes de procurar.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { sku: skuRaw, skuAlvo: skuAlvoRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();
  const skuAlvo = decodeURIComponent(skuAlvoRaw).trim();
  // proxy admin-equivalent: só admin tem sistema.usuarios.
  // Operadores podem remover links próprios; só admin remove os de outros.
  const isAdmin = userCan(session, "sistema.usuarios");

  if (!sku || !skuAlvo) {
    return NextResponse.json({ error: "SKU obrigatório" }, { status: 400 });
  }

  const [sku_a, sku_b] = sku < skuAlvo ? [sku, skuAlvo] : [skuAlvo, sku];

  const supabase = createServiceClient();

  const { data: link } = await supabase
    .from("siso_produto_links")
    .select("id, adicionado_por")
    .eq("sku_a", sku_a)
    .eq("sku_b", sku_b)
    .maybeSingle();

  if (!link) {
    return NextResponse.json({ error: "Link não encontrado" }, { status: 404 });
  }

  const podeRemover = isAdmin || link.adicionado_por === session.id;
  if (!podeRemover) {
    return NextResponse.json(
      { error: "Você só pode remover links que você cadastrou" },
      { status: 403 },
    );
  }

  const { error: delErr } = await supabase
    .from("siso_produto_links")
    .delete()
    .eq("id", link.id);

  if (delErr) {
    logger.error("cross-link-del", "Erro ao remover link", {
      sku_a,
      sku_b,
      error: delErr.message,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }

  logger.info("cross-link-del", "Link removido", {
    usuario: session.id,
    sku_a,
    sku_b,
  });
  return NextResponse.json({ ok: true });
}
